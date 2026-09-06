// The demo page's controller.
//
// This is the UI layer, and the only place in the project allowed to touch the
// clock or the DOM. Everything it calls -- the scheduler, the Raft nodes, the
// checker -- is the same code the CLI and the test suite run, so what the page
// shows is not a re-implementation that could drift.

import { runSimulation } from '../src/raft/cluster.js';
import { check } from '../src/lin/wgl.js';
import { kvRegisterModel, etcdRegisterModel } from '../src/lin/models.js';
import { parseJepsenLog } from '../src/io/jepsen.js';
import { parseBuildFlags, correctBuild, BUGS } from '../src/bugs.js';

const DEFAULTS = {
  seed: 4711,
  faults: '150-700:L',
  build: 'deposed-leader-read',
  ops: 60,
};

const FAULT_PRESETS = [
  { value: '', label: 'None' },
  { value: '150-700:L', label: 'Partition the leader away (ticks 150-700)' },
  { value: '200-500:0.1,600-900:2.3', label: 'Two cuts: {0,1} then {2,3}' },
  {
    value: 'c120-200:L,c220-300:L,c320-400:L,c420-500:L,c520-600:L,c620-700:L',
    label: 'Crash the leader, six times over',
  },
];

const el = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/** @returns {{seed:number, faults:string, build:string, ops:number}} */
function stateFromUrl() {
  const p = new URLSearchParams(window.location.search);
  const seed = Number.parseInt(p.get('seed') || '', 10);
  const ops = Number.parseInt(p.get('ops') || '', 10);
  return {
    seed: Number.isInteger(seed) ? seed : DEFAULTS.seed,
    faults: p.get('faults') === null ? DEFAULTS.faults : /** @type {string} */ (p.get('faults')),
    build: p.get('build') === null ? DEFAULTS.build : /** @type {string} */ (p.get('build')),
    ops: Number.isInteger(ops) && ops > 0 && ops <= 200 ? ops : DEFAULTS.ops,
  };
}

/** @param {{seed:number, faults:string, build:string, ops:number}} s */
function urlFor(s) {
  const p = new URLSearchParams();
  p.set('seed', String(s.seed));
  p.set('faults', s.faults);
  p.set('build', s.build);
  p.set('ops', String(s.ops));
  return window.location.origin + window.location.pathname + '?' + p.toString();
}

// --------------------------------------------------------------------------

const PALETTE = {
  put: '#5b8def',
  get: '#38b48b',
  unknown: '#8a8f98',
  blocked: '#e5484d',
  prefix: '#f5a524',
};

/**
 * @param {any} sim
 * @param {any} res
 * @returns {string} SVG markup
 */
