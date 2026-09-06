// History representation.
//
// A history is an ordered list of operations. Order is carried by two integer
// event positions -- `call` and `ret` -- which are indices into the original
// event stream, NOT timestamps. That matters: a linearizability checker only
// ever needs the partial order "a returned before b was called", and inventing
// timestamps where the source had none would be fabricating precision.

/**
 * @typedef {object} Operation
 * @property {number} id           stable id, unique within the history
 * @property {number} clientId     which client issued it (a client is sequential)
 * @property {string} key          partition key; P-compositionality splits on this
 * @property {*} input
 * @property {*} output
 * @property {number} call         event-stream position of the invocation
 * @property {number} ret          event-stream position of the response
 * @property {number} [callTick]   simulated tick of the call, present when the
 *   history came from the simulator rather than from a log. The checker never
 *   reads it -- only the event-stream order matters -- but the diagrams do.
 * @property {number} [retTick]    simulated tick of the response
 * @property {boolean} [abandoned] the client gave up waiting and retired
 * @property {number} [attempts]   how many times the client re-sent it
 */

/**
 * Validate a history and fail loudly on anything malformed. A checker that
 * silently accepts a broken history will happily print a verdict about nothing.
 *
 * @param {Operation[]} ops
 * @returns {Operation[]} the same array, validated
 */
export function validateHistory(ops) {
  if (!Array.isArray(ops)) {
    throw new TypeError('history must be an array of operations, got ' + typeof ops);
  }
  const seenId = new Set();
  const positions = new Set();
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op === null || typeof op !== 'object') {
      throw new TypeError('history[' + i + '] is not an object');
    }
    for (const field of ['id', 'clientId', 'call', 'ret']) {
      if (!Number.isInteger(op[field])) {
        throw new TypeError('history[' + i + '].' + field + ' must be an integer, got ' + String(op[field]));
      }
    }
    if (typeof op.key !== 'string') {
      throw new TypeError('history[' + i + '].key must be a string, got ' + typeof op.key);
    }
    if (op.input === null || typeof op.input !== 'object') {
      throw new TypeError('history[' + i + '].input must be an object');
    }
    if (op.output === null || typeof op.output !== 'object') {
      throw new TypeError('history[' + i + '].output must be an object');
    }
    if (op.ret <= op.call) {
      throw new RangeError(
        'history[' + i + ']: response position ' + op.ret + ' must come after call position ' + op.call
      );
    }
    if (seenId.has(op.id)) throw new Error('history: duplicate operation id ' + op.id);
    seenId.add(op.id);
    if (positions.has(op.call)) throw new Error('history: duplicate event position ' + op.call);
    positions.add(op.call);
    if (positions.has(op.ret)) throw new Error('history: duplicate event position ' + op.ret);
    positions.add(op.ret);
  }
  return ops;
}

/**
 * Split a history into independent sub-histories, one per key.
 *
 * This is P-compositionality (Herlihy & Wing's locality theorem): a history over
 * independent objects is linearizable if and only if every per-object
 * sub-history is. It is not an optimisation detail -- it is the difference
 * between an exponential search over 90 operations and three searches over 30.
 *
 * @param {Operation[]} ops
 * @returns {Map<string, Operation[]>}
 */
export function partitionByKey(ops) {
  /** @type {Map<string, Operation[]>} */
  const parts = new Map();
  for (const op of ops) {
    let bucket = parts.get(op.key);
    if (!bucket) {
      bucket = [];
      parts.set(op.key, bucket);
    }
    bucket.push(op);
  }
  return parts;
}

/**
 * Number of concurrent operations at each event position -- used by the demo's
 * space-time diagram to lay out lanes, and useful as a rough difficulty signal.
 * @param {Operation[]} ops
 * @returns {number}
 */
export function maxConcurrency(ops) {
  /** @type {Array<{pos:number, delta:number}>} */
  const points = [];
  for (const op of ops) {
    points.push({ pos: op.call, delta: 1 });
    points.push({ pos: op.ret, delta: -1 });
  }
  points.sort((a, b) => a.pos - b.pos);
  let cur = 0;
  let max = 0;
  for (const p of points) {
    cur += p.delta;
    if (cur > max) max = cur;
  }
  return max;
}
