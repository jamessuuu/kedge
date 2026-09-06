// Linearizability checker: Wing & Gong's algorithm with Lowe's memoisation,
// plus P-compositionality.
//
// Deciding linearizability of a history against an arbitrary sequential
// specification is NP-complete (Gibbons & Korach 1997). That is not a caveat
// bolted onto this file, it is the reason the file has three return values
// instead of two. Every other checker in this portfolio returns
// unknown because its author chose to be honest about coverage. This one
// returns unknown because the alternative is a search that does not terminate
// in the time a human will wait.
//
// The search:
//   entries are the calls and responses in event order, as a doubly linked list
//   repeatedly try to linearize the earliest remaining call
//     if the model accepts it and the resulting (state, linearized-set) pair is
//     new, commit it: lift the call AND its response out of the list, and
//     restart from the front
//     otherwise move on to the next entry
//   reaching a response whose call is still in the list means the prefix is
//   dead -- undo the last commitment and continue from there
//   the list emptying means a full linearization was found
//
// The memo table is what makes this tractable. Two search paths that have
// linearized the same SET of operations and arrived at the same model state are
// interchangeable from that point on, so the second one is pruned. Correctness
// of that pruning rests entirely on model.stateKey being exact; see models.js.

import { validateHistory, partitionByKey } from './history.js';

export const DEFAULT_BUDGET = 4000000;

/**
 * @typedef {object} CheckResult
 * @property {string} verdict 'linearizable' | 'not-linearizable' | 'unknown'
 * @property {number} steps model transitions attempted
 * @property {number} budget
 * @property {number} operations
 * @property {number} partitions
 * @property {?Witness} witness
 * @property {PartitionResult[]} perPartition
 */

/**
 * @typedef {object} Witness
 * @property {string} key
 * @property {import('./history.js').Operation} blocked the response that could not be explained
 * @property {import('./history.js').Operation[]} prefix longest consistent explanation found
 * @property {string} text
 */

/**
 * @typedef {object} PartitionResult
 * @property {string} key
 * @property {string} verdict
 * @property {number} steps
 * @property {number} operations
 * @property {?Witness} witness
 */

/** Fixed-size bitset over `n` operations, keyed as a hex string for the memo. */
class Bitset {
  /** @param {number} n */
  constructor(n) {
    this.words = new Uint32Array(Math.ceil(n / 32) || 1);
  }
  /** @param {number} i */
  set(i) {
    this.words[i >>> 5] |= 1 << (i & 31);
  }
  /** @param {number} i */
  clear(i) {
    this.words[i >>> 5] &= ~(1 << (i & 31));
  }
  /** @returns {string} */
  key() {
    let s = '';
    for (let i = 0; i < this.words.length; i++) {
      s += this.words[i].toString(36) + '.';
    }
    return s;
  }
}

/**
 * Linked-list node for one event.
 * @typedef {object} Entry
 * @property {boolean} isCall
 * @property {number} idx        index of the operation within this partition
 * @property {import('./history.js').Operation} op
 * @property {?Entry} match      for a call, its response node
 * @property {?Entry} prev
 * @property {?Entry} next
 */

/**
 * @param {import('./history.js').Operation[]} ops
 * @returns {Entry} sentinel head
 */
function buildEntries(ops) {
  /** @type {Entry[]} */
  const events = [];
  for (let idx = 0; idx < ops.length; idx++) {
    const op = ops[idx];
    /** @type {Entry} */
    const call = { isCall: true, idx, op, match: null, prev: null, next: null };
    /** @type {Entry} */
    const ret = { isCall: false, idx, op, match: call, prev: null, next: null };
    call.match = ret;
    events.push(call, ret);
  }
  events.sort((a, b) => {
    const pa = a.isCall ? a.op.call : a.op.ret;
    const pb = b.isCall ? b.op.call : b.op.ret;
    return pa - pb;
  });
  /** @type {Entry} */
  const head = { isCall: false, idx: -1, op: /** @type {any} */ (null), match: null, prev: null, next: null };
  let cur = head;
  for (const e of events) {
    cur.next = e;
    e.prev = cur;
    cur = e;
  }
  cur.next = null;
  return head;
}

/** @param {Entry} node */
function unlink(node) {
  const prev = /** @type {Entry} */ (node.prev);
  prev.next = node.next;
  if (node.next) node.next.prev = prev;
}

/** @param {Entry} node */
function relink(node) {
  const prev = /** @type {Entry} */ (node.prev);
  prev.next = node;
  if (node.next) node.next.prev = node;
}

/**
 * Check one partition.
 *
 * @param {any} model
 * @param {import('./history.js').Operation[]} ops
 * @param {number} budget
 * @param {{acceptOnBlock?: boolean}} [sabotage] build-flag fixtures, see src/bugs.js
 * @returns {{verdict:string, steps:number, witness:?Witness}}
 */
