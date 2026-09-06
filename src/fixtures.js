// Reproduction recipes for the planted fixtures, and the negative control.
//
// One source of truth shared by `node src/cli.js fixtures`, the test suite and
// the README, so the numbers in the README cannot drift away from the numbers
// the tests assert.
//
// `minViolations` is a FLOOR asserted by CI, deliberately set below the
// measured rate. The measured rate is recorded next to it with the date, and
// both come from `node src/cli.js fixtures`. Nothing here is a guess.

/**
 * @typedef {object} Fixture
 * @property {string} id build flag under test
 * @property {string} title
 * @property {object} sim simulation options shared by the buggy and control runs
 * @property {number[]} seeds
 * @property {number} minViolations floor CI asserts for the buggy build
 * @property {number} measured violations actually observed, see MEASURED_ON
 * @property {string} note
 */

export const MEASURED_ON = '2026-09-06';

/** @param {number} from @param {number} to @returns {number[]} */
function range(from, to) {
  const out = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
}

const PARTITION_PAIR = '200-500:0.1,600-900:2.3';
const ISOLATE_LEADER = '150-700:L';
const CRASH_CHURN = 'c120-200:L,c220-300:L,c320-400:L,c420-500:L,c520-600:L,c620-700:L';

/** @type {Fixture[]} */
export const FIXTURES = [
  {
    id: 'deposed-leader-read',
    title: 'A partitioned leader keeps answering reads',
    sim: { faults: ISOLATE_LEADER, operations: 60, clients: 4, keys: 1 },
    seeds: range(1, 60),
    minViolations: 35,
    measured: 49,
    note:
      'Isolating the leader for 550 ticks is the whole recipe: the majority elects a successor and ' +
      'moves on while the old leader, which never learns it was deposed, serves values from its own ' +
      'state machine.',
  },
  {
    id: 'vote-without-log-check',
    title: 'A node with a stale log wins an election',
    sim: { faults: PARTITION_PAIR, operations: 60, clients: 4, keys: 1 },
    seeds: range(1, 60),
    minViolations: 20,
    measured: 32,
    note:
      'Two successive partitions on different cuts leave the cluster with divergent logs. Without ' +
      'the §5.4.1 election restriction a node that missed the writes can win the next term and ' +
      'truncate them off everyone who had them.',
  },
  {
    id: 'minority-election',
    title: 'Two leaders in one term',
    sim: { faults: PARTITION_PAIR, operations: 60, clients: 4, keys: 1 },
    seeds: range(1, 60),
    minViolations: 5,
    measured: 10,
    note:
      'On a 2/3 cut the minority side can also reach 2 votes, so both sides elect and both accept ' +
      'writes. Fires less often than it sounds like it should, because the minority leader has to ' +
      'be reached by a client before the partition heals.',
  },
  {
    id: 'stale-term-commit',
    title: 'Raft figure 8: an acknowledged write is lost',
    sim: { faults: CRASH_CHURN, operations: 60, clients: 4, keys: 1, maxEntriesPerAppend: 1 },
    // Pinned seeds, not a range, and the reason is itself a finding: the window
    // in which an old-term entry holds a majority while THIS term's no-op does
    // not is about one heartbeat wide. Scanning seeds 1..32082 under this fault
    // script produced 7 reproductions -- roughly 1 in 4,600 crash schedules.
    // That rarity is exactly why §5.4.2 exists: it is a rule you do not arrive
    // at by testing, which is why Ongaro needed a figure to argue for it. So
    // the fixture pins schedules known to hit it rather than pretending a seed
    // range would.
    seeds: [2932, 10119, 13427, 15529, 15838, 17452, 32082],
    minViolations: 7,
    measured: 7,
    note:
      'Needs an AppendEntries batch of 1. With larger batches a follower acks the old-term entry ' +
      'and the current term’s no-op in the same message and never sits in the dangerous state, so ' +
      'the window closes entirely.',
  },
];

/**
 * The negative control. Same harness, same fault scripts, correct build: any
 * violation here means kedge is reporting bugs that are not there, and every
 * "it found a bug" claim above is worthless.
 */
export const NEGATIVE_CONTROL = {
  seeds: range(1, 200),
  scripts: ['', ISOLATE_LEADER, PARTITION_PAIR, CRASH_CHURN],
  sim: { operations: 60, clients: 4, keys: 3 },
  measured: { runs: 800, violations: 0, unknown: 0 },
  note:
    'Four fault scripts x 200 seeds = 800 executions, three keys so P-compositionality is exercised ' +
    'rather than being a no-op.',
};