function diagram(sim, res) {
  const ops = sim.history;
  if (ops.length === 0) return '<p class="muted">no operations</p>';

  const clients = Array.from(new Set(ops.map((/** @type {any} */ o) => o.clientId))).sort(
    (/** @type {number} */ a, /** @type {number} */ b) => a - b
  );
  const rowOf = new Map(clients.map((c, i) => [c, i]));

  const minTick = Math.min(...ops.map((/** @type {any} */ o) => o.callTick));
  const maxTick = Math.max(...ops.map((/** @type {any} */ o) => Math.max(o.callTick, o.retTick)));
  const span = Math.max(1, maxTick - minTick);

  const padL = 66;
  const padR = 18;
  const padT = 40;
  const rowH = 28;
  const width = 1000;
  const plotW = width - padL - padR;
  const plotH = clients.length * rowH;
  const height = padT + plotH + 46;

  const x = (/** @type {number} */ t) => padL + ((t - minTick) / span) * plotW;

  const blocked = res.witness ? res.witness.blocked : null;
  const prefix = res.witness ? res.witness.prefix : [];
  // Only the LAST operation of the longest working ordering is marked. Outlining
  // all of them turns the picture into noise, and it is the last one that the
  // witness sentence actually names.
  const anchor = prefix.length > 0 ? prefix[prefix.length - 1] : null;

  const parts = [];
  parts.push(
    '<svg viewBox="0 0 ' + width + ' ' + height +
      '" role="img" aria-label="Space-time diagram of the client history" xmlns="http://www.w3.org/2000/svg">'
  );
  parts.push(
    '<defs><marker id="open" viewBox="0 0 6 6" refX="1" refY="3" markerWidth="5" markerHeight="5" orient="auto">' +
      '<path d="M0 0 L5 3 L0 6" fill="none" stroke="#8a8f98" stroke-width="1.2"/></marker></defs>'
  );

  for (const f of sim.faults) {
    const a = x(Math.max(minTick, f.start));
    const b = x(Math.min(maxTick, f.end));
    if (b <= a) continue;
    parts.push(
      '<rect class="fault ' + f.kind + '" x="' + a.toFixed(1) + '" y="' + (padT - 14) +
        '" width="' + (b - a).toFixed(1) + '" height="' + (plotH + 14) + '"/>'
    );
    parts.push(
      '<text class="faultlabel" x="' + (a + 6).toFixed(1) + '" y="' + (padT - 20) + '">' +
        (f.kind === 'crash' ? 'crash' : 'partition') + (f.group.length ? ' node ' + f.group.join(', ') : '') +
        '</text>'
    );
  }

  parts.push(
    '<line class="axis" x1="' + padL + '" y1="' + (padT - 14) +
      '" x2="' + padL + '" y2="' + (padT + plotH) + '"/>'
  );
  parts.push('<text class="tick" x="' + padL + '" y="' + (height - 14) + '">tick ' + minTick + '</text>');
  parts.push(
    '<text class="tick" text-anchor="end" x="' + (width - padR) + '" y="' + (height - 14) + '">' +
      maxTick + '</text>'
  );

  for (const c of clients) {
    const y = padT + /** @type {number} */ (rowOf.get(c)) * rowH + rowH / 2;
    parts.push(
      '<text class="lane" x="' + (padL - 10) + '" y="' + (y + 4) +
        '" text-anchor="end">client ' + c + '</text>'
    );
    parts.push('<line class="lane-rule" x1="' + padL + '" y1="' + y + '" x2="' + (width - padR) + '" y2="' + y + '"/>');
  }

  // A guide line through the offending operation, so the eye finds it before
  // it has read anything.
  if (blocked) {
    const gx = x(blocked.callTick);
    parts.push(
      '<line class="guide" x1="' + gx.toFixed(1) + '" y1="' + (padT - 14) + '" x2="' + gx.toFixed(1) +
        '" y2="' + (padT + plotH) + '"/>'
    );
  }

  for (const o of ops) {
    const y = padT + /** @type {number} */ (rowOf.get(o.clientId)) * rowH + rowH / 2;
    const a = x(o.callTick);
    const b = Math.max(a + 3, x(o.retTick));
    const label = kvRegisterModel.describe(o);
    const title = '<title>' + escapeXml(label) + ' (ticks ' + o.callTick + '-' + o.retTick + ')</title>';

    if (o.output && o.output.unknown) {
      // Never answered. Drawn open-ended rather than as a solid bar, because a
      // solid bar claims an end the client never saw -- and these span most of
      // the run, so drawing them heavy would bury everything else.
      parts.push(
        '<g class="op op-unknown">' + title +
          '<line x1="' + a.toFixed(1) + '" y1="' + y + '" x2="' + (b - 6).toFixed(1) + '" y2="' + y +
          '" marker-end="url(#open)"/>' +
          '<circle cx="' + a.toFixed(1) + '" cy="' + y + '" r="3"/></g>'
      );
      continue;
    }

    const isBlocked = blocked && o.id === blocked.id;
    const isAnchor = anchor && o.id === anchor.id;
    const fill = isBlocked ? PALETTE.blocked : o.input.op === 'put' ? PALETTE.put : PALETTE.get;
    const cls = 'op' + (isBlocked ? ' op-blocked' : isAnchor ? ' op-anchor' : '');
    // The offending operation is drawn taller and carries a caret, because it is
    // the one thing on this page a visitor has to be able to find in a second.
    const h = isBlocked ? 18 : 12;
    const w = Math.max(b - a, isBlocked ? 7 : 3);
    parts.push(
      '<g class="' + cls + '">' + title +
        '<rect x="' + a.toFixed(1) + '" y="' + (y - h / 2) + '" width="' + w.toFixed(1) +
        '" height="' + h + '" rx="3" fill="' + fill + '"/>' +
        (isBlocked
          ? '<path class="caret" d="M' + (a + w / 2 - 5).toFixed(1) + ' ' + (y - h / 2 - 5) +
            ' L' + (a + w / 2 + 5).toFixed(1) + ' ' + (y - h / 2 - 5) +
            ' L' + (a + w / 2).toFixed(1) + ' ' + (y - h / 2 - 1) + ' Z"/>'
          : '') +
        '</g>'
    );
  }

  // Callouts last, so nothing is drawn over them, and nudged apart if the two
  // operations happen to sit on neighbouring rows at the same instant.
  /** @type {Array<{x:number,y:number,w:number}>} */
  const placed = [];
  const geom = { padT, rowH, width, padR, rowOf };
  if (anchor) {
    const t = 'last step that works: ' + kvRegisterModel.describe(anchor);
    parts.push(callout(x, anchor, geom, placed, 'anchor', t));
  }
  if (blocked) {
    const t = kvRegisterModel.describe(blocked) + '  <- no ordering explains this';
    parts.push(callout(x, blocked, geom, placed, 'blocked', t));
  }

  parts.push('</svg>');
  return parts.join('');
}

