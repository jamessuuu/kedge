// A Raft subset: terms, elections, append-entries, commit index.
//
// What is here: leader election with randomised timeouts, log replication with
// the log-matching check, the commit rule including the current-term
// restriction of §5.4.2, the election restriction of §5.4.1, a no-op entry
// committed at the start of each term, and ReadIndex reads confirmed by a
// quorum heartbeat round.
//
// What is NOT here, and the README says so too: persistence and crash
// recovery, membership changes, snapshots, log compaction, and a real network.
// Nodes never lose state, so this cannot demonstrate any bug that needs a
// restart to appear.
//
// Every deviation from correct Raft in this file is behind a build flag and
// listed in src/bugs.js. Read those first if you are looking for the planted
// defects; nothing is hidden anywhere else.

const NOOP = 'noop';
const PUT = 'put';

/**
 * @typedef {object} LogEntry
 * @property {number} term
 * @property {string} type 'noop' | 'put'
 * @property {string} [key]
 * @property {string} [value]
 * @property {number} [reqId] client request id, for the §8 dedup table
 */

export class RaftNode {
  /**
   * @param {object} opts
   * @param {number} opts.id
   * @param {number[]} opts.peers all node ids including this one
   * @param {import('../sim/scheduler.js').Scheduler} opts.sched
   * @param {import('../sim/rng.js').Rng} opts.rng
   * @param {import('../bugs.js').BuildFlags} opts.flags
   * @param {(to:number, msg:object) => void} opts.send
   * @param {() => boolean} [opts.isDown] true while this node is crash-stopped
   * @param {{electionMin?:number, electionMax?:number, heartbeat?:number, maxEntriesPerAppend?:number}} [opts.timing]
   */
  constructor(opts) {
    this.id = opts.id;
    this.peers = opts.peers;
    this.sched = opts.sched;
    this.rng = opts.rng;
    this.flags = opts.flags;
    this.send = opts.send;
    this.isDown = opts.isDown || (() => false);
    const t = opts.timing || {};
    this.electionMin = t.electionMin === undefined ? 40 : t.electionMin;
    this.electionMax = t.electionMax === undefined ? 80 : t.electionMax;
    this.heartbeatEvery = t.heartbeat === undefined ? 12 : t.heartbeat;
    // How many log entries one AppendEntries may carry. Real implementations
    // cap this; the cap also decides whether §5.4.2's window is observable at
    // all, because a follower that acks an old-term entry and this term's no-op
    // in the SAME message never sits in the dangerous state. Reproducing
    // `stale-term-commit` therefore needs a small batch -- see src/fixtures.js.
    this.maxEntriesPerAppend =
      t.maxEntriesPerAppend === undefined ? 8 : t.maxEntriesPerAppend;

    this.currentTerm = 0;
    /** @type {number|null} */
    this.votedFor = null;
    /** @type {LogEntry[]} */
    this.log = [{ term: 0, type: NOOP }]; // index 0 is a sentinel
    this.commitIndex = 0;
    this.lastApplied = 0;
    /** @type {'follower'|'candidate'|'leader'} */
    this.role = 'follower';
    /** @type {number|null} */
    this.leaderHint = null;
    /** @type {Record<string, string>} */
    this.store = {};
    // Raft §8: a client that retries a write must not have it applied twice.
    // The state machine records which request ids it has already executed, and
    // that table is derived from the replicated log, so every node computes the
    // same one. Leaving this out is what the negative control caught first:
    // a retried put re-applied an old value on top of newer ones and the
    // checker -- correctly -- called the result non-linearizable.
    /** @type {Set<number>} */
    this.appliedReqs = new Set();

    /** @type {Map<number, number>} */
    this.nextIndex = new Map();
    /** @type {Map<number, number>} */
    this.matchIndex = new Map();
    /** @type {Set<number>} */
    this.votes = new Set();

    // ReadIndex bookkeeping. `round` increments per heartbeat broadcast; a read
    // is confirmed once some round started after it collects a majority of acks.
    this.round = 0;
    /** @type {Map<number, Set<number>>} */
    this.roundAcks = new Map();
    this.confirmedRound = -1;
    this.noopIndex = -1;

    /** @type {Map<number, {key:string, readIndex:number, waitRound:number, done:Function}>} */
    this.pendingReads = new Map();
    /** @type {Map<number, {done:Function}>} */
    this.pendingWrites = new Map(); // keyed by log index
    this.nextReadId = 1;

    /** @type {any} */
    this.electionTimer = null;
    /** @type {any} */
    this.heartbeatTimer = null;

    this.sched.on('raft.election.' + this.id, () => this.onElectionTimeout());
    this.sched.on('raft.heartbeat.' + this.id, () => this.onHeartbeatTick());
  }

  get quorum() {
    return Math.floor(this.peers.length / 2) + 1;
  }