export function checkPartition(model, ops, budget, sabotage) {
  const n = ops.length;
  if (n === 0) return { verdict: 'linearizable', steps: 0, witness: null };

  const head = buildEntries(ops);
  const linearized = new Bitset(n);
  /** @type {Map<string, Set<string>>} */
  const memo = new Map();
  /** @type {Array<{entry: Entry, state: any}>} */
  const calls = [];

  let state = model.init();
  let entry = head.next;
  let steps = 0;

  // Deepest partial linearization seen, kept for the witness. The blocking
  // response at that depth is the most informative thing the search learns
  // about WHY the history has no linearization.
  let deepest = -1;
  /** @type {?Entry} */
  let deepestBlock = null;
  /** @type {import('./history.js').Operation[]} */
  let deepestPrefix = [];

  while (head.next !== null) {
    if (steps >= budget) {
      return { verdict: 'unknown', steps, witness: null };
    }
    const e = /** @type {Entry} */ (entry);
    if (e.isCall) {
      steps++;
      const [ok, nextState] = model.step(state, e.op.input, e.op.output);
      let committed = false;
      if (ok) {
        linearized.set(e.idx);
        const bits = linearized.key();
        const sk = model.stateKey(nextState);
        let states = memo.get(bits);
        if (!states) {
          states = new Set();
          memo.set(bits, states);
        }
        if (!states.has(sk)) {
          states.add(sk);
          calls.push({ entry: e, state });
          state = nextState;
          unlink(e);
          unlink(/** @type {Entry} */ (e.match));
          entry = head.next;
          committed = true;
        } else {
          linearized.clear(e.idx);
        }
      }
      if (!committed) {
        entry = e.next;
      }
    } else {
      if (calls.length > deepest) {
        deepest = calls.length;
        deepestBlock = e;
        deepestPrefix = calls.map((c) => c.entry.op);
      }
      if (calls.length === 0) {
        if (sabotage && sabotage.acceptOnBlock) {
          // PLANTED FIXTURE (build flag `checker-accept-on-block`). The search
          // has proven no linearization exists, and this branch reports success
          // anyway. It exists so the suite can watch the checker's rejection
          // path fail; see test/sabotage.test.js.
          return { verdict: 'linearizable', steps, witness: null };
        }
        return {
          verdict: 'not-linearizable',
          steps,
          witness: buildWitness(model, ops, /** @type {Entry} */ (deepestBlock), deepestPrefix),
        };
      }
      const top = /** @type {{entry: Entry, state: any}} */ (calls.pop());
      state = top.state;
      linearized.clear(top.entry.idx);
      relink(/** @type {Entry} */ (top.entry.match));
      relink(top.entry);
      entry = top.entry.next;
    }
  }
  return { verdict: 'linearizable', steps, witness: null };
}

/**
 * @param {any} model
 * @param {import('./history.js').Operation[]} ops
 * @param {Entry} block
 * @param {import('./history.js').Operation[]} prefix
 * @returns {Witness}
 */
function buildWitness(model, ops, block, prefix) {
  const blockedOp = block.op;
  const last = prefix.length > 0 ? prefix[prefix.length - 1] : null;
  let text = model.describe(blockedOp) + ' cannot be placed anywhere in the order';
  if (last) {
    text += '; the longest consistent explanation ends at ' + model.describe(last);
  }
  return { key: blockedOp.key, blocked: blockedOp, prefix, text };
}

/**
 * Check a whole history.
 *
 * @param {any} model
 * @param {import('./history.js').Operation[]} ops
 * @param {{budget?: number, sabotage?: {acceptOnBlock?: boolean}}} [opts]
 * @returns {CheckResult}
 */
export function check(model, ops, opts) {
  validateHistory(ops);
  const budget = opts && opts.budget !== undefined ? opts.budget : DEFAULT_BUDGET;
  if (!Number.isInteger(budget) || budget <= 0) {
    throw new RangeError('budget must be a positive integer, got ' + String(budget));
  }
  const sabotage = (opts && opts.sabotage) || undefined;

  const parts = partitionByKey(ops);
  // Deterministic order: the verdict and the witness must not depend on Map
  // iteration order, so keys are sorted before the search.
  const keys = Array.from(parts.keys()).sort();

  /** @type {PartitionResult[]} */
  const perPartition = [];
  let totalSteps = 0;
  let sawUnknown = false;
  /** @type {?Witness} */
  let firstWitness = null;

  // Budget is shared across partitions, so a 5-key history cannot quietly spend
  // 5x the advertised budget.
  let remaining = budget;

  for (const key of keys) {
    const bucket = /** @type {import('./history.js').Operation[]} */ (parts.get(key));
    const share = Math.max(1, remaining);
    const res = checkPartition(model, bucket, share, sabotage);
    remaining -= res.steps;
    totalSteps += res.steps;
    perPartition.push({
      key,
      verdict: res.verdict,
      steps: res.steps,
      operations: bucket.length,
      witness: res.witness,
    });
    if (res.verdict === 'not-linearizable') {
      if (!firstWitness) firstWitness = res.witness;
      // A single non-linearizable sub-history makes the whole history
      // non-linearizable; stop, the answer cannot change.
      return {
        verdict: 'not-linearizable',
        steps: totalSteps,
        budget,
        operations: ops.length,
        partitions: keys.length,
        witness: firstWitness,
        perPartition,
      };
    }
    if (res.verdict === 'unknown') sawUnknown = true;
    if (remaining <= 0 && keys.indexOf(key) < keys.length - 1) {
      sawUnknown = true;
      break;
    }
  }

  return {
    verdict: sawUnknown ? 'unknown' : 'linearizable',
    steps: totalSteps,
    budget,
    operations: ops.length,
    partitions: keys.length,
    witness: null,
    perPartition,
  };
}
