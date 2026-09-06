// Simulated network: seeded delays, scripted partitions, and crash-stop.
//
// Delivery model, stated plainly so the README does not have to lie about it:
//   * every message gets a delay drawn from the seeded Rng at send time;
//   * the partition check happens at DELIVERY time, so a partition drops
//     packets that are already in flight -- which is what a real network
//     partition does to a TCP segment;
//   * a crashed node neither sends nor receives, and its timers do not fire.
//     kedge has no persistence, so a crash here loses no state; it is a pause,
//     and the README says so rather than calling it a crash-recovery model;
//   * there is no reordering beyond what independent delays produce, and no
//     duplication. Both are real failure modes and both are out of scope.

/**
 * @typedef {object} Fault
 * @property {'partition'|'crash'} kind
 * @property {number} start inclusive tick
 * @property {number} end exclusive tick
 * @property {Array<number|'L'>} spec node ids, or 'L' for "whoever leads when this fault opens"
 * @property {?Set<number>} group resolved node set; null until the window opens
 */

/**
 * Parse a fault script.
 *
 * Grammar, kept URL-safe on purpose -- the shareable object is a failing
 * execution, so the whole fault plan has to survive a query string:
 *
 *   script := entry ("," entry)*
 *   entry  := kind? start "-" end ":" target ("." target)*
 *   kind   := "p" (partition, the default) | "c" (crash-stop)
 *   target := node id | "L"
 *
 * `L` resolves, once, at the tick the fault opens, to the id of the current
 * leader (the lowest id if the cluster has managed to elect more than one).
 * That keeps the script deterministic while letting a control read
 * "isolate the leader", which is the fault anyone actually wants to inject.
 *
 * Examples:
 *   150-450:L        isolate the leader from the rest of the cluster
 *   150-450:0.1      cut nodes 0 and 1 off from nodes 2, 3 and 4
 *   c200-400:3       crash node 3 (it keeps its state and comes back at 400)
 *
 * @param {string} text
 * @returns {Fault[]}
 */
export function parseFaultScript(text) {
  if (text === undefined || text === null) return [];
  const trimmed = String(text).trim();
  if (trimmed === '') return [];
  /** @type {Fault[]} */
  const out = [];
  for (const raw of trimmed.split(',')) {
    const entry = raw.trim();
    if (entry === '') continue;
    const m = /^([pc]?)(\d+)-(\d+):((?:\d+|L)(?:\.(?:\d+|L))*)$/.exec(entry);
    if (!m) {
      throw new Error(
        'invalid fault "' +
          entry +
          '": expected [p|c]<start>-<end>:<node|L>[.<node|L>...], e.g. 150-450:L or c200-400:3'
      );
    }
    const start = Number(m[2]);
    const end = Number(m[3]);
    if (end <= start) {
      throw new Error('invalid fault "' + entry + '": end must be greater than start');
    }
    /** @type {Array<number|'L'>} */
    const spec = m[4].split('.').map((t) => (t === 'L' ? 'L' : Number(t)));
    out.push({ kind: m[1] === 'c' ? 'crash' : 'partition', start, end, spec, group: null });
  }
  return out;
}

/** @param {Fault[]} faults @returns {string} */
export function formatFaultScript(faults) {
  return faults
    .map((f) => (f.kind === 'crash' ? 'c' : '') + f.start + '-' + f.end + ':' + f.spec.join('.'))
    .join(',');
}

export class Network {
  /**
   * @param {object} opts
   * @param {import('./scheduler.js').Scheduler} opts.sched
   * @param {import('./rng.js').Rng} opts.rng
   * @param {Fault[]} [opts.faults]
   * @param {() => (number|null)} [opts.leaderLookup] resolves the `L` target
   * @param {number} [opts.minDelay]
   * @param {number} [opts.maxDelay]
   * @param {number} [opts.dropRate]
   */
  constructor(opts) {
    this.sched = opts.sched;
    this.rng = opts.rng;
    this.faults = opts.faults || [];
    this.leaderLookup = opts.leaderLookup || (() => null);
    this.minDelay = opts.minDelay === undefined ? 2 : opts.minDelay;
    this.maxDelay = opts.maxDelay === undefined ? 12 : opts.maxDelay;
    this.dropRate = opts.dropRate === undefined ? 0 : opts.dropRate;
    /** @type {(from:number, to:number, msg:object) => void} */
    this.deliver = () => {};
    this.sent = 0;
    this.dropped = 0;
    this.delivered = 0;

    this.sched.on('net.deliver', (payload) => {
      const p = /** @type {{from:number,to:number,msg:object}} */ (payload);
      if (this.isDown(p.from) || this.isDown(p.to) || this.isPartitioned(p.from, p.to)) {
        this.dropped++;
        return;
      }
      this.delivered++;
      this.deliver(p.from, p.to, p.msg);
    });
  }

  /**
   * Resolve a fault's node set, once, at the tick its window opens.
   * @param {Fault} f
   * @returns {Set<number>}
   */
  resolve(f) {
    if (f.group) return f.group;
    const ids = [];
    for (const t of f.spec) {
      if (t === 'L') {
        const leader = this.leaderLookup();
        // No leader at the moment the fault opens: the fault targets nothing,
        // which is honest -- it is not silently retargeted at some other node.
        if (leader !== null && leader !== undefined) ids.push(leader);
      } else {
        ids.push(t);
      }
    }
    f.group = new Set(ids);
    return f.group;
  }

  /** @param {Fault} f @returns {boolean} */
  active(f) {
    return this.sched.now >= f.start && this.sched.now < f.end;
  }

  /** @param {number} node @returns {boolean} */
  isDown(node) {
    for (const f of this.faults) {
      if (f.kind !== 'crash') continue;
      if (!this.active(f)) continue;
      if (this.resolve(f).has(node)) return true;
    }
    return false;
  }

  /**
   * @param {number} a
   * @param {number} b
   * @returns {boolean}
   */
  isPartitioned(a, b) {
    for (const f of this.faults) {
      if (f.kind !== 'partition') continue;
      if (!this.active(f)) continue;
      const group = this.resolve(f);
      if (group.has(a) !== group.has(b)) return true;
    }
    return false;
  }

  /**
   * @param {number} from
   * @param {number} to
   * @param {object} msg
   */
  send(from, to, msg) {
    this.sent++;
    if (this.dropRate > 0 && this.rng.chance(this.dropRate)) {
      this.dropped++;
      return;
    }
    const delay = this.rng.int(this.minDelay, this.maxDelay);
    this.sched.after(delay, 'net.deliver', { from, to, msg });
  }

  /**
   * Windows in which each fault was active, for the space-time diagram.
   * @returns {Array<{kind:string, start:number, end:number, group:number[], spec:string}>}
   */
  describe() {
    return this.faults.map((f) => ({
      kind: f.kind,
      start: f.start,
      end: f.end,
      group: f.group ? Array.from(f.group).sort((a, b) => a - b) : [],
      spec: f.spec.join('.'),
    }));
  }
}