  get lastIndex() {
    return this.log.length - 1;
  }

  get lastTerm() {
    return this.log[this.log.length - 1].term;
  }

  start() {
    this.resetElectionTimer();
  }

  resetElectionTimer() {
    this.sched.cancel(this.electionTimer);
    const delay = this.rng.int(this.electionMin, this.electionMax);
    this.electionTimer = this.sched.after(delay, 'raft.election.' + this.id, {});
  }

  onElectionTimeout() {
    // A crashed node runs no timers. It keeps its state -- kedge has no
    // persistence, so this is a pause, not a crash-recovery cycle.
    if (this.isDown()) {
      this.resetElectionTimer();
      return;
    }
    if (this.role === 'leader') return;
    this.becomeCandidate();
  }

  /** @param {number} term */
  becomeFollower(term) {
    const wasLeader = this.role === 'leader';
    this.currentTerm = term;
    this.votedFor = null;
    this.role = 'follower';
    this.votes.clear();
    if (wasLeader) {
      this.sched.cancel(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.failPending('stepped down');
    }
    this.resetElectionTimer();
  }

  becomeCandidate() {
    this.currentTerm++;
    this.role = 'candidate';
    this.votedFor = this.id;
    this.votes = new Set([this.id]);
    this.leaderHint = null;
    this.resetElectionTimer();
    for (const p of this.peers) {
      if (p === this.id) continue;
      this.send(p, {
        type: 'RequestVote',
        term: this.currentTerm,
        candidateId: this.id,
        lastLogIndex: this.lastIndex,
        lastLogTerm: this.lastTerm,
      });
    }
  }

  becomeLeader() {
    this.role = 'leader';
    this.leaderHint = this.id;
    this.sched.cancel(this.electionTimer);
    this.electionTimer = null;
    this.nextIndex = new Map();
    this.matchIndex = new Map();
    for (const p of this.peers) {
      this.nextIndex.set(p, this.lastIndex + 1);
      this.matchIndex.set(p, p === this.id ? this.lastIndex : 0);
    }
    this.confirmedRound = -1;
    this.roundAcks = new Map();
    // A leader may not serve reads until it has committed an entry of its own
    // term, otherwise its commitIndex can lag a value another leader committed.
    this.log.push({ term: this.currentTerm, type: NOOP });
    this.noopIndex = this.lastIndex;
    this.matchIndex.set(this.id, this.lastIndex);
    this.onHeartbeatTick();
  }

  onHeartbeatTick() {
    if (this.role !== 'leader') return;
    if (this.isDown()) {
      this.sched.cancel(this.heartbeatTimer);
      this.heartbeatTimer = this.sched.after(this.heartbeatEvery, 'raft.heartbeat.' + this.id, {});
      return;
    }
    this.round++;
    this.roundAcks.set(this.round, new Set([this.id]));
    // Keep the ack table bounded; rounds this old can no longer confirm a read.
    for (const r of this.roundAcks.keys()) {
      if (r < this.round - 64) this.roundAcks.delete(r);
    }
    for (const p of this.peers) {
      if (p === this.id) continue;
      this.sendAppendEntries(p);
    }
    this.sched.cancel(this.heartbeatTimer);
    this.heartbeatTimer = this.sched.after(this.heartbeatEvery, 'raft.heartbeat.' + this.id, {});
  }

  /** @param {number} to */
  sendAppendEntries(to) {
    const next = /** @type {number} */ (this.nextIndex.get(to));
    const prevLogIndex = Math.max(0, next - 1);
    const prevLogTerm = this.log[prevLogIndex].term;
    const entries = this.log.slice(prevLogIndex + 1, prevLogIndex + 1 + this.maxEntriesPerAppend);
    this.send(to, {
      type: 'AppendEntries',
      term: this.currentTerm,
      leaderId: this.id,
      prevLogIndex,
      prevLogTerm,
      entries,
      leaderCommit: this.commitIndex,
      round: this.round,
    });
  }

  /**
   * @param {number} from
   * @param {any} msg
   */
  onMessage(from, msg) {
    if (this.isDown()) return;
    if (msg.term > this.currentTerm) this.becomeFollower(msg.term);
    switch (msg.type) {
      case 'RequestVote':
        return this.onRequestVote(from, msg);
      case 'RequestVoteReply':
        return this.onRequestVoteReply(from, msg);
      case 'AppendEntries':
        return this.onAppendEntries(from, msg);
      case 'AppendEntriesReply':
        return this.onAppendEntriesReply(from, msg);
      default:
        throw new Error('RaftNode ' + this.id + ': unknown message type "' + String(msg.type) + '"');
    }
  }

  /** @param {number} from @param {any} msg */
  onRequestVote(from, msg) {
    let granted = false;
    if (msg.term >= this.currentTerm && (this.votedFor === null || this.votedFor === msg.candidateId)) {
      const upToDate =
        msg.lastLogTerm > this.lastTerm ||
        (msg.lastLogTerm === this.lastTerm && msg.lastLogIndex >= this.lastIndex);
      // BUG `vote-without-log-check`: the election restriction (§5.4.1) is the
      // only thing stopping a node with a stale log from winning and then
      // truncating committed entries off everyone else.
      granted = this.flags.voteWithoutLogCheck ? true : upToDate;
      if (granted) {
        this.votedFor = msg.candidateId;
        this.resetElectionTimer();
      }
    }
    this.send(from, { type: 'RequestVoteReply', term: this.currentTerm, voteGranted: granted });
  }

  /** @param {number} from @param {any} msg */
  onRequestVoteReply(from, msg) {
    if (this.role !== 'candidate' || msg.term !== this.currentTerm) return;
    if (!msg.voteGranted) return;
    this.votes.add(from);
    // BUG `minority-election`: a plurality is not a majority. With 5 nodes this
    // lets both sides of a 2/3 partition elect a leader in the same term.
    const needed = this.flags.minorityElection ? 2 : this.quorum;
    if (this.votes.size >= needed) this.becomeLeader();
  }

  /** @param {number} from @param {any} msg */
  onAppendEntries(from, msg) {
    if (msg.term < this.currentTerm) {
      this.send(from, {
        type: 'AppendEntriesReply',
        term: this.currentTerm,
        success: false,
        matchIndex: 0,
        round: msg.round,
      });
      return;
    }
    if (this.role !== 'follower') {
      this.role = 'follower';
      this.sched.cancel(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.failPending('another leader appeared');
    }
    this.leaderHint = msg.leaderId;
    this.resetElectionTimer();

    if (msg.prevLogIndex > this.lastIndex || this.log[msg.prevLogIndex].term !== msg.prevLogTerm) {
      this.send(from, {
        type: 'AppendEntriesReply',
        term: this.currentTerm,
        success: false,
        matchIndex: 0,
        round: msg.round,
      });
      return;
    }

    for (let i = 0; i < msg.entries.length; i++) {
      const idx = msg.prevLogIndex + 1 + i;
      const incoming = msg.entries[i];
      if (idx <= this.lastIndex) {
        if (this.log[idx].term !== incoming.term) {
          this.log.length = idx; // conflict: drop this entry and everything after
          this.log.push(incoming);
          // Correct Raft never truncates a committed entry, so these clamps are
          // no-ops on the correct build. On the stale-term-commit build they
          // are exactly where an acknowledged write disappears -- note that the
          // state machine is NOT rolled back, because a real one could not be.
          if (this.commitIndex > this.lastIndex) this.commitIndex = this.lastIndex;
          if (this.lastApplied > this.lastIndex) this.lastApplied = this.lastIndex;
        }
        // identical entry: leave it alone
      } else {
        this.log.push(incoming);
      }
    }

    const matchIndex = msg.prevLogIndex + msg.entries.length;
    if (msg.leaderCommit > this.commitIndex) {
      this.commitIndex = Math.min(msg.leaderCommit, matchIndex);
      this.apply();
    }
    this.send(from, {
      type: 'AppendEntriesReply',
      term: this.currentTerm,
      success: true,
      matchIndex,
      round: msg.round,
    });
  }

  /** @param {number} from @param {any} msg */
  onAppendEntriesReply(from, msg) {
    if (this.role !== 'leader' || msg.term !== this.currentTerm) return;
    // Any reply at the current term proves the sender still follows this leader
    // right now, which is exactly what ReadIndex needs -- so a reply counts as a
    // heartbeat ack whether or not the log-matching check passed.
    const acks = this.roundAcks.get(msg.round);
    if (acks) {
      acks.add(from);
      if (acks.size >= this.quorum && msg.round > this.confirmedRound) {
        this.confirmedRound = msg.round;
        this.serviceReads();
      }
    }
    if (msg.success) {
      this.matchIndex.set(from, Math.max(/** @type {number} */ (this.matchIndex.get(from)) || 0, msg.matchIndex));
      this.nextIndex.set(
        from,
        Math.max(/** @type {number} */ (this.nextIndex.get(from)) || 1, msg.matchIndex + 1)
      );
      this.advanceCommit();
    } else {
      const next = /** @type {number} */ (this.nextIndex.get(from));
      this.nextIndex.set(from, Math.max(1, next - 1));
      this.sendAppendEntries(from);
    }
  }

  advanceCommit() {
    for (let n = this.lastIndex; n > this.commitIndex; n--) {
      let count = 0;
      for (const p of this.peers) {
        if ((this.matchIndex.get(p) || 0) >= n) count++;
      }
      if (count < this.quorum) continue;
      // BUG `stale-term-commit`: Raft §5.4.2 only lets a leader commit by
      // counting replicas for entries of its OWN term. Without this check an
      // entry from an older term can be declared committed and then still be
      // overwritten by a future leader -- an acknowledged write, lost.
      const currentTermEntry = this.log[n].term === this.currentTerm;
      if (currentTermEntry || this.flags.staleTermCommit) {
        this.commitIndex = n;
        this.apply();
        break;
      }
    }
  }

  apply() {
    while (this.lastApplied < this.commitIndex) {
      this.lastApplied++;
      const entry = this.log[this.lastApplied];
      if (entry.type === PUT) {
        const reqId = /** @type {number} */ (entry.reqId);
        if (!this.appliedReqs.has(reqId)) {
          this.appliedReqs.add(reqId);
          this.store[/** @type {string} */ (entry.key)] = /** @type {string} */ (entry.value);
        }
      }
      const pw = this.pendingWrites.get(this.lastApplied);
      if (pw) {
        this.pendingWrites.delete(this.lastApplied);
        if (this.role === 'leader') pw.done({ ok: true });
        else pw.done({ ok: false, reason: 'not-leader', hint: this.leaderHint });
      }
    }
    this.serviceReads();
  }

  serviceReads() {
    if (this.role !== 'leader') return;
    for (const [rid, r] of Array.from(this.pendingReads.entries())) {
      if (this.confirmedRound < r.waitRound) continue;
      if (this.lastApplied < r.readIndex) continue;
      this.pendingReads.delete(rid);
      const v = Object.prototype.hasOwnProperty.call(this.store, r.key) ? this.store[r.key] : null;
      r.done({ ok: true, value: v });
    }
  }

  /** @param {string} reason */
  failPending(reason) {
    for (const [idx, w] of Array.from(this.pendingWrites.entries())) {
      this.pendingWrites.delete(idx);
      w.done({ ok: false, reason, hint: this.leaderHint });
    }
    for (const [rid, r] of Array.from(this.pendingReads.entries())) {
      this.pendingReads.delete(rid);
      r.done({ ok: false, reason, hint: this.leaderHint });
    }
  }

  /**
   * Client write. `done` is called exactly once.
   * @param {string} key
   * @param {string} value
   * @param {number} reqId unique per client operation; retries reuse it
   * @param {(res:{ok:boolean, reason?:string, hint?:number|null}) => void} done
   */
  clientPut(key, value, reqId, done) {
    if (this.isDown()) {
      done({ ok: false, reason: 'node-down', hint: null });
      return;
    }
    if (this.role !== 'leader') {
      done({ ok: false, reason: 'not-leader', hint: this.leaderHint });
      return;
    }
    // Already executed by this state machine: the first attempt landed and the
    // client simply never heard about it.
    if (this.appliedReqs.has(reqId)) {
      done({ ok: true });
      return;
    }
    // Already in the log but not yet applied: wait on the existing entry rather
    // than appending a second copy of the same request.
    for (let i = this.lastIndex; i >= 1; i--) {
      if (this.log[i].type === PUT && this.log[i].reqId === reqId) {
        if (i <= this.commitIndex) done({ ok: true });
        else this.pendingWrites.set(i, { done });
        return;
      }
    }
    this.log.push({ term: this.currentTerm, type: PUT, key, value, reqId });
    const idx = this.lastIndex;
    this.matchIndex.set(this.id, idx);
    this.pendingWrites.set(idx, { done });
    for (const p of this.peers) {
      if (p === this.id) continue;
      this.sendAppendEntries(p);
    }
    this.advanceCommit();
  }

  /**
   * Client read. `done` is called exactly once.
   * @param {string} key
   * @param {(res:{ok:boolean, value?:string|null, reason?:string, hint?:number|null}) => void} done
   */
  clientGet(key, done) {
    if (this.isDown()) {
      done({ ok: false, reason: 'node-down', hint: null });
      return;
    }
    if (this.role !== 'leader') {
      done({ ok: false, reason: 'not-leader', hint: this.leaderHint });
      return;
    }
    // BUG `deposed-leader-read`: answering from local state skips the proof
    // that this node is STILL the leader. A node isolated by a partition keeps
    // believing it leads and keeps serving values the cluster has moved past.
    if (this.flags.deposedLeaderRead) {
      const v = Object.prototype.hasOwnProperty.call(this.store, key) ? this.store[key] : null;
      done({ ok: true, value: v });
      return;
    }
    if (this.commitIndex < this.noopIndex) {
      // Cannot serve reads until this term's no-op has committed.
      done({ ok: false, reason: 'term-not-established', hint: this.id });
      return;
    }
    const rid = this.nextReadId++;
    this.pendingReads.set(rid, {
      key,
      readIndex: this.commitIndex,
      waitRound: this.round + 1,
      done,
    });
    this.onHeartbeatTick(); // start the confirmation round immediately
  }
}