/**
 * A label with its own backing plate, placed on whichever side of the operation
 * has room.
 * @returns {string}
 */
function callout(x, op, geom, placed, kind, text) {
  const y = geom.padT + geom.rowOf.get(op.clientId) * geom.rowH + geom.rowH / 2;
  const right = x(op.retTick) + 12;
  const charW = 6.6;
  const w = text.length * charW + 14;
  const fitsRight = right + w < geom.width - geom.padR;
  const bx = fitsRight ? right : Math.max(2, x(op.callTick) - 12 - w);
  let ty = y - 13;
  // Nudge down until this box clears every box already drawn.
  for (let guard = 0; guard < 8; guard++) {
    const clash = placed.some(
      (b) => Math.abs(b.y - ty) < 17 && bx < b.x + b.w + 6 && b.x < bx + w + 6
    );
    if (!clash) break;
    ty += 19;
  }
  placed.push({ x: bx, y: ty, w });
  return (
    '<g class="callout callout-' + kind + '">' +
    '<rect x="' + bx.toFixed(1) + '" y="' + (ty - 11) + '" width="' + w.toFixed(1) + '" height="16" rx="3"/>' +
    '<text x="' + (bx + 7).toFixed(1) + '" y="' + ty + '">' + escapeXml(text) + '</text>' +
    '</g>'
  );
}

/** @param {string} s */
function escapeXml(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c] || c));
}

// --------------------------------------------------------------------------

/** @param {{seed:number, faults:string, build:string, ops:number}} s */
function runAndRender(s) {
  let flags;
  try {
    flags = s.build === '' || s.build === 'correct' ? correctBuild() : parseBuildFlags(s.build);
  } catch (err) {
    showError(/** @type {Error} */ (err).message);
    return;
  }

  let sim;
  try {
    sim = runSimulation({
      seed: s.seed,
      faults: s.faults,
      operations: s.ops,
      clients: 4,
      nodes: 5,
      keys: 1,
      maxEntriesPerAppend: s.build === 'stale-term-commit' ? 1 : 8,
      flags,
    });
  } catch (err) {
    showError(/** @type {Error} */ (err).message);
    return;
  }

  const res = check(kvRegisterModel, sim.history, { budget: 2000000 });

  const verdict = el('verdict');
  verdict.className = 'verdict verdict-' + res.verdict;
  el('verdict-word').textContent =
    res.verdict === 'not-linearizable'
      ? 'not linearizable'
      : res.verdict === 'linearizable'
        ? 'linearizable'
        : 'unknown';
  el('verdict-detail').textContent =
    'seed ' + s.seed + ' · ' + res.steps.toLocaleString() + ' steps · ' + res.operations + ' operations';

  const witness = el('witness');
  if (res.verdict === 'not-linearizable' && res.witness) {
    witness.hidden = false;
    witness.textContent = 'witness: ' + res.witness.text;
  } else if (res.verdict === 'unknown') {
    witness.hidden = false;
    witness.textContent =
      'the search exhausted its ' + res.budget.toLocaleString() +
      '-step budget. That is not a pass: it means this history is too hard to decide in the time you would wait.';
  } else {
    witness.hidden = false;
    witness.textContent =
      'every client response can be explained by some single order of the operations. Switch the build to a ' +
      'planted bug to see the other answer.';
  }

  el('diagram').innerHTML = diagram(sim, res);

  el('stats').innerHTML = [
    stat('nodes', String(sim.config.nodes)),
    stat('leader changes', String(sim.stats.leaderChanges)),
    stat('messages', sim.stats.messagesSent.toLocaleString()),
    stat('dropped', sim.stats.messagesDropped.toLocaleString()),
    stat('never answered', String(sim.stats.unfinished)),
    stat('simulated ticks', sim.stats.ticks.toLocaleString()),
  ].join('');

  el('permalink').setAttribute('href', urlFor(s));
  const url = new URL(window.location.href);
  url.search = new URL(urlFor(s)).search;
  window.history.replaceState(null, '', url.toString());
  el('error').hidden = true;
}

