// Planted fixtures and the negative control.
//
// "It found bugs" is worth nothing on its own -- a checker that fires at random
// would say the same. The pair of claims that mean something is:
//   every planted bug is caught, AND the correct build is never accused.

import test from 'node:test';
import assert from 'node:assert/strict';
import { runSimulation } from '../src/raft/cluster.js';
import { check } from '../src/lin/wgl.js';
import { kvRegisterModel } from '../src/lin/models.js';
import { parseBuildFlags, correctBuild, BUGS } from '../src/bugs.js';
import { FIXTURES, NEGATIVE_CONTROL } from '../src/fixtures.js';

const BUDGET = 2000000;

test('every declared bug has a fixture that exercises it', () => {
  const covered = new Set(FIXTURES.map((f) => f.id));
  covered.add('checker-accept-on-block'); // covered by sabotage.test.js
  for (const b of BUGS) {
    assert.ok(covered.has(b.id), 'bug "' + b.id + '" has no fixture');
  }
});

for (const f of FIXTURES) {
  test('fixture fires: ' + f.id + ' — ' + f.title, () => {
    let violations = 0;
    let controlViolations = 0;
    let unknown = 0;
    for (const seed of f.seeds) {
      const buggy = runSimulation({ ...f.sim, seed, flags: parseBuildFlags(f.id) });
      const r = check(kvRegisterModel, buggy.history, { budget: BUDGET });
      if (r.verdict === 'not-linearizable') {
        violations++;
        assert.ok(r.witness, f.id + ' seed ' + seed + ': a violation with no witness is not useful');
      } else if (r.verdict === 'unknown') unknown++;

      const control = runSimulation({ ...f.sim, seed, flags: correctBuild() });
      const cr = check(kvRegisterModel, control.history, { budget: BUDGET });
      if (cr.verdict === 'not-linearizable') controlViolations++;
    }
    assert.equal(
      controlViolations,
      0,
      f.id + ': the CORRECT build was accused on ' + controlViolations + ' of its own seeds, so ' +
        'this fixture proves nothing'
    );
    assert.ok(
      violations >= f.minViolations,
      f.id + ': only ' + violations + ' of ' + f.seeds.length + ' seeds violated, floor is ' + f.minViolations
    );
    assert.equal(unknown, 0, f.id + ': ' + unknown + ' runs exhausted the budget');
  });
}

test('negative control: the correct build is never accused', () => {
  let runs = 0;
  let violations = 0;
  let unknown = 0;
  const accused = [];
  for (const script of NEGATIVE_CONTROL.scripts) {
    for (const seed of NEGATIVE_CONTROL.seeds) {
      runs++;
      const sim = runSimulation({
        ...NEGATIVE_CONTROL.sim,
        seed,
        faults: script,
        flags: correctBuild(),
      });
      const r = check(kvRegisterModel, sim.history, { budget: BUDGET });
      if (r.verdict === 'not-linearizable') {
        violations++;
        if (accused.length < 5) accused.push('seed ' + seed + ' faults "' + script + '"');
      } else if (r.verdict === 'unknown') unknown++;
    }
  }
  assert.equal(runs, NEGATIVE_CONTROL.scripts.length * NEGATIVE_CONTROL.seeds.length);
  assert.deepEqual(accused, [], 'false positives on the correct build');
  assert.equal(violations, 0);
  assert.equal(unknown, 0, unknown + ' control runs exhausted the budget');
});

test('the negative control really does exercise more than one key', () => {
  const sim = runSimulation({ ...NEGATIVE_CONTROL.sim, seed: 1, faults: '', flags: correctBuild() });
  const res = check(kvRegisterModel, sim.history, { budget: BUDGET });
  assert.ok(res.partitions > 1, 'P-compositionality is a no-op with one key');
});

test('an unknown build flag is refused rather than ignored', () => {
  assert.throws(() => parseBuildFlags('not-a-real-bug'), /unknown build flag/);
  assert.throws(() => parseBuildFlags('deposed-leader-read,typo'), /unknown build flag/);
});

test('the correct build declares no flags', () => {
  assert.deepEqual(correctBuild().enabled, []);
  assert.deepEqual(parseBuildFlags('').enabled, []);
  assert.deepEqual(parseBuildFlags(undefined).enabled, []);
});
