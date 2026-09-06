# kedge

A deterministic five-node Raft cluster simulator with a linearizability checker,
validated against 102 real Jepsen etcd histories that have published verdicts.

The whole execution — election timeouts, message delays, which key a client
touches, when a partition drops a packet — is a pure function of one integer
seed. Nothing below the UI layer reads a clock or a random number, and a test
asserts that rather than a comment promising it.

**The headline, measured, not asserted:** kedge matches Porcupine's published
verdict on **102 of the 102** vendored Jepsen etcd histories that carry one, in
**1.1 seconds** total. The 103rd, `etcd_095.log`, is a zero-byte file — that
run's etcd cluster failed to start, and Porcupine asserts nothing about it
either.

```
$ node src/cli.js corpus
Jepsen etcd corpus (vendored from anishathalye/porcupine, MIT)
  102 of 102 histories matched Porcupine's published verdict
  0 mismatched, 0 exhausted the 4000000-step budget
  1 file has no published verdict (etcd_095.log is empty: the cluster failed to start)
  3301715 model transitions, 1140 ms total
```

---

## Run it in 60 seconds

```sh
git clone https://github.com/jamessuuu/kedge && cd kedge
npm ci          # devDeps are only TypeScript + node types; kedge has no runtime deps
npm run demo    # a failing execution, explained
```

Or open `web/index.html` in a browser — it is a static page with no server, no
model, no dataset and no credentials. The default seed is a **failing** run, so
the bug is on the first screen.

## The worked example

`npm run demo` is one deterministic execution of a Raft build with a planted bug
(`deposed-leader-read`), under a fault that partitions the leader away from the
cluster for 550 ticks. Real output:

```
$ node src/cli.js demo
kedge demo -- a failing execution, on purpose.

seed 4711  build deposed-leader-read  faults 150-700:L  5 nodes, 60 operations
not-linearizable — 60 operations, 2678 steps
  witness: get(x) -> "v1" cannot be placed anywhere in the order; the longest consistent explanation ends at put(x, "v9")

  tick 11                                                      1031
  cut   |         ###################################                    | nodes 1
 . c02 |[-----]                                                         | get(x) -> "v1"
 . c00 |[-----]                                                         | put(x, "v1")
 . c03 | [----]                                                         | get(x) -> "v1"
 . c01 |  [---]                                                         | get(x) -> null
 . c01 |       [-------------------------------------------------------]| put(x, "v2") -> unknown
 . c02 |       [-]                                                      | get(x) -> "v1"
 . c00 |        [------------------------------------------------------]| put(x, "v3") -> unknown
 . c03 |        [------------------------------------------------------]| put(x, "v4") -> unknown
 . c02 |           [---------------------------------------------------]| put(x, "v5") -> unknown
 . c05 |                            []                                  | put(x, "v6")
 . c06 |                            [-]                                 | put(x, "v7")
 . c04 |                            [-]                                 | put(x, "v8")
 . c07 |                              [-]                               | put(x, "v9")
 . c05 |                               |                                | get(x) -> "v8"
 . c04 |                               |                                | get(x) -> "v8"
=> c06 |                                |                               | get(x) -> "v1"
   c04 |                                |                               | get(x) -> "v1"
   c07 |                                 [-]                            | put(x, "v10")
   c05 |                                 []                             | put(x, "v11")
   c04 |                                 []                             | put(x, "v12")
   c06 |                                  |                             | put(x, "v13")
   c05 |                                   []                           | put(x, "v14")
     ... 38 more operations not shown

  => the operation no ordering can explain      . part of the longest ordering that works
```

Two clients read `v8`, and then a client reads `v1` — a value written far
earlier. Node 1, the deposed leader, is still answering from its own state
machine on the wrong side of the partition. Same seed, correct build:

```
$ node src/cli.js run --seed 4711 --faults 150-700:L
seed 4711  build correct  faults 150-700:L  5 nodes, 60 operations
linearizable — 60 operations, 122 steps
```

## The three outcomes, and why the third one is not a policy choice

Deciding whether a history is linearizable against an arbitrary sequential
specification is NP-complete (Gibbons & Korach, 1997). So the search takes a step
budget and returns one of `linearizable`, `not-linearizable`, or `unknown`.

Every other checker in this portfolio returns `unknown` because its author chose
to be honest about coverage. **This one returns it because a complexity result
forces the choice.** That distinction is the reason the project exists.

The claim worth testing is what happens when you starve it. Measured across the
102 histories:

| step budget | correct | wrong | unknown | total steps | time |
|---|---|---|---|---|---|
| 1,000 | 82 | **0** | 20 | 42,194 | 26 ms |
| 10,000 | 92 | **0** | 10 | 145,959 | 56 ms |
| 100,000 | 97 | **0** | 5 | 768,695 | 248 ms |
| 500,000 | 100 | **0** | 2 | 2,237,404 | 733 ms |
| 1,200,000 | 102 | **0** | 0 | 3,301,715 | 1,105 ms |
| 4,000,000 (default) | 102 | **0** | 0 | 3,301,715 | 1,139 ms |

