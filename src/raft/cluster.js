// Wires nodes, the network and a client workload into one deterministic run.
//
// The output is a history in exactly the shape the checker consumes, plus the
// bits the demo needs to draw a space-time diagram. Everything -- election
// timeouts, message delays, which key a client touches, how long it thinks
// between operations -- comes from one seeded Rng, so `runSimulation({seed})`
// is a pure function.
//
// Client modelling follows Jepsen's, and the reason matters. When a client
// times out it does NOT get a response recorded at the timeout: the operation
// stays pending and its response is appended at the end of the history. An
// operation whose outcome the client never learned may take effect at any later
// point, and recording a response early would make a CORRECT system look
// non-linearizable. The client process is then retired and replaced by a fresh
// process id, which is what Jepsen does too.

import { Scheduler } from '../sim/scheduler.js';
import { Rng } from '../sim/rng.js';
import { Network, parseFaultScript } from '../sim/network.js';
import { RaftNode } from './node.js';
import { correctBuild } from '../bugs.js';

export const DEFAULTS = {
  nodes: 5,
  clients: 4,
  operations: 40,
  keys: 1,
  maxTicks: 40000,
  clientTimeout: 300,
  readFraction: 0.5,
  thinkMin: 10,
  thinkMax: 40,
  maxEntriesPerAppend: 8,
};

/**
 * @typedef {object} SimResult
 * @property {import('../lin/history.js').Operation[]} history
 * @property {object} config
 * @property {object} stats
 * @property {Array<{tick:number, node:number, term:number}>} leaders
 * @property {Array<{kind:string, start:number, end:number, group:number[], spec:string}>} faults
 */

/**
 * @param {object} opts
 * @param {number} opts.seed
 * @param {number} [opts.nodes]
 * @param {number} [opts.clients]
 * @param {number} [opts.operations]
 * @param {number} [opts.keys]
 * @param {number} [opts.maxTicks]
 * @param {number} [opts.clientTimeout]
 * @param {string} [opts.faults] fault script, see src/sim/network.js
 * @param {number} [opts.maxEntriesPerAppend] log entries per AppendEntries message
 * @param {import('../bugs.js').BuildFlags} [opts.flags]
 * @returns {SimResult}
 */
