// Planted fixtures.
//
// Every entry here is a real defect that a build flag switches on. They exist
// because a checker nobody has watched fail is decoration: the negative control
// (N seeds, correct build, zero violations) only means something if the same
// harness, with a flag flipped, reliably reports a violation.
//
// Four of them break the Raft implementation. The fifth breaks the CHECKER
// itself, which is the one that matters most -- it is the only way to prove
// that the "not-linearizable" verdict is produced by the search rather than by
// luck. See test/sabotage.test.js.
//
// Flags are passed explicitly through constructors. There is no global and no
// environment variable read below the CLI layer, because a global would make
// the simulation depend on ambient state and the whole project's claim is that
// it does not.

/**
 * @typedef {object} BugSpec
 * @property {string} id
 * @property {string} target 'raft' | 'checker'
 * @property {string} summary
 * @property {string} violates the invariant it breaks
 */

/** @type {BugSpec[]} */
export const BUGS = [
  {
    id: 'stale-term-commit',
    target: 'raft',
    summary:
      'The leader advances commitIndex as soon as a majority stores an entry, without checking that ' +
      'the entry belongs to the current term.',
    violates:
      'Raft §5.4.2. An entry replicated on a majority under an old term can still be overwritten, ' +
      'so a write reported as committed can be lost.',
  },
  {
    id: 'deposed-leader-read',
    target: 'raft',
    summary:
      'A node that still believes it is leader answers reads straight from its local state machine, ' +
      'skipping the quorum confirmation round.',
    violates:
      'Linearizability of reads. A leader isolated by a partition keeps serving values that the ' +
      'rest of the cluster has already overwritten.',
  },
  {
    id: 'minority-election',
    target: 'raft',
    summary: 'A candidate declares victory on a plurality of votes (2 of 5) instead of a majority (3 of 5).',
    violates:
      'Raft §5.2 election safety. Two leaders can exist in the same term on opposite sides of a ' +
      'partition, and both accept writes.',
  },
  {
    id: 'vote-without-log-check',
    target: 'raft',
    summary:
      'A follower grants its vote without checking that the candidate’s log is at least as ' +
      'up to date as its own.',
    violates:
      'Raft §5.4.1 the election restriction. A node with a stale log can win, then truncate ' +
      'committed entries off the followers that had them.',
  },
  {
    id: 'checker-accept-on-block',
    target: 'checker',
    summary:
      'The linearizability checker reports "linearizable" at the exact point where the search has ' +
      'proven no linearization exists.',
    violates:
      'The checker’s own rejection path. With this flag on, the suite asserts kedge WRONGLY ' +
      'passes a history Porcupine calls non-linearizable.',
  },
];

/** @type {Set<string>} */
export const BUG_IDS = new Set(BUGS.map((b) => b.id));

/**
 * @typedef {object} BuildFlags
 * @property {boolean} staleTermCommit
 * @property {boolean} deposedLeaderRead
 * @property {boolean} minorityElection
 * @property {boolean} voteWithoutLogCheck
 * @property {boolean} checkerAcceptOnBlock
 * @property {string[]} enabled
 */

/** @returns {BuildFlags} */
export function correctBuild() {
  return {
    staleTermCommit: false,
    deposedLeaderRead: false,
    minorityElection: false,
    voteWithoutLogCheck: false,
    checkerAcceptOnBlock: false,
    enabled: [],
  };
}

/**
 * Parse a comma-separated build-flag list.
 * @param {string|string[]|undefined|null} spec
 * @returns {BuildFlags}
 * @throws {Error} on an unknown flag -- silently ignoring one would let a test
 *   claim a bug fired when the build was in fact correct
 */
export function parseBuildFlags(spec) {
  const flags = correctBuild();
  if (spec === undefined || spec === null) return flags;
  const list = Array.isArray(spec)
    ? spec
    : String(spec)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
  for (const id of list) {
    if (!BUG_IDS.has(id)) {
      throw new Error(
        'unknown build flag "' + id + '"; known flags: ' + Array.from(BUG_IDS).sort().join(', ')
      );
    }
    if (id === 'stale-term-commit') flags.staleTermCommit = true;
    else if (id === 'deposed-leader-read') flags.deposedLeaderRead = true;
    else if (id === 'minority-election') flags.minorityElection = true;
    else if (id === 'vote-without-log-check') flags.voteWithoutLogCheck = true;
    else if (id === 'checker-accept-on-block') flags.checkerAcceptOnBlock = true;
    flags.enabled.push(id);
  }
  return flags;
}

/** @param {BuildFlags} flags @returns {string} */
export function formatBuildFlags(flags) {
  return flags.enabled.length === 0 ? 'correct' : flags.enabled.join(',');
}
