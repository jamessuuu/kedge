// The headline claim, asserted rather than described.
//
// 103 Jepsen etcd histories ship with Porcupine. 102 of them carry a published
// verdict in porcupine_test.go; etcd_095.log is empty, because that run's etcd
// cluster failed to start, and Porcupine asserts nothing about it either.
// kedge must match all 102. Anything less and the README's number is wrong.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJepsenLog } from '../src/io/jepsen.js';
import { check } from '../src/lin/wgl.js';
import { etcdRegisterModel } from '../src/lin/models.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDOR = path.resolve(HERE, '..', 'vendor', 'porcupine');
const expected = JSON.parse(fs.readFileSync(path.join(VENDOR, 'expected.json'), 'utf8'));

/** @param {number} budget */
function runCorpus(budget) {
  let match = 0;
  let mismatch = 0;
  let unknown = 0;
  let maxSteps = 0;
  const wrong = [];
  for (const h of expected.histories) {
    if (h.expected === null) continue;
    const text = fs.readFileSync(path.join(VENDOR, 'jepsen', h.file), 'utf8');
    const history = parseJepsenLog(text, { source: h.file });
    const res = check(etcdRegisterModel, history, { budget });
    maxSteps = Math.max(maxSteps, res.steps);
    if (res.verdict === 'unknown') unknown++;
    else if (res.verdict === h.expected) match++;
    else {
      mismatch++;
      wrong.push(h.file + ': expected ' + h.expected + ', got ' + res.verdict);
    }
  }
  return { match, mismatch, unknown, maxSteps, wrong };
}

test('the vendored corpus is intact', () => {
  assert.equal(expected.total_logs, 103);
  assert.equal(expected.logs_with_published_verdict, 102);
  assert.equal(expected.linearizable, 23);
  assert.equal(expected.not_linearizable, 79);
  const files = fs.readdirSync(path.join(VENDOR, 'jepsen')).filter((f) => f.endsWith('.log'));
  assert.equal(files.length, 103);
  assert.ok(fs.existsSync(path.join(VENDOR, 'PORCUPINE-LICENSE.md')), 'the MIT licence must ship with the data');
});

test('kedge matches Porcupine on all 102 published verdicts', () => {
  const r = runCorpus(4000000);
  assert.deepEqual(r.wrong, [], 'verdict mismatches against Porcupine');
  assert.equal(r.mismatch, 0);
  assert.equal(r.unknown, 0, 'no history should exhaust a 4,000,000-step budget');
  assert.equal(r.match, 102);
});

test('the hardest history in the corpus needs under 1.2M steps', () => {
  // Recorded so a change that makes the search dramatically worse is caught,
  // not discovered later by a visitor whose browser tab hangs.
  const r = runCorpus(4000000);
  assert.ok(r.maxSteps < 1200000, 'worst-case steps regressed to ' + r.maxSteps);
});

test('a small budget yields unknown, and STILL never a wrong verdict', () => {
  // The three-outcome contract's whole claim: under pressure the checker gives
  // up, it does not guess. Measured at budget 1,000: 82 match, 20 unknown, 0 wrong.
  const r = runCorpus(1000);
  assert.equal(r.mismatch, 0, 'a starved checker produced a WRONG verdict: ' + r.wrong.join('; '));
  assert.ok(r.unknown > 0, 'budget 1000 should exhaust on at least one history');
  assert.equal(r.match + r.unknown, 102);
});
