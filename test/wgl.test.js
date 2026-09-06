// The linearizability checker, on histories small enough to reason about by
// hand -- so that a failure here points at a line rather than at a corpus.
import test from 'node:test';
import assert from 'node:assert/strict';
import { check, checkPartition } from '../src/lin/wgl.js';
import { validateHistory, partitionByKey, maxConcurrency } from '../src/lin/history.js';
import { kvRegisterModel } from '../src/lin/models.js';

/**
 * Build a history from a compact spec.
 * @param {Array<[number, string, any, any, number, number]>} rows
 *   [clientId, op, input, output, callPos, retPos]
 */
function hist(rows, key = 'x') {
  return rows.map((r, i) => ({
    id: i,
    clientId: r[0],
    key: typeof r[1] === 'string' && r[1].includes(':') ? r[1].split(':')[1] : key,
    input: r[2],
    output: r[3],
    call: r[4],
    ret: r[5],
  }));
}

const put = (v) => ({ op: 'put', value: v });
const get = () => ({ op: 'get' });
const read = (v) => ({ value: v });
const ok = () => ({});

test('a sequential, consistent history is linearizable', () => {
  const h = hist([
    [0, 'a', put('1'), ok(), 0, 1],
    [0, 'a', get(), read('1'), 2, 3],
    [0, 'a', put('2'), ok(), 4, 5],
    [0, 'a', get(), read('2'), 6, 7],
  ]);
  assert.equal(check(kvRegisterModel, h).verdict, 'linearizable');
});

test('a read of a value that was never written is not linearizable', () => {
  const h = hist([
    [0, 'a', put('1'), ok(), 0, 1],
    [0, 'a', get(), read('9'), 2, 3],
  ]);
  const res = check(kvRegisterModel, h);
  assert.equal(res.verdict, 'not-linearizable');
  assert.ok(res.witness, 'a violation must carry a witness');
});

test('a read that goes backwards after a completed write is not linearizable', () => {
  // put(1) completes, put(2) completes, then a read returns 1 with nothing
  // concurrent that could reorder it.
  const h = hist([
    [0, 'a', put('1'), ok(), 0, 1],
    [0, 'a', put('2'), ok(), 2, 3],
    [1, 'a', get(), read('1'), 4, 5],
  ]);
  assert.equal(check(kvRegisterModel, h).verdict, 'not-linearizable');
});

test('concurrency is exploited: overlapping operations may be reordered', () => {
  // put(2) overlaps the read, so the read of "1" can linearize before it.
  const h = hist([
    [0, 'a', put('1'), ok(), 0, 1],
    [0, 'a', put('2'), ok(), 2, 5],
    [1, 'a', get(), read('1'), 3, 4],
  ]);
  assert.equal(check(kvRegisterModel, h).verdict, 'linearizable');
});

test('an operation whose response is unknown may take effect anywhere', () => {
  const h = hist([
    [0, 'a', put('1'), ok(), 0, 1],
    [1, 'a', put('2'), { unknown: true }, 2, 7],
    [2, 'a', get(), read('1'), 3, 4],
    [2, 'a', get(), read('2'), 5, 6],
  ]);
  assert.equal(check(kvRegisterModel, h).verdict, 'linearizable');
});

test('the step budget produces unknown, never a wrong answer', () => {
  const rows = [];
  let pos = 0;
  // 24 mutually concurrent operations: a big search, deliberately.
  const n = 24;
  for (let i = 0; i < n; i++) rows.push([i, 'a', put('v' + i), ok(), pos++, 0]);
  for (let i = 0; i < n; i++) rows[i][5] = pos++;
  const h = hist(/** @type {any} */ (rows));
  const tiny = check(kvRegisterModel, h, { budget: 5 });
  assert.equal(tiny.verdict, 'unknown');
  assert.ok(tiny.steps <= 5 + n, 'unknown must be reported at the budget, not far past it');
});

test('unknown is not a pass: it is reported distinctly from linearizable', () => {
  const rows = [];
  let pos = 0;
  for (let i = 0; i < 12; i++) rows.push([i, 'a', put('v' + i), ok(), pos++, 0]);
  for (let i = 0; i < 12; i++) rows[i][5] = pos++;
  const h = hist(/** @type {any} */ (rows));
  assert.equal(check(kvRegisterModel, h, { budget: 3 }).verdict, 'unknown');
  assert.equal(check(kvRegisterModel, h, { budget: 4000000 }).verdict, 'linearizable');
});

test('P-compositionality: independent keys are checked independently', () => {
  const h = [
    { id: 0, clientId: 0, key: 'x', input: put('1'), output: ok(), call: 0, ret: 1 },
    { id: 1, clientId: 0, key: 'y', input: put('7'), output: ok(), call: 2, ret: 3 },
    { id: 2, clientId: 0, key: 'x', input: get(), output: read('1'), call: 4, ret: 5 },
    { id: 3, clientId: 0, key: 'y', input: get(), output: read('7'), call: 6, ret: 7 },
  ];
  const res = check(kvRegisterModel, h);
  assert.equal(res.verdict, 'linearizable');
  assert.equal(res.partitions, 2);
  assert.deepEqual(res.perPartition.map((p) => p.key), ['x', 'y']);
});

