// Determinism is the project's foundational claim, so it gets mechanical
// enforcement rather than a paragraph in the README.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSimulation } from '../src/raft/cluster.js';
import { check } from '../src/lin/wgl.js';
import { kvRegisterModel } from '../src/lin/models.js';
import { parseBuildFlags, correctBuild } from '../src/bugs.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'src');

/** @param {string} dir @returns {string[]} */
function jsFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFiles(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('nothing below the UI layer reads ambient state', () => {
  const banned = [
    { re: /Math\s*\.\s*random/, why: 'Math.random makes the run irreproducible' },
    { re: /Date\s*\.\s*now/, why: 'Date.now makes event time depend on the host' },
    { re: /performance\s*\.\s*now/, why: 'performance.now makes event time depend on the host' },
    { re: /\bsetTimeout\s*\(/, why: 'setTimeout is wall-clock scheduling' },
    { re: /\bsetInterval\s*\(/, why: 'setInterval is wall-clock scheduling' },
    { re: /new\s+Date\s*\(/, why: 'new Date reads the host clock' },
  ];
  const offences = [];
  for (const file of jsFiles(SRC)) {
    // cli.js is the UI layer: it may time its own output for the human reading it.
    if (path.basename(file) === 'cli.js') continue;
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
      for (const b of banned) {
        if (b.re.test(line)) {
          offences.push(path.relative(SRC, file) + ':' + (i + 1) + ' — ' + b.why);
        }
      }
    }
  }
  assert.deepEqual(offences, []);
});

test('the same seed produces a byte-identical history', () => {
  const opts = { seed: 4711, faults: '150-700:L', operations: 60, flags: parseBuildFlags('deposed-leader-read') };
  const a = runSimulation(opts);
  const b = runSimulation(opts);
  assert.equal(JSON.stringify(a.history), JSON.stringify(b.history));
  assert.deepEqual(a.stats, b.stats);
  assert.deepEqual(a.leaders, b.leaders);
});

test('the same seed produces the same verdict, witness and step count', () => {
  const opts = { seed: 4711, faults: '150-700:L', operations: 60, flags: parseBuildFlags('deposed-leader-read') };
  const a = check(kvRegisterModel, runSimulation(opts).history, { budget: 2000000 });
  const b = check(kvRegisterModel, runSimulation(opts).history, { budget: 2000000 });
  assert.equal(a.verdict, b.verdict);
  assert.equal(a.steps, b.steps);
  assert.equal(/** @type {any} */ (a.witness).text, /** @type {any} */ (b.witness).text);
});

test('different seeds produce different executions', () => {
  const base = { faults: '150-700:L', operations: 60, flags: correctBuild() };
  const a = runSimulation({ ...base, seed: 1 });
  const b = runSimulation({ ...base, seed: 2 });
  assert.notEqual(JSON.stringify(a.history), JSON.stringify(b.history));
});

test('an execution does not depend on how long the host takes', () => {
  // Run one simulation, then run another with a deliberate busy pause in
  // between. Wall-clock time moved; the execution must not have.
  const opts = { seed: 99, faults: 'c120-200:L,c220-300:L', operations: 40, flags: correctBuild() };
  const a = runSimulation(opts);
  let sink = 0;
  for (let i = 0; i < 5000000; i++) sink += i % 7;
  assert.ok(sink > 0);
  const b = runSimulation(opts);
  assert.equal(JSON.stringify(a.history), JSON.stringify(b.history));
  assert.equal(a.stats.ticks, b.stats.ticks);
});

test('simulation arguments are validated, not coerced', () => {
  assert.throws(() => runSimulation({ seed: /** @type {any} */ ('4711') }), /seed must be an integer/);
  assert.throws(() => runSimulation({ seed: 1, nodes: 4 }), /odd number/);
  assert.throws(() => runSimulation({ seed: 1, clients: 0 }), /clients must be >= 1/);
  assert.throws(() => runSimulation({ seed: 1, operations: 0 }), /operations must be >= 1/);
  assert.throws(() => runSimulation({ seed: 1, faults: 'garbage' }), /invalid fault/);
});
