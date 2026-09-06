// Terminal space-time diagram.
//
// The same information the web demo draws, in text, so `kedge run` is a
// complete answer on its own and the one-command demo (release-standard row R8)
// does not depend on a browser.

/**
 * @param {import('./raft/cluster.js').SimResult} sim
 * @param {import('./lin/wgl.js').CheckResult} res
 * @param {{model:any, width?:number, maxRows?:number}} opts
 * @returns {string}
 */
export function renderSpaceTime(sim, res, opts) {
  const width = opts.width || 64;
  const maxRows = opts.maxRows || 22;
  const model = opts.model;
  const ops = sim.history;
  if (ops.length === 0) return '(empty history)';

  // A history from the simulator carries simulated ticks; one parsed from a
  // Jepsen log does not, and inventing timestamps for it would be fabricating
  // precision. In that case the event-stream positions ARE the axis, which is
  // exactly the order the checker reasons about.
  /** @param {import('./lin/history.js').Operation} o */
  const startOf = (o) => (o.callTick === undefined ? o.call : o.callTick);
  /** @param {import('./lin/history.js').Operation} o */
  const endOf = (o) => {
    const t = o.retTick === undefined ? o.ret : o.retTick;
    return t < 0 ? startOf(o) : t;
  };
  const minTick = Math.min(...ops.map(startOf));
  const maxTick = Math.max(...ops.map(endOf));
  const span = Math.max(1, maxTick - minTick);

  /** @param {number} tick */
  const col = (tick) => Math.min(width - 1, Math.max(0, Math.round(((tick - minTick) / span) * (width - 1))));

  const blockedId = res.witness ? res.witness.blocked.id : -1;
  const prefixIds = new Set(res.witness ? res.witness.prefix.map((o) => o.id) : []);

  // Show the window around the witness when there is one, otherwise the head.
  let rows = ops;
  if (ops.length > maxRows) {
    if (blockedId >= 0) {
      const at = ops.findIndex((o) => o.id === blockedId);
      const start = Math.max(0, Math.min(ops.length - maxRows, at - Math.floor(maxRows * 0.75)));
      rows = ops.slice(start, start + maxRows);
    } else {
      rows = ops.slice(0, maxRows);
    }
  }

  const lines = [];
  lines.push('  tick ' + String(minTick).padEnd(width - 8) + String(maxTick));

  for (const f of sim.faults) {
    const a = col(f.start);
    const b = col(Math.min(f.end, maxTick));
    let bar = '';
    for (let i = 0; i < width; i++) bar += i >= a && i <= b ? '#' : ' ';
    const label = f.kind === 'crash' ? 'crash ' : 'cut   ';
    lines.push('  ' + label + '|' + bar + '| nodes ' + (f.group.length ? f.group.join(',') : '(none)'));
  }

  for (const o of rows) {
    const a = col(startOf(o));
    const b = Math.max(a, col(endOf(o)));
    let bar = '';
    for (let i = 0; i < width; i++) {
      if (i < a || i > b) bar += ' ';
      else if (i === a && i === b) bar += '|';
      else if (i === a) bar += '[';
      else if (i === b) bar += ']';
      else bar += '-';
    }
    let marker = '  ';
    if (o.id === blockedId) marker = '=>';
    else if (prefixIds.has(o.id)) marker = ' .';
    const label = model.describe(o);
    lines.push(marker + ' c' + String(o.clientId).padStart(2, '0') + ' |' + bar + '| ' + label);
  }

  if (rows.length < ops.length) {
    lines.push('     ... ' + (ops.length - rows.length) + ' more operations not shown');
  }
  if (blockedId >= 0) {
    lines.push('');
    lines.push('  => the operation no ordering can explain      . part of the longest ordering that works');
  }
  return lines.join('\n');
}
