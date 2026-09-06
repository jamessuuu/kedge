// Parser for Jepsen etcd history logs, as shipped in Porcupine's test_data.
//
// This deliberately reproduces Porcupine's own parsing semantics line for line
// (porcupine_test.go, parseJepsenLog), because the corpus is only useful as a
// ground truth if kedge is answering the same question about the same history.
// The three semantics worth naming:
//
//   1. `:info <op> :timed-out` lines are IGNORED. The operation stays pending,
//      and a response with `unknown: true` is appended at the very end of the
//      history. That models "the client never learned the outcome, and the
//      operation may have taken effect at any point afterwards".
//   2. `:fail :read :timed-out` produces a response with `unknown: true` AT
//      THAT POSITION, not at the end.
//   3. Anything else that does not match is skipped.
//
// Porcupine appends the trailing pending responses in Go map order, which is
// randomised. kedge sorts them by process id instead. That is safe rather than
// merely convenient: every trailing response sits after every call, so no
// ordering among them constrains any linearization.

const MAX_BYTES = 32 * 1024 * 1024;

const RE = {
  invokeRead: /^INFO\s+jepsen\.util\s+-\s+(\d+)\s+:invoke\s+:read\s+nil$/,
  invokeWrite: /^INFO\s+jepsen\.util\s+-\s+(\d+)\s+:invoke\s+:write\s+(\d+)$/,
  invokeCas: /^INFO\s+jepsen\.util\s+-\s+(\d+)\s+:invoke\s+:cas\s+\[(\d+)\s+(\d+)\]$/,
  returnRead: /^INFO\s+jepsen\.util\s+-\s+(\d+)\s+:ok\s+:read\s+(nil|\d+)$/,
  returnWrite: /^INFO\s+jepsen\.util\s+-\s+(\d+)\s+:ok\s+:write\s+(\d+)$/,
  returnCas: /^INFO\s+jepsen\.util\s+-\s+(\d+)\s+:(ok|fail)\s+:cas\s+\[(\d+)\s+(\d+)\]$/,
  timeoutRead: /^INFO\s+jepsen\.util\s+-\s+(\d+)\s+:fail\s+:read\s+:timed-out$/,
};

/**
 * @param {string} text raw log contents
 * @param {{source?: string}} [opts]
 * @returns {import('../lin/history.js').Operation[]}
 * @throws {Error} on input that is not a Jepsen log
 */
export function parseJepsenLog(text, opts) {
  const source = (opts && opts.source) || '<input>';
  if (typeof text !== 'string') {
    throw new TypeError(source + ': expected log text as a string, got ' + typeof text);
  }
  if (text.length > MAX_BYTES) {
    throw new RangeError(
      source + ': log is ' + text.length + ' bytes, over the ' + MAX_BYTES + ' byte limit'
    );
  }
  if (text.trim() === '') {
    throw new Error(source + ': file is empty');
  }
  if (text.indexOf('\u0000') !== -1) {
    throw new Error(source + ': contains NUL bytes, this does not look like a Jepsen text log');
  }

  const lines = text.split(/\r?\n/);
  /** @type {import('../lin/history.js').Operation[]} */
  const ops = [];
  /** @type {Map<number, import('../lin/history.js').Operation>} */
  const pending = new Map();
  let pos = 0;
  let id = 0;
  let recognised = 0;

  /**
   * @param {number} proc
   * @param {object} input
   */
  const open = (proc, input) => {
    if (pending.has(proc)) {
      throw new Error(
        source +
          ': process ' +
          proc +
          ' invoked a new operation while one was still outstanding; ' +
          'this history is not well formed (a client must be sequential)'
      );
    }
    /** @type {import('../lin/history.js').Operation} */
    const op = { id: id++, clientId: proc, key: 'x', input, output: {}, call: pos++, ret: -1 };
    pending.set(proc, op);
    ops.push(op);
  };

  /**
   * @param {number} proc
   * @param {object} output
   */
  const close = (proc, output) => {
    const op = pending.get(proc);
    if (!op) return; // a response with no invocation; Porcupine ignores these too
    pending.delete(proc);
    op.output = output;
    op.ret = pos++;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line === '') continue;
    let m;
    if ((m = RE.invokeRead.exec(line))) {
      open(Number(m[1]), { op: 'read' });
      recognised++;
    } else if ((m = RE.invokeWrite.exec(line))) {
      open(Number(m[1]), { op: 'write', arg1: Number(m[2]) });
      recognised++;
    } else if ((m = RE.invokeCas.exec(line))) {
      open(Number(m[1]), { op: 'cas', arg1: Number(m[2]), arg2: Number(m[3]) });
      recognised++;
    } else if ((m = RE.returnRead.exec(line))) {
      const exists = m[2] !== 'nil';
      close(Number(m[1]), { exists, value: exists ? Number(m[2]) : 0 });
      recognised++;
    } else if ((m = RE.returnWrite.exec(line))) {
      close(Number(m[1]), {});
      recognised++;
    } else if ((m = RE.returnCas.exec(line))) {
      close(Number(m[1]), { ok: m[2] === 'ok' });
      recognised++;
    } else if ((m = RE.timeoutRead.exec(line))) {
      close(Number(m[1]), { unknown: true });
      recognised++;
    }
    // everything else, including `:info <op> :timed-out`, is skipped on purpose
  }

  if (recognised === 0) {
    throw new Error(
      source + ': no Jepsen operations found; expected lines like "INFO  jepsen.util - 0\t:invoke\t:read\tnil"'
    );
  }

  const stillOpen = Array.from(pending.values()).sort((a, b) => a.clientId - b.clientId);
  for (const op of stillOpen) {
    op.output = { unknown: true };
    op.ret = pos++;
  }

  return ops;
}
