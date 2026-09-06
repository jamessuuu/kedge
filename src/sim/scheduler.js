// Deterministic discrete-event scheduler.
//
// Event time is a logical integer tick. It is deliberately NOT wall-clock time:
// nothing in this file (or anything below the UI layer) calls Date.now,
// performance.now, setTimeout or setInterval. A simulation's entire event
// ordering is fixed by (time, insertion sequence), so two runs of the same seed
// step through exactly the same events in exactly the same order regardless of
// how fast the host machine happens to be.
//
// Tie-breaking is the subtle part. Two events scheduled for the same tick must
// have a total order, or the execution stops being a pure function of the seed.
// Every event carries a monotonically increasing sequence number assigned at
// schedule time, and that is the tie-breaker. Insertion order is itself
// seed-determined, so the whole chain is reproducible.

/**
 * @typedef {object} SimEvent
 * @property {number} time logical tick at which it fires
 * @property {number} seq insertion sequence, the deterministic tie-breaker
 * @property {string} kind label used for tracing and for the UI
 * @property {object} payload
 * @property {boolean} cancelled
 */

/** Min-heap ordered by (time, seq). */
class EventHeap {
  constructor() {
    /** @type {SimEvent[]} */
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  /** @param {SimEvent} a @param {SimEvent} b */
  static before(a, b) {
    if (a.time !== b.time) return a.time < b.time;
    return a.seq < b.seq;
  }

  /** @param {SimEvent} ev */
  push(ev) {
    const items = this.items;
    items.push(ev);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (EventHeap.before(items[i], items[parent])) {
        const t = items[i];
        items[i] = items[parent];
        items[parent] = t;
        i = parent;
      } else break;
    }
  }

  /** @returns {SimEvent|null} */
  pop() {
    const items = this.items;
    if (items.length === 0) return null;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0) {
      items[0] = /** @type {SimEvent} */ (last);
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let best = i;
        if (l < items.length && EventHeap.before(items[l], items[best])) best = l;
        if (r < items.length && EventHeap.before(items[r], items[best])) best = r;
        if (best === i) break;
        const t = items[i];
        items[i] = items[best];
        items[best] = t;
        i = best;
      }
    }
    return top;
  }
}

export class Scheduler {
  constructor() {
    this.now = 0;
    this.seq = 0;
    this.steps = 0;
    this.heap = new EventHeap();
    /** @type {Map<string, Function>} */
    this.handlers = new Map();
    /** @type {Array<{time:number, kind:string, payload:object}>} */
    this.trace = [];
    this.traceLimit = 20000;
    this.stopped = false;
  }

  /**
   * Ask the current run() to return after the event in flight. Used when the
   * workload is finished but timers (leader heartbeats, election timeouts) would
   * otherwise keep the queue alive forever.
   */
  stop() {
    this.stopped = true;
  }

  /**
   * Register the handler for an event kind.
   * @param {string} kind
   * @param {(payload: object, sched: Scheduler) => void} fn
   */
  on(kind, fn) {
    if (this.handlers.has(kind)) {
      throw new Error('Scheduler.on: duplicate handler for kind "' + kind + '"');
    }
    this.handlers.set(kind, fn);
  }

  /**
   * Schedule an event `delay` ticks from now.
   * @param {number} delay non-negative integer ticks
   * @param {string} kind
   * @param {object} payload
   * @returns {SimEvent} the handle, so it can be cancelled
   */
  after(delay, kind, payload) {
    if (!Number.isInteger(delay) || delay < 0) {
      throw new RangeError('Scheduler.after: delay must be a non-negative integer, got ' + String(delay));
    }
    if (!this.handlers.has(kind)) {
      throw new Error('Scheduler.after: no handler registered for kind "' + kind + '"');
    }
    /** @type {SimEvent} */
    const ev = { time: this.now + delay, seq: this.seq++, kind, payload, cancelled: false };
    this.heap.push(ev);
    return ev;
  }

  /** @param {SimEvent|null|undefined} ev */
  cancel(ev) {
    if (ev) ev.cancelled = true;
  }

  /**
   * Run until the queue empties, the deadline passes, or the step budget runs out.
   * @param {{untilTick?: number, maxSteps?: number}} [opts]
   * @returns {{steps: number, endedBecause: string}}
   */
  run(opts) {
    const untilTick = opts && opts.untilTick !== undefined ? opts.untilTick : Infinity;
    const maxSteps = opts && opts.maxSteps !== undefined ? opts.maxSteps : 1000000;
    let ended = 'drained';
    this.stopped = false;
    for (;;) {
      if (this.stopped) {
        ended = 'stopped';
        break;
      }
      if (this.steps >= maxSteps) {
        ended = 'step-budget';
        break;
      }
      const ev = this.heap.pop();
      if (!ev) break;
      if (ev.time > untilTick) {
        // Put it back so the queue stays consistent if run() is called again.
        this.heap.push(ev);
        ended = 'deadline';
        break;
      }
      if (ev.cancelled) continue;
      this.now = ev.time;
      this.steps++;
      if (this.trace.length < this.traceLimit) {
        this.trace.push({ time: ev.time, kind: ev.kind, payload: ev.payload });
      }
      const handler = this.handlers.get(ev.kind);
      // handler presence is checked at schedule time, so this cannot be undefined
      /** @type {Function} */ (handler)(ev.payload, this);
    }
    return { steps: this.steps, endedBecause: ended };
  }
}