Under pressure it gives up. It never guesses. The hardest history in the corpus
(`etcd_002.log`, 77 operations, linearizable) takes 1,177,310 model transitions;
the default budget leaves 3.4× headroom. Reproduce the whole table with
`node src/cli.js corpus --budget <n>`.

## The planted fixtures, and the negative control

A checker whose failure path has never been exercised is decoration. kedge ships
five build-flag bugs (`node src/cli.js bugs` lists them; every one lives in
`src/bugs.js`, nothing is hidden elsewhere). Four break Raft. The fifth breaks
the checker.

```
$ node src/cli.js fixtures
Planted fixtures (recipes in src/fixtures.js, measured 2026-09-06)
  OK   deposed-leader-read     49/60 seeds violated (floor 35), control 0
  OK   vote-without-log-check  32/60 seeds violated (floor 20), control 0
  OK   minority-election       10/60 seeds violated (floor 5), control 0
  OK   stale-term-commit       7/7 seeds violated (floor 7), control 0
  OK   checker-accept-on-block: sabotaged build says "linearizable", correct build says "not-linearizable"

Negative control: 800 executions of the correct build, 0 violations, 0 unknown
```

**The sabotaged checker is the one that matters.** `checker-accept-on-block`
returns `linearizable` at the exact point the search has proven no linearization
exists. With it on, kedge wrongly passes twelve histories Porcupine calls
non-linearizable; with it off, it rejects all twelve. That is what makes the
rejection path load-bearing rather than incidental (`test/sabotage.test.js`).

**The negative control** is 4 fault scripts × 200 seeds = 800 executions of the
*correct* build, over three keys so P-compositionality does real work. Zero
violations. Without it, "it found bugs" is indistinguishable from "it fires at
random".

### The bug the negative control found in kedge itself

The first negative-control run reported violations on the *correct* build under
crash faults. That was not a checker false positive — it was a real defect in
kedge's Raft: client request deduplication (Raft §8) was missing, so a client
that retried a `put` had it applied twice, and a retried old value landed on top
of newer ones. The checker was right and the implementation was wrong. The fix
is `appliedReqs` in `src/raft/node.js`; the negative control has been clean since.

### Why `stale-term-commit` is pinned to specific seeds

Raft §5.4.2 says a leader may only commit by counting replicas for entries of its
*own* term. Removing that check should lose an acknowledged write — Figure 8 of
the Raft paper. In kedge it almost never does: the window in which an old-term
entry holds a majority while *this* term's no-op does not is about one heartbeat
wide, and it closes entirely unless AppendEntries carries one entry at a time.
Scanning seeds 1..32,082 under the crash-churn fault script produced **7**
reproductions — roughly 1 in 4,600.

So that fixture pins seven known seeds rather than pretending a range would do.
The rarity is the point: §5.4.2 is a rule you do not arrive at by testing, which
is why the paper needed a figure to argue for it.

## What is actually in here

**`src/sim/`** — a deterministic discrete-event scheduler. Event time is a
logical integer tick, ordered by `(time, insertion sequence)` so two runs of one
seed step through identical events regardless of machine speed. There is no
`Date.now`, no `Math.random`, no `setTimeout` anywhere below the UI, and
`test/determinism.test.js` fails the build if one appears.

**`src/raft/`** — leader election with randomised timeouts, log replication with
the log-matching check, the commit rule including §5.4.2's current-term
restriction, §5.4.1's election restriction, a no-op committed at the start of
each term, ReadIndex reads confirmed by a quorum heartbeat round, and §8 client
dedup. Faults are scripted: partitions, crash-stop, and an `L` target that means
"whoever is leading when this fault opens".

**`src/lin/`** — Wing & Gong's algorithm with Lowe's memoisation and
P-compositionality. Entries form a doubly linked list; the search lifts the
earliest linearizable call, restarts, and backtracks on a response it cannot
explain. Two search paths that have linearized the same *set* of operations into
the same model state are interchangeable, so the second is pruned — which is what
makes 90-operation histories tractable, and which rests entirely on
`model.stateKey` being exact. That is the most dangerous line in the checker and
it is commented as such.

## What it does NOT do

- **Not usable Raft.** No persistence, no crash recovery (a "crash" here is a
  pause; there is no state to lose), no membership changes, no snapshots, no log
  compaction, no real network. It cannot demonstrate any bug that needs a restart
  with state loss.
