# Changelog

All notable changes to this project are recorded here. Versions follow
[semantic versioning](https://semver.org/). The version reflects what has
actually shipped, not what would look mature.

## 0.1.0 — 2026-09-06

First release. Everything below was measured on the day it was written; the
commands that reproduce each number are in the README.

### Added

- **Deterministic discrete-event scheduler** (`src/sim/`). Logical integer
  ticks, total order by `(time, insertion sequence)`, seeded sfc32 generator.
  Nothing below the UI layer reads a clock or a random number, enforced by a
  test rather than by convention.
- **Raft subset** (`src/raft/`). Elections with randomised timeouts, log
  replication with the log-matching check, the §5.4.2 current-term commit rule,
  the §5.4.1 election restriction, a no-op committed per term, ReadIndex reads
  confirmed by a quorum heartbeat round, and §8 client request deduplication.
- **Fault injection**: scripted partitions, crash-stop, and an `L` target
  meaning "whoever leads when this fault opens". Scripts are URL-safe so a
  failing execution is a shareable object.
- **Linearizability checker** (`src/lin/`). Wing & Gong with Lowe's memoisation
  and P-compositionality. Three outcomes: `linearizable`, `not-linearizable`,
  `unknown`.
- **Jepsen etcd corpus** vendored from `anishathalye/porcupine` (MIT): 103
  history logs plus the 102 published verdicts extracted from
  `porcupine_test.go`. kedge matches all 102 in 1.1 s.
- **Five planted fixtures** (`src/bugs.js`): `stale-term-commit`,
  `deposed-leader-read`, `minority-election`, `vote-without-log-check`, and
  `checker-accept-on-block` — the last of which breaks the checker itself so its
  rejection path can be watched to fail.
- **Negative control**: 800 executions of the correct build across four fault
  scripts and three keys, zero violations.
- **CLI** with `demo`, `run`, `check`, `corpus`, `fixtures` and `bugs`. Bad
  input produces a stated error and a non-zero exit.
- **Static demo page** (`web/`) whose default seed is a failing run, with the
  seed and fault script in the URL. No server, no dataset, no credentials.
- **A ~150-line bundler** (`tools/bundle.mjs`) so the page is one classic script
  that loads from `file://`, with a `--check` mode CI uses to catch a stale
  bundle. It refuses module syntax it does not understand rather than guessing.

### Fixed during development

- **Raft §8 client deduplication was missing.** The first negative-control run
  reported violations on the correct build under crash faults. The checker was
  right: a client retrying a `put` had it applied twice, so a retried old value
  landed on top of newer ones. Fixed with a state-machine dedup table
  (`appliedReqs`); the negative control has been clean since.

### Known limitations at 0.1.0

- No persistence, membership changes, snapshots, log compaction, or real
  network. A "crash" is a pause, because there is no durable state to lose.
- The network never reorders beyond independent delays and never duplicates.
- `stale-term-commit` reproduces in roughly 1 of 4,600 random crash schedules and
  only with an AppendEntries batch of 1, so its fixture pins seven known seeds.
- Only two models ship: `etcd-register` and `kv-register`.
