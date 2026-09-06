// The discrete-event scheduler: total ordering, tie-breaking, and the two
// ways a run can be made to stop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/sim/scheduler.js';

test('events fire in time order', () => {
  const s = new Scheduler();
  const seen = [];
  s.on('e', (p) => seen.push(p.n));
  s.after(30, 'e', { n: 'c' });
  s.after(10, 'e', { n: 'a' });
  s.after(20, 'e', { n: 'b' });
  s.run();
  assert.deepEqual(seen, ['a', 'b', 'c']);
});

test('ties break by insertion order, so the run is a total order', () => {
  const s = new Scheduler();
  const seen = [];
  s.on('e', (p) => seen.push(p.n));
  for (let i = 0; i < 50; i++) s.after(5, 'e', { n: i });
  s.run();
  assert.deepEqual(seen, Array.from({ length: 50 }, (_, i) => i));
});

test('logical time advances to the event, never past it', () => {
  const s = new Scheduler();
  const times = [];
  s.on('e', (_p, sched) => times.push(sched.now));
  s.after(7, 'e', {});
  s.after(19, 'e', {});
  s.run();
  assert.deepEqual(times, [7, 19]);
  assert.equal(s.now, 19);
});

test('nested scheduling is relative to the firing event, not to zero', () => {
  const s = new Scheduler();
  const times = [];
  let n = 0;
  s.on('tick', (_p, sched) => {
    times.push(sched.now);
    if (++n < 4) sched.after(10, 'tick', {});
  });
  s.after(10, 'tick', {});
  s.run();
  assert.deepEqual(times, [10, 20, 30, 40]);
});

test('cancelled events do not fire', () => {
  const s = new Scheduler();
  let fired = 0;
  s.on('e', () => fired++);
  const ev = s.after(5, 'e', {});
  s.after(6, 'e', {});
  s.cancel(ev);
  s.run();
  assert.equal(fired, 1);
});

test('stop() ends a run that would otherwise never drain', () => {
  const s = new Scheduler();
  let n = 0;
  s.on('forever', (_p, sched) => {
    n++;
    sched.after(1, 'forever', {});
    if (n === 25) sched.stop();
  });
  s.after(1, 'forever', {});
  const info = s.run({ maxSteps: 1000000 });
  assert.equal(n, 25);
  assert.equal(info.endedBecause, 'stopped');
});

test('the step budget ends a runaway simulation', () => {
  const s = new Scheduler();
  s.on('forever', (_p, sched) => sched.after(1, 'forever', {}));
  s.after(1, 'forever', {});
  const info = s.run({ maxSteps: 200 });
  assert.equal(info.endedBecause, 'step-budget');
  assert.equal(info.steps, 200);
});

test('untilTick stops the run and leaves the queue intact', () => {
  const s = new Scheduler();
  const seen = [];
  s.on('e', (p) => seen.push(p.n));
  s.after(5, 'e', { n: 1 });
  s.after(50, 'e', { n: 2 });
  const info = s.run({ untilTick: 10 });
  assert.deepEqual(seen, [1]);
  assert.equal(info.endedBecause, 'deadline');
  s.run();
  assert.deepEqual(seen, [1, 2]);
});

test('scheduling an unhandled kind fails loudly at schedule time', () => {
  const s = new Scheduler();
  assert.throws(() => s.after(1, 'nobody-listens', {}), /no handler registered/);
});

test('a duplicate handler for one kind is refused', () => {
  const s = new Scheduler();
  s.on('e', () => {});
  assert.throws(() => s.on('e', () => {}), /duplicate handler/);
});

test('a negative or fractional delay is refused', () => {
  const s = new Scheduler();
  s.on('e', () => {});
  assert.throws(() => s.after(-1, 'e', {}), /non-negative integer/);
  assert.throws(() => s.after(0.5, 'e', {}), /non-negative integer/);
});
