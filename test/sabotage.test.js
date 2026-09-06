// The fixture that matters most.
//
// Four of kedge's planted bugs break the Raft implementation and the checker
// catches them. That says nothing about the checker's "not-linearizable" path
// being CORRECT -- only that it fires. This fixture breaks the checker itself
// and asserts that kedge then WRONGLY passes histories Porcupine calls
// non-linearizable. If this test ever goes green with the flag off, the
// rejection path has stopped carrying its own weight and every other verdict
// in the project is suspect.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJepsenLog } from '../src/io/jepsen.js';
import { check } from '../src/lin/wgl.js';
import { etcdRegisterModel, kvRegisterModel } from '../src/lin/models.js';
import { runSimulation } from '../src/raft/cluster.js';
import { parseBuildFlags } from '../src/bugs.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.resolve(HERE, '..', 'vendor', 'porcupine');
const expected = JSON.parse(fs.readFileSync(path.join(VENDOR, 'expected.json'), 'utf8'));
const BUDGET = 4000000;

/** @param {string} file */
function load(file) {
  return parseJepsenLog(fs.readFileSync(path.join(VENDOR, 'jepsen', file), 'utf8'), { source: file });
}

const nonLinearizable = expected.histories
  .filter((/** @type {any} */ h) => h.expected === 'not-linearizable')
  .slice(0, 12)
  .map((/** @type {any} */ h) => h.file);

test('the sabotaged checker wrongly passes real non-linearizable histories', () => {
  assert.ok(nonLinearizable.length >= 12, 'need real targets, not fixtures');
  for (const file of nonLinearizable) {
    const history = load(file);
    const honest = check(etcdRegisterModel, history, { budget: BUDGET });
    assert.equal(honest.verdict, 'not-linearizable', file + ': the correct build must reject this');

    const sabotaged = check(etcdRegisterModel, history, {
      budget: BUDGET,
      sabotage: { acceptOnBlock: true },
    });
    assert.equal(
      sabotaged.verdict,
      'linearizable',
      file + ': the sabotage did not change the verdict, so the rejection path is not the thing ' +
        'producing it'
    );
  }
});

test('the sabotage cannot change a genuinely linearizable verdict', () => {
  // It only replaces the answer at the point the search has PROVEN failure, so
  // histories that linearize are unaffected. Asserting this keeps the fixture
  // honest: it is targeted at one branch, not a blanket "return true".
  const linearizable = expected.histories
    .filter((/** @type {any} */ h) => h.expected === 'linearizable')
    .slice(0, 8)
    .map((/** @type {any} */ h) => h.file);
  for (const file of linearizable) {
    const history = load(file);
    const a = check(etcdRegisterModel, history, { budget: BUDGET });
    const b = check(etcdRegisterModel, history, { budget: BUDGET, sabotage: { acceptOnBlock: true } });
    assert.equal(a.verdict, 'linearizable');
    assert.equal(b.verdict, 'linearizable');
    assert.equal(a.steps, b.steps, file + ': the sabotage changed the search, not just the answer');
  }
});

test('the sabotage flag also hides a simulated violation', () => {
  const flags = parseBuildFlags('deposed-leader-read,checker-accept-on-block');
  const sim = runSimulation({ seed: 4711, faults: '150-700:L', operations: 60, flags });
  const honest = check(kvRegisterModel, sim.history, { budget: BUDGET });
  const blind = check(kvRegisterModel, sim.history, {
    budget: BUDGET,
    sabotage: { acceptOnBlock: true },
  });
  assert.equal(honest.verdict, 'not-linearizable');
  assert.equal(blind.verdict, 'linearizable');
});
