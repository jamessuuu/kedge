// The seeded generator: same seed, same stream, on every engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Rng } from '../src/sim/rng.js';

test('the same seed produces the same stream', () => {
  const a = new Rng(4711);
  const b = new Rng(4711);
  const xs = [];
  const ys = [];
  for (let i = 0; i < 1000; i++) {
    xs.push(a.nextUint32());
    ys.push(b.nextUint32());
  }
  assert.deepEqual(xs, ys);
});

test('different seeds diverge immediately', () => {
  const a = new Rng(1);
  const b = new Rng(2);
  const first = [];
  for (let i = 0; i < 8; i++) first.push(a.nextUint32() === b.nextUint32());
  assert.ok(first.some((same) => !same), 'seeds 1 and 2 produced identical prefixes');
});

test('int() stays inside its bounds and covers them', () => {
  const r = new Rng(99);
  const seen = new Set();
  for (let i = 0; i < 5000; i++) {
    const v = r.int(3, 7);
    assert.ok(v >= 3 && v <= 7, 'out of range: ' + v);
    seen.add(v);
  }
  assert.deepEqual([...seen].sort(), [3, 4, 5, 6, 7]);
});

test('int() with lo === hi is the constant', () => {
  const r = new Rng(5);
  for (let i = 0; i < 10; i++) assert.equal(r.int(2, 2), 2);
});

test('hostile arguments fail with a stated error, not a stack of NaN', () => {
  assert.throws(() => new Rng(/** @type {any} */ ('nope')), /seed must be an integer/);
  assert.throws(() => new Rng(1.5), /seed must be an integer/);
  assert.throws(() => new Rng(/** @type {any} */ (undefined)), /seed must be an integer/);
  assert.throws(() => new Rng(1).int(9, 2), /hi < lo/);
  assert.throws(() => new Rng(1).pick([]), /empty array/);
});

test('output is uint32, never a float or a negative', () => {
  const r = new Rng(31337);
  for (let i = 0; i < 2000; i++) {
    const v = r.nextUint32();
    assert.ok(Number.isInteger(v) && v >= 0 && v <= 0xffffffff, 'bad value ' + v);
  }
});

test('fork() derives an independent, reproducible generator', () => {
  const parent1 = new Rng(7);
  const parent2 = new Rng(7);
  const childA = parent1.fork();
  const childB = parent2.fork();
  assert.equal(childA.nextUint32(), childB.nextUint32());
  const other = new Rng(7).fork().fork();
  assert.notEqual(other.seed, childA.seed);
});