- **Not a general linearizability checker.** Use
  [Porcupine](https://github.com/anishathalye/porcupine) — Go, bitset state,
  parallel search, years of use against real systems. I have not benchmarked the
  two against each other, so this README quotes no speed comparison; it quotes
  kedge's own timings only.
- **It checks a simulation, not a cluster.** The vendored Jepsen corpus is the
  only real-system data in the repo.
- **The network model is thin.** Messages are delayed and dropped; they are never
  reordered beyond what independent delays produce, and never duplicated. Both
  are real failure modes and both are out of scope.
- **Only two models ship** (`etcd-register`, `kv-register`). No transactions, no
  other consistency models.
- **Cut from v1:** animated packet flight, transactions, other consistency
  models, npm packaging.

### Known failure modes

- A history with many concurrent operations can exhaust the budget and return
  `unknown`. That is the contract working, but it does mean kedge cannot decide
  every history you hand it.
- `minority-election` fires on only 10 of 60 seeds: the split-brain leader has to
  be reached by a client before the partition heals, and often is not.
- The `L` fault target resolves at the tick the fault opens. If no leader exists
  at that instant the fault targets nothing, which is reported as an empty group
  rather than silently retargeted.
- The demo page's diagram needs about 640px; below that it scrolls inside its own
  container rather than shrinking to illegibility.

## Commands

```
kedge demo                     one failing execution, checked and explained
kedge run [options]            simulate a cluster and check the history
kedge check <file.log>         check one Jepsen etcd history
kedge corpus [--budget n]      all 102 histories vs Porcupine's published verdicts
kedge fixtures                 planted fixtures + the negative control
kedge bugs                     list the build-flag fixtures
```

`run` takes `--seed`, `--faults`, `--build`, `--ops`, `--clients`, `--nodes`,
`--keys`, `--budget`, `--batch` and `--json`. Fault script grammar:

```
150-700:L                 isolate the leader from the cluster, ticks 150-700
150-450:0.1               cut nodes {0,1} off from {2,3,4}
c200-400:3                crash node 3 (it keeps its state and returns at 400)
200-500:0.1,600-900:2.3   two cuts, one after the other
```

Bad input produces a stated error and a non-zero exit, never a stack trace:

```
$ node src/cli.js check nope.log
kedge: no such file: nope.log

$ node src/cli.js run --seed banana
kedge: --seed must be an integer, got "banana"

$ node src/cli.js run --build not-a-bug
kedge: unknown build flag "not-a-bug"; known flags: checker-accept-on-block,
deposed-leader-read, minority-election, stale-term-commit, vote-without-log-check
```

## Reproducing every number in this README

| claim | command |
|---|---|
| 102 of 102 histories match | `node src/cli.js corpus` |
| the budget table | `node src/cli.js corpus --budget 1000` … `--budget 4000000` |
| fixture fire rates, negative control | `node src/cli.js fixtures` |
| the sabotaged checker | `node --test "test/sabotage.test.js"` |
| determinism | `node --test "test/determinism.test.js"` |
| hostile input | `node --test "test/cli.test.js"` |
| everything | `npm test` (99 tests, ~4 s) |

Measured on Node v24.15.0, Windows 11, 2026-09-06.

**On CI, honestly:** `.github/workflows/ci.yml` installs from the lockfile on a
pinned Node 22.14.0 and runs lint, typecheck, bundle-freshness, the full suite,
the corpus, the fixtures and the demo on Linux, then the suite again on Windows
(kedge is developed on Windows and its module resolution depends on
`pathToFileURL`). It has **never run** — this repository has not been pushed to a remote, so there is no green
badge and this README will not imply one. What has been verified is the
equivalent locally, from a fresh `git clone` into a clean directory followed by
`npm ci`: lint clean, typecheck clean, bundle fresh, 99/99 tests, 102/102 on the
corpus, all fixtures firing, negative control clean.

That clean-clone run earned its keep too. It caught the demo bundle being
reported stale on checkout, because it embedded two sample histories with
whatever line endings the platform produced. Fixed by normalising before
embedding.

## Development

```sh
npm test           # 99 tests
npm run lint       # project-specific gate, not a style opinion engine
npm run typecheck  # tsc over JSDoc types
npm run build:web  # regenerate web/kedge.bundle.js after editing src/ or web/app.js
npm run check:web  # fail if the committed bundle is stale
```

## Credits and licence

kedge is MIT licensed — see [LICENSE](LICENSE).

`vendor/porcupine/` contains 103 Jepsen etcd history logs and the expected
verdicts extracted from `porcupine_test.go`, taken from
[anishathalye/porcupine](https://github.com/anishathalye/porcupine), copyright
Anish Athalye, MIT licensed. The full licence text ships alongside the data at
`vendor/porcupine/PORCUPINE-LICENSE.md`. Those 102 published verdicts are the
only reason kedge's checker can claim anything at all; a simulator checking its
own simulation proves nothing.

- Raft: Ongaro & Ousterhout, *In Search of an Understandable Consensus
  Algorithm*, 2014.
- Linearizability: Herlihy & Wing, 1990 (including the locality theorem that
  P-compositionality rests on).
- The checking algorithm: Wing & Gong, 1993, with the memoisation and
  presentation from Lowe, *Testing for Linearizability*, 2017.
- NP-completeness: Gibbons & Korach, *Testing Shared Memories*, 1997.
