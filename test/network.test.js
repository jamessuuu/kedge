// Fault scripts, partitions, crash-stop, and the `L` (current leader) target.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../src/sim/scheduler.js';
import { Rng } from '../src/sim/rng.js';
import { Network, parseFaultScript, formatFaultScript } from '../src/sim/network.js';

test('fault scripts parse', () => {
  assert.deepEqual(parseFaultScript(''), []);
  assert.deepEqual(parseFaultScript(undefined), []);
  const one = parseFaultScript('150-450:0.1');
  assert.equal(one.length, 1);
  assert.equal(one[0].kind, 'partition');
  assert.equal(one[0].start, 150);
  assert.equal(one[0].end, 450);
  assert.deepEqual(one[0].spec, [0, 1]);

  const crash = parseFaultScript('c200-400:3');
  assert.equal(crash[0].kind, 'crash');
  assert.deepEqual(crash[0].spec, [3]);

  const leader = parseFaultScript('150-700:L');
  assert.deepEqual(leader[0].spec, ['L']);

  assert.equal(parseFaultScript('10-20:0,c30-40:1.2').length, 2);
});

test('a fault script round-trips through formatting', () => {
  const text = '150-450:0.1,c200-400:3,10-20:L';
  assert.equal(formatFaultScript(parseFaultScript(text)), text);
});

test('malformed fault scripts are refused with a usable message', () => {
  for (const bad of ['garbage', '150:0', '150-450', 'x150-450:0', '450-150:0', '150-450:', '150-450:z', '-5-10:0']) {
    assert.throws(() => parseFaultScript(bad), /invalid fault/, 'accepted "' + bad + '"');
  }
  assert.throws(() => parseFaultScript('450-450:0'), /end must be greater than start/);
});

test('a partition cuts across the group boundary and nowhere else', () => {
  const sched = new Scheduler();
  const net = new Network({ sched, rng: new Rng(1), faults: parseFaultScript('10-20:0.1') });
  sched.on('probe', () => {});
  // isPartitioned reads sched.now, so drive time with a real event.
  const at = (tick, a, b) => {
    sched.now = tick;
    return net.isPartitioned(a, b);
  };
  assert.equal(at(5, 0, 2), false, 'before the window');
  assert.equal(at(10, 0, 2), true, 'start is inclusive');
  assert.equal(at(19, 1, 4), true);
  assert.equal(at(15, 0, 1), false, 'inside the group');
  assert.equal(at(15, 2, 3), false, 'outside the group');
  assert.equal(at(20, 0, 2), false, 'end is exclusive');
});

test('a crash takes a node off the network entirely', () => {
  const sched = new Scheduler();
  const net = new Network({ sched, rng: new Rng(1), faults: parseFaultScript('c10-20:3') });
  sched.now = 15;
  assert.equal(net.isDown(3), true);
  assert.equal(net.isDown(2), false);
  sched.now = 25;
  assert.equal(net.isDown(3), false);
});

test('the L target resolves once, at the tick the fault opens', () => {
  const sched = new Scheduler();
  let leader = 2;
  const net = new Network({
    sched,
    rng: new Rng(1),
    faults: parseFaultScript('10-30:L'),
    leaderLookup: () => leader,
  });
  sched.now = 12;
  assert.equal(net.isPartitioned(2, 0), true, 'the leader is cut off');
  leader = 4; // leadership moves
  sched.now = 20;
  assert.equal(net.isPartitioned(2, 0), true, 'the fault stays pinned to the node it opened on');
  assert.equal(net.isPartitioned(4, 0), false);
});

test('L resolving to no leader targets nothing rather than a random node', () => {
  const sched = new Scheduler();
  const net = new Network({ sched, rng: new Rng(1), faults: parseFaultScript('10-30:L'), leaderLookup: () => null });
  sched.now = 12;
  assert.equal(net.isPartitioned(0, 1), false);
  assert.deepEqual(net.describe()[0].group, []);
});

test('messages are delivered after a seeded delay and dropped across a cut', () => {
  const sched = new Scheduler();
  const net = new Network({ sched, rng: new Rng(7), faults: parseFaultScript('100-200:0.1') });
  const got = [];
  net.deliver = (from, to, msg) => got.push([from, to, msg.n]);
  net.send(0, 2, { n: 'early' });
  sched.run({ untilTick: 50 });
  assert.equal(got.length, 1, 'delivered before the cut opens');

  sched.now = 100;
  net.send(0, 2, { n: 'during' });
  sched.run({ untilTick: 150 });
  assert.equal(got.length, 1, 'dropped during the cut');
  assert.equal(net.dropped, 1);
});

test('delivery is checked at arrival, so a cut drops packets already in flight', () => {
  const sched = new Scheduler();
  const net = new Network({
    sched,
    rng: new Rng(3),
    faults: parseFaultScript('10-100:0.1'),
    minDelay: 20,
    maxDelay: 20,
  });
  let delivered = 0;
  net.deliver = () => delivered++;
  net.send(0, 3, {}); // sent at tick 0, arrives at 20, inside the cut
  sched.run();
  assert.equal(delivered, 0);
  assert.equal(net.dropped, 1);
});
