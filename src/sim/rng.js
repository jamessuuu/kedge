// Deterministic pseudo-random number generator.
//
// The whole point of kedge is that an execution is a pure function of one seed.
// That is only true if nothing below the UI layer ever reads ambient state, so
// this file is the ONLY source of randomness in the simulator. There is no
// Math.random anywhere in src/, and the suite asserts that (test/determinism.test.js).
//
// Algorithm: sfc32 (Chris Doty-Humphrey's "Small Fast Counting" generator,
// 32-bit variant), seeded by four rounds of splitmix32. Chosen because it is
// pure 32-bit integer arithmetic -- no floats in the state -- so it produces
// bit-identical streams on every JS engine, which is what determinism means
// here. Not cryptographic; it does not need to be.

/**
 * Expand a single integer seed into four 32-bit words.
 * @param {number} seed
 * @returns {number[]}
 */
function splitmix32Seeds(seed) {
  let a = seed >>> 0;
  const out = [];
  for (let i = 0; i < 4; i++) {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
    out.push((t ^ (t >>> 14)) >>> 0);
  }
  return out;
}

export class Rng {
  /**
   * @param {number} seed integer seed; the same seed always yields the same stream
   */
  constructor(seed) {
    if (!Number.isFinite(seed) || !Number.isInteger(seed)) {
      throw new TypeError('Rng seed must be an integer, got: ' + String(seed));
    }
    this.seed = seed >>> 0;
    const s = splitmix32Seeds(this.seed);
    this.a = s[0];
    this.b = s[1];
    this.c = s[2];
    this.d = s[3];
    // Discard a short warm-up so low seeds do not correlate.
    for (let i = 0; i < 12; i++) this.nextUint32();
  }

  /** @returns {number} uniform 32-bit unsigned integer */
  nextUint32() {
    const t = (this.a + this.b) >>> 0;
    this.a = (this.b ^ (this.b >>> 9)) >>> 0;
    this.b = (this.c + (this.c << 3)) >>> 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) >>> 0;
    this.d = (this.d + 1) >>> 0;
    const r = (t + this.d) >>> 0;
    this.c = (this.c + r) >>> 0;
    return r;
  }

  /** @returns {number} uniform float in [0, 1) */
  nextFloat() {
    return this.nextUint32() / 4294967296;
  }

  /**
   * Uniform integer in [lo, hi] inclusive.
   * @param {number} lo
   * @param {number} hi
   * @returns {number}
   */
  int(lo, hi) {
    if (hi < lo) throw new RangeError('Rng.int: hi < lo (' + hi + ' < ' + lo + ')');
    const span = hi - lo + 1;
    return lo + (this.nextUint32() % span);
  }

  /**
   * True with probability p.
   * @param {number} p
   * @returns {boolean}
   */
  chance(p) {
    return this.nextFloat() < p;
  }

  /**
   * Pick one element of a non-empty array.
   * @template T
   * @param {T[]} arr
   * @returns {T}
   */
  pick(arr) {
    if (arr.length === 0) throw new RangeError('Rng.pick: empty array');
    return arr[this.int(0, arr.length - 1)];
  }

  /** @returns {Rng} an independent generator derived from this one */
  fork() {
    return new Rng(this.nextUint32() | 0);
  }
}