export function runSimulation(opts) {
  if (!Number.isInteger(opts.seed)) {
    throw new TypeError('runSimulation: seed must be an integer, got ' + String(opts.seed));
  }
  const cfg = {
    seed: opts.seed,
    nodes: opts.nodes === undefined ? DEFAULTS.nodes : opts.nodes,
    clients: opts.clients === undefined ? DEFAULTS.clients : opts.clients,
    operations: opts.operations === undefined ? DEFAULTS.operations : opts.operations,
    keys: opts.keys === undefined ? DEFAULTS.keys : opts.keys,
    maxTicks: opts.maxTicks === undefined ? DEFAULTS.maxTicks : opts.maxTicks,
    clientTimeout: opts.clientTimeout === undefined ? DEFAULTS.clientTimeout : opts.clientTimeout,
    faults: opts.faults === undefined ? '' : opts.faults,
    maxEntriesPerAppend:
      opts.maxEntriesPerAppend === undefined ? DEFAULTS.maxEntriesPerAppend : opts.maxEntriesPerAppend,
  };
  if (cfg.nodes < 1 || cfg.nodes % 2 === 0) {
    throw new RangeError('runSimulation: nodes must be an odd number >= 1, got ' + cfg.nodes);
  }
  if (cfg.clients < 1) throw new RangeError('runSimulation: clients must be >= 1');
  if (cfg.operations < 1) throw new RangeError('runSimulation: operations must be >= 1');

  const flags = opts.flags || correctBuild();
  const faults = parseFaultScript(cfg.faults);

  const sched = new Scheduler();
  const rootRng = new Rng(cfg.seed);
  const netRng = rootRng.fork();
  const workloadRng = rootRng.fork();

  /** @type {RaftNode[]} */
  const nodes = [];

  const net = new Network({
    sched,
    rng: netRng,
    faults,
    // Resolves the `L` fault target. Lowest id wins if the cluster has somehow
    // elected two leaders, which the minority-election fixture makes possible.
    leaderLookup: () => {
      for (const n of nodes) if (n.role === 'leader') return n.id;
      return null;
    },
  });

  /** @type {number[]} */
  const peers = [];
  for (let i = 0; i < cfg.nodes; i++) peers.push(i);

  for (let i = 0; i < cfg.nodes; i++) {
    const nodeRng = rootRng.fork();
    nodes.push(
      new RaftNode({
        id: i,
        peers,
        sched,
        rng: nodeRng,
        flags,
        send: (to, msg) => net.send(i, to, msg),
        isDown: () => net.isDown(i),
        timing: { maxEntriesPerAppend: cfg.maxEntriesPerAppend },
      })
    );
  }
  net.deliver = (from, to, msg) => nodes[to].onMessage(from, msg);

  /** @type {Array<{tick:number, node:number, term:number}>} */
  const leaders = [];
  /** @type {Map<number, string>} */
  const lastRole = new Map();
  let drainUntil = -1;

  // ---- history recording ----------------------------------------------------
  let position = 0;
  let opId = 0;
  /** @type {any[]} */
  const history = [];

  /** @type {Array<{clientId:number, slot:number, op:any}>} */
  const openOps = [];

  const keyNames = [];
  for (let k = 0; k < cfg.keys; k++) keyNames.push(String.fromCharCode(120 + (k % 6)) + (k >= 6 ? String(k) : ''));

  let putCounter = 0;
  let nextClientId = cfg.clients;
  let started = 0;
  let completed = 0;

  /** @type {number[]} */
  const slotClientId = [];
  for (let s = 0; s < cfg.clients; s++) slotClientId.push(s);

  sched.on('client.think', (payload) => {
    const p = /** @type {{slot:number}} */ (payload);
    startOperation(p.slot);
  });
  sched.on('client.retry', (payload) => {
    const p = /** @type {{slot:number, opIndex:number, target:number}} */ (payload);
    attempt(p.slot, p.opIndex, p.target);
  });
  sched.on('client.timeout', (payload) => {
    const p = /** @type {{slot:number, opIndex:number}} */ (payload);
    const rec = openOps[p.opIndex];
    if (!rec || rec.op.ret !== -1 || rec.op.abandoned) return;
    // Retire the process. The operation stays pending; its response is appended
    // at the end of the history in finish().
    rec.op.abandoned = true;
    slotClientId[p.slot] = nextClientId++;
    scheduleThink(p.slot);
  });

  /** @param {number} slot */
  function scheduleThink(slot) {
    if (started >= cfg.operations) return;
    sched.after(workloadRng.int(DEFAULTS.thinkMin, DEFAULTS.thinkMax), 'client.think', { slot });
  }

  /** @param {number} slot */
  function startOperation(slot) {
    if (started >= cfg.operations) return;
    started++;
    const clientId = slotClientId[slot];
    const key = keyNames[workloadRng.int(0, keyNames.length - 1)];
    const isRead = workloadRng.chance(DEFAULTS.readFraction);
    const input = isRead ? { op: 'get' } : { op: 'put', value: 'v' + ++putCounter };
    /** @type {any} */
    const op = {
      id: opId++,
      clientId,
      key,
      input,
      output: {},
      call: position++,
      ret: -1,
      callTick: sched.now,
      retTick: -1,
      attempts: 0,
      abandoned: false,
    };
    history.push(op);
    const opIndex = openOps.length;
    openOps.push({ clientId, slot, op });
    sched.after(cfg.clientTimeout, 'client.timeout', { slot, opIndex });
    attempt(slot, opIndex, workloadRng.int(0, cfg.nodes - 1));
  }

  /**
   * @param {number} slot
   * @param {number} opIndex
   * @param {number} target
   */
  function attempt(slot, opIndex, target) {
    const rec = openOps[opIndex];
    if (!rec || rec.op.ret !== -1 || rec.op.abandoned) return;
    rec.op.attempts++;
    const node = nodes[target];
    let settled = false;
    /** @param {any} res */
    const done = (res) => {
      if (settled) return; // a node must call done once; belt and braces
      settled = true;
      if (rec.op.ret !== -1 || rec.op.abandoned) return;
      if (res.ok) {
        if (rec.op.input.op === 'get') {
          rec.op.output = { value: res.value === undefined ? null : res.value };
        } else {
          rec.op.output = {};
        }
        rec.op.ret = position++;
        rec.op.retTick = sched.now;
        completed++;
        scheduleThink(slot);
        return;
      }
      const hint = res.hint === null || res.hint === undefined ? workloadRng.int(0, cfg.nodes - 1) : res.hint;
      sched.after(workloadRng.int(5, 25), 'client.retry', { slot, opIndex, target: hint });
    };
    if (rec.op.input.op === 'get') node.clientGet(rec.op.key, done);
    else node.clientPut(rec.op.key, rec.op.input.value, rec.op.id, done);
  }

  // ---- run ------------------------------------------------------------------
  for (const n of nodes) {
    lastRole.set(n.id, n.role);
    n.start();
  }
  for (let s = 0; s < cfg.clients; s++) scheduleThink(s);

  // Sample leadership after each batch so the demo can shade leader terms.
  sched.on('sim.sample', () => {
    for (const n of nodes) {
      if (n.role === 'leader' && lastRole.get(n.id) !== 'leader') {
        leaders.push({ tick: sched.now, node: n.id, term: n.currentTerm });
      }
      lastRole.set(n.id, n.role);
    }
    // Leader heartbeats and election timers reschedule forever, so the queue
    // never drains on its own. Once the workload is finished and nothing is
    // outstanding, let the cluster run a short drain and then stop.
    const outstanding = history.some((o) => o.ret === -1 && !o.abandoned);
    if (started >= cfg.operations && !outstanding) {
      if (drainUntil < 0) drainUntil = sched.now + 50;
    }
    if (drainUntil >= 0 && sched.now >= drainUntil) {
      sched.stop();
      return;
    }
    if (sched.now < cfg.maxTicks) sched.after(5, 'sim.sample', {});
  });
  sched.after(1, 'sim.sample', {});

  const runInfo = sched.run({ untilTick: cfg.maxTicks, maxSteps: 4000000 });

  // ---- finish ---------------------------------------------------------------
  // Every operation that never got a response gets one now, at the end of the
  // history, marked unknown. Sorted by client id so the result does not depend
  // on Map iteration order.
  const unfinished = history.filter((o) => o.ret === -1).sort((a, b) => a.clientId - b.clientId || a.id - b.id);
  for (const op of unfinished) {
    op.output = { unknown: true };
    op.ret = position++;
    op.retTick = sched.now;
  }

  return {
    history,
    config: cfg,
    stats: {
      ticks: sched.now,
      schedulerSteps: runInfo.steps,
      endedBecause: runInfo.endedBecause,
      messagesSent: net.sent,
      messagesDelivered: net.delivered,
      messagesDropped: net.dropped,
      operations: history.length,
      completed,
      unfinished: unfinished.length,
      leaderChanges: leaders.length,
      flags: flags.enabled.slice(),
    },
    leaders,
    faults: net.describe(),
  };
}