test('P-compositionality: one bad key condemns the whole history', () => {
  const h = [
    { id: 0, clientId: 0, key: 'x', input: put('1'), output: ok(), call: 0, ret: 1 },
    { id: 1, clientId: 0, key: 'y', input: put('7'), output: ok(), call: 2, ret: 3 },
    { id: 2, clientId: 0, key: 'y', input: get(), output: read('nope'), call: 4, ret: 5 },
  ];
  const res = check(kvRegisterModel, h);
  assert.equal(res.verdict, 'not-linearizable');
  assert.equal(/** @type {any} */ (res.witness).key, 'y');
});

test('a key whose sub-history is fine does not mask one that is not', () => {
  // Interleaved on purpose: the violation is on 'y' while 'x' is clean.
  const h = [
    { id: 0, clientId: 0, key: 'x', input: put('1'), output: ok(), call: 0, ret: 1 },
    { id: 1, clientId: 1, key: 'y', input: put('a'), output: ok(), call: 2, ret: 3 },
    { id: 2, clientId: 0, key: 'x', input: get(), output: read('1'), call: 4, ret: 5 },
    { id: 3, clientId: 1, key: 'y', input: put('b'), output: ok(), call: 6, ret: 7 },
    { id: 4, clientId: 1, key: 'y', input: get(), output: read('a'), call: 8, ret: 9 },
  ];
  assert.equal(check(kvRegisterModel, h).verdict, 'not-linearizable');
});

test('the empty history is linearizable', () => {
  assert.equal(check(kvRegisterModel, []).verdict, 'linearizable');
});

test('a single operation is linearizable', () => {
  assert.equal(check(kvRegisterModel, hist([[0, 'a', put('1'), ok(), 0, 1]])).verdict, 'linearizable');
});

test('the verdict does not depend on key insertion order', () => {
  const a = [
    { id: 0, clientId: 0, key: 'y', input: put('1'), output: ok(), call: 0, ret: 1 },
    { id: 1, clientId: 0, key: 'x', input: put('2'), output: ok(), call: 2, ret: 3 },
  ];
  const b = [a[1], a[0]];
  assert.deepEqual(
    check(kvRegisterModel, a).perPartition.map((p) => p.key),
    check(kvRegisterModel, b).perPartition.map((p) => p.key)
  );
});

test('malformed histories are rejected with a stated error', () => {
  assert.throws(() => validateHistory(/** @type {any} */ ('not an array')), /must be an array/);
  assert.throws(() => validateHistory(/** @type {any} */ ([null])), /not an object/);
  assert.throws(
    () =>
      validateHistory(
        /** @type {any} */ ([{ id: 'x', clientId: 0, key: 'x', input: {}, output: {}, call: 0, ret: 1 }])
      ),
    /id must be an integer/
  );
  assert.throws(
    () =>
      validateHistory(
        /** @type {any} */ ([{ id: 0, clientId: 0, key: 1, input: {}, output: {}, call: 0, ret: 1 }])
      ),
    /key must be a string/
  );
  assert.throws(
    () => validateHistory([{ id: 0, clientId: 0, key: 'x', input: {}, output: {}, call: 5, ret: 5 }]),
    /must come after call position/
  );
  assert.throws(
    () =>
      validateHistory([
        { id: 0, clientId: 0, key: 'x', input: {}, output: {}, call: 0, ret: 1 },
        { id: 0, clientId: 0, key: 'x', input: {}, output: {}, call: 2, ret: 3 },
      ]),
    /duplicate operation id/
  );
  assert.throws(
    () =>
      validateHistory([
        { id: 0, clientId: 0, key: 'x', input: {}, output: {}, call: 0, ret: 1 },
        { id: 1, clientId: 0, key: 'x', input: {}, output: {}, call: 1, ret: 3 },
      ]),
    /duplicate event position/
  );
});

test('a non-positive budget is refused rather than silently defaulted', () => {
  assert.throws(() => check(kvRegisterModel, [], { budget: 0 }), /positive integer/);
  assert.throws(() => check(kvRegisterModel, [], { budget: -5 }), /positive integer/);
  assert.throws(() => check(kvRegisterModel, [], { budget: /** @type {any} */ (1.5) }), /positive integer/);
});

test('an unknown operation in a model fails loudly', () => {
  const h = hist([[0, 'a', { op: 'frobnicate' }, ok(), 0, 1]]);
  assert.throws(() => check(kvRegisterModel, h), /unknown operation/);
});

test('history helpers', () => {
  const h = hist([
    [0, 'a', put('1'), ok(), 0, 3],
    [1, 'a', put('2'), ok(), 1, 2],
  ]);
  assert.equal(maxConcurrency(h), 2);
  assert.equal(partitionByKey(h).size, 1);
  assert.equal(checkPartition(kvRegisterModel, [], 10, undefined).verdict, 'linearizable');
});