/** @param {string} k @param {string} v */
function stat(k, v) {
  return '<div class="stat"><dt>' + k + '</dt><dd>' + v + '</dd></div>';
}

/** @param {string} message */
function showError(message) {
  const e = el('error');
  e.hidden = false;
  e.textContent = message;
}

// --------------------------------------------------------------------------
// The real-Jepsen panel. Two histories vendored from Porcupine's test data,
// with the verdicts Porcupine publishes for them, checked live in the page.

function renderSamples() {
  /** @type {any} */
  const samples = /** @type {any} */ (window).KEDGE_SAMPLES || {};
  const rows = [];
  for (const file of Object.keys(samples)) {
    const s = samples[file];
    const t0 = performance.now();
    const history = parseJepsenLog(s.text, { source: file });
    const res = check(etcdRegisterModel, history, { budget: 4000000 });
    const ms = Math.round(performance.now() - t0);
    const agrees = res.verdict === s.expected;
    rows.push(
      '<tr><td><code>' + file + '</code></td>' +
        '<td>' + history.length + '</td>' +
        '<td>' + s.expected + '</td>' +
        '<td>' + res.verdict + '</td>' +
        '<td>' + res.steps.toLocaleString() + '</td>' +
        '<td>' + ms + ' ms</td>' +
        '<td class="' + (agrees ? 'agree' : 'disagree') + '">' + (agrees ? 'agrees' : 'DISAGREES') + '</td></tr>'
    );
  }
  el('samples-body').innerHTML = rows.join('');
}

// --------------------------------------------------------------------------

function init() {
  const buildSelect = /** @type {HTMLSelectElement} */ (el('build'));
  buildSelect.innerHTML =
    '<option value="correct">correct build</option>' +
    BUGS.filter((b) => b.target === 'raft')
      .map((b) => '<option value="' + b.id + '">' + b.id + '</option>')
      .join('');

  const faultSelect = /** @type {HTMLSelectElement} */ (el('faults'));
  faultSelect.innerHTML = FAULT_PRESETS.map(
    (f) => '<option value="' + escapeXml(f.value) + '">' + escapeXml(f.label) + '</option>'
  ).join('');

  const s = stateFromUrl();
  /** @type {HTMLInputElement} */ (el('seed')).value = String(s.seed);
  buildSelect.value = s.build === '' ? 'correct' : s.build;
  if (!FAULT_PRESETS.some((f) => f.value === s.faults)) {
    faultSelect.innerHTML +=
      '<option value="' + escapeXml(s.faults) + '">' + escapeXml(s.faults) + ' (from link)</option>';
  }
  faultSelect.value = s.faults;

  const current = () => ({
    seed: Number.parseInt(/** @type {HTMLInputElement} */ (el('seed')).value, 10) || 0,
    faults: faultSelect.value,
    build: buildSelect.value,
    ops: s.ops,
  });

  const rerun = () => runAndRender(current());
  el('seed').addEventListener('change', rerun);
  faultSelect.addEventListener('change', rerun);
  buildSelect.addEventListener('change', rerun);
  el('reroll').addEventListener('click', () => {
    // The one place a random number is welcome: choosing which deterministic
    // execution to look at next.
    const next = Math.floor(Math.random() * 100000);
    /** @type {HTMLInputElement} */ (el('seed')).value = String(next);
    rerun();
  });
  el('hunt').addEventListener('click', () => {
    const base = current();
    let flags;
    try {
      flags = base.build === 'correct' ? correctBuild() : parseBuildFlags(base.build);
    } catch {
      return;
    }
    for (let i = 0; i < 300; i++) {
      const seed = base.seed + 1 + i;
      const sim = runSimulation({
        seed,
        faults: base.faults,
        operations: base.ops,
        clients: 4,
        nodes: 5,
        keys: 1,
        maxEntriesPerAppend: base.build === 'stale-term-commit' ? 1 : 8,
        flags,
      });
      if (check(kvRegisterModel, sim.history, { budget: 2000000 }).verdict === 'not-linearizable') {
        /** @type {HTMLInputElement} */ (el('seed')).value = String(seed);
        rerun();
        return;
      }
    }
    showError(
      'searched 300 seeds from ' + (base.seed + 1) + ' and found no violation with this build and fault script. ' +
        'On the correct build that is the expected answer.'
    );
  });

  runAndRender(s);
  try {
    renderSamples();
  } catch (err) {
    el('samples-body').innerHTML =
      '<tr><td colspan="7">could not check the vendored histories: ' +
      escapeXml(/** @type {Error} */ (err).message) + '</td></tr>';
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
