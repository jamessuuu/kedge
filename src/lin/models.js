// Sequential specifications the checker linearizes against.
//
// A model is a plain object:
//   name        human label
//   init()      -> initial state (must be immutable or copied by step)
//   step(state, input, output) -> [ok, nextState]
//   stateKey(state) -> string, used as the memo key; two states with the same
//               key MUST be interchangeable for all future steps, or the cache
//               will prune a real linearization and produce a false
//               "not-linearizable". This is the single most dangerous line in
//               the checker, which is why every model states it explicitly.
//   describe(op) -> string, for witnesses and the space-time diagram

/**
 * The etcd single-register model, transcribed from porcupine_test.go so that
 * kedge's verdicts are comparable to Porcupine's published ones.
 *
 * Semantics that look odd but are deliberate, because Porcupine defines them
 * this way and parity is the whole point of the corpus run:
 *   * a write ALWAYS succeeds and always installs its value, even when the
 *     client never saw a response (`unknown`). A write that timed out may still
 *     have taken effect, and the model is permissive about it.
 *   * an operation with `unknown: true` is accepted by every branch, because
 *     the client learned nothing.
 */
export const etcdRegisterModel = {
  name: 'etcd-register',
  init() {
    return null; // null is etcd's "key does not exist"
  },
  /**
   * @param {number|null} state
   * @param {{op:string, arg1?:number, arg2?:number}} input
   * @param {{exists?:boolean, value?:number, ok?:boolean, unknown?:boolean}} output
   * @returns {[boolean, number|null]}
   */
  step(state, input, output) {
    if (input.op === 'read') {
      const ok =
        output.unknown === true ||
        (output.exists === false && state === null) ||
        (output.exists === true && state === output.value);
      return [ok, state];
    }
    if (input.op === 'write') {
      return [true, /** @type {number} */ (input.arg1)];
    }
    if (input.op === 'cas') {
      const from = /** @type {number} */ (input.arg1);
      const to = /** @type {number} */ (input.arg2);
      const succeeded = output.ok === true;
      const ok =
        output.unknown === true ||
        (from === state && succeeded) ||
        (from !== state && !succeeded);
      const next = from === state ? to : state;
      return [ok, next];
    }
    throw new Error('etcd-register: unknown operation "' + String(input.op) + '"');
  },
  /** @param {number|null} state */
  stateKey(state) {
    return state === null ? 'nil' : String(state);
  },
  /** @param {{input:any, output:any}} op */
  describe(op) {
    const i = op.input;
    const o = op.output;
    if (i.op === 'read') {
      if (o.unknown) return 'read() -> unknown';
      return 'read() -> ' + (o.exists ? String(o.value) : 'null');
    }
    if (i.op === 'write') {
      return 'write(' + i.arg1 + ')' + (o.unknown ? ' -> unknown' : '');
    }
    return 'cas(' + i.arg1 + ', ' + i.arg2 + ') -> ' + (o.unknown ? 'unknown' : o.ok ? 'ok' : 'fail');
  },
};

/**
 * kedge's own key/value model, used for the simulator. Multi-key, which is what
 * makes P-compositionality do real work rather than being a no-op: the checker
 * splits the history by key and checks each sub-history independently.
 *
 * State is a single value (per key -- the partitioning happens outside the
 * model), so stateKey is exact, not an approximation.
 */
export const kvRegisterModel = {
  name: 'kv-register',
  init() {
    return null;
  },
  /**
   * @param {string|null} state
   * @param {{op:string, value?:string}} input
   * @param {{value?:string|null, unknown?:boolean}} output
   * @returns {[boolean, string|null]}
   */
  step(state, input, output) {
    if (input.op === 'get') {
      if (output.unknown === true) return [true, state];
      const seen = output.value === undefined ? null : output.value;
      return [seen === state, state];
    }
    if (input.op === 'put') {
      // A put whose response was lost may or may not have landed; like the etcd
      // model we take the permissive branch and install the value.
      return [true, /** @type {string} */ (input.value)];
    }
    throw new Error('kv-register: unknown operation "' + String(input.op) + '"');
  },
  /** @param {string|null} state */
  stateKey(state) {
    return state === null ? 'nil' : 'v:' + state;
  },
  /** @param {{key:string, input:any, output:any}} op */
  describe(op) {
    const i = op.input;
    const o = op.output;
    if (i.op === 'get') {
      if (o.unknown) return 'get(' + op.key + ') -> unknown';
      return 'get(' + op.key + ') -> ' + (o.value === null || o.value === undefined ? 'null' : JSON.stringify(o.value));
    }
    return 'put(' + op.key + ', ' + JSON.stringify(i.value) + ')' + (o.unknown ? ' -> unknown' : '');
  },
};

/** @type {Record<string, typeof etcdRegisterModel>} */
export const MODELS = {
  'etcd-register': etcdRegisterModel,
  'kv-register': /** @type {any} */ (kvRegisterModel),
};
