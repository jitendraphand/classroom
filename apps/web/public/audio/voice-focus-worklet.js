/**
 * Voice focus: keeps the voice closest to the microphone and turns down
 * everything well below it (people talking further away, a TV in the next
 * room, the residue a noise suppressor lets through between words).
 *
 * It is a look-ahead downward expander keyed to the speaker's own level:
 * the speaker's level is the loudest 10% of the blocks that are clearly
 * above the noise floor over the last ~20 s (a decaying level histogram, so
 * a door slam or a cough cannot raise it), and sound more than `range` dB
 * under it is turned down 2 dB per dB, to at most `depth` dB. Until the
 * speaker has been heard nothing is turned down. The decision uses
 * the level over the next ~10 ms (look-ahead, so word onsets are not
 * clipped), opens at once, closes only 6 dB under the opening level
 * (hysteresis) and after a short hold, so word endings are kept. It runs after the noise
 * suppressor, on one channel, in 128-sample blocks: a few multiply-adds per
 * sample.
 *
 * Plain JavaScript on purpose: it is loaded with audioWorklet.addModule()
 * as is, and unit-tested in Node (tests/voiceFocus.test.ts) by evaluating
 * this file with a stub AudioWorkletProcessor.
 */
const BLOCK = 128;
/** Blocks of look-ahead (3 x 128 samples = 8 ms at 48 kHz). */
const LOOK = 3;
/** Level histogram: 1 dB bins from -120 to +99 dB (covers 0..1 and 16-bit sample scales). */
const BIN_MIN = -120;
const BINS = 220;
/** The speaker's level is the top SPEECH_TOP share of active blocks. */
const SPEECH_TOP = 0.1;

class VoiceFocus {
  /**
   * @param {number} sampleRate
   * @param {{ range?: number, depth?: number, holdMs?: number, releaseMs?: number }} [opts]
   */
  constructor(sampleRate, opts = {}) {
    this.sampleRate = sampleRate;
    this.range = opts.range ?? 15;
    this.depth = opts.depth ?? 30;
    this.top = opts.top ?? SPEECH_TOP;
    const blockSec = BLOCK / sampleRate;
    this.holdBlocks = Math.round((opts.holdMs ?? 120) / 1000 / blockSec);
    this.open = false;
    this.release = 1 - Math.exp(-blockSec / ((opts.releaseMs ?? 80) / 1000));
    /** Histogram weights: each new block counts 1/decay times more than the last (20 s memory). */
    this.growth = Math.exp(blockSec / 20);
    this.weight = 1;
    this.hist = new Float64Array(BINS);
    this.total = 0;
    /** The speaker's level, dB; NaN until heard (nothing is turned down before). */
    this.speech = NaN;
    /** Noise floor, dB; NaN until the first block. */
    this.floor = NaN;
    this.gain = 1;
    this.hold = 0;
    /** Delay line of LOOK + 1 blocks and their levels. */
    this.ring = [];
    this.energy = [];
    for (let i = 0; i <= LOOK; i++) {
      this.ring.push(new Float32Array(BLOCK));
      this.energy.push(0);
    }
    this.head = 0;
    this.enabled = true;
  }

  /** Add one active block to the level histogram and re-read the speaker's level. */
  learn(lvl) {
    const i = Math.max(0, Math.min(BINS - 1, Math.round(lvl) - BIN_MIN));
    this.hist[i] += this.weight;
    this.total += this.weight;
    this.weight *= this.growth;
    if (this.weight > 1e200) {
      // Renormalise (relative weights are what matter).
      for (let k = 0; k < BINS; k++) this.hist[k] /= this.weight;
      this.total /= this.weight;
      this.weight = 1;
    }
    let acc = 0;
    for (let k = BINS - 1; k >= 0; k--) {
      acc += this.hist[k];
      if (acc >= this.total * this.top) {
        this.speech = k + BIN_MIN;
        return;
      }
    }
  }

  /** Mean square of one block. */
  static power(x) {
    let e = 0;
    for (let i = 0; i < x.length; i++) e += x[i] * x[i];
    return e / Math.max(1, x.length);
  }

  /** dBFS of one block. */
  static level(x) {
    return 10 * Math.log10(VoiceFocus.power(x) + 1e-12);
  }

  /**
   * Process one block: `input` in, the block from LOOK blocks ago out (with
   * its gain ramped from the previous block's to avoid clicks).
   * @param {Float32Array} input
   * @param {Float32Array} output
   */
  process(input, output) {
    const n = Math.min(BLOCK, input.length, output.length);
    const pw = VoiceFocus.power(input.subarray(0, n));
    const lvl = 10 * Math.log10(pw + 1e-12);

    // Learn the floor (fast down, slow up) and the speaker's level from the
    // blocks clearly above it.
    if (Number.isNaN(this.floor)) this.floor = lvl;
    else if (lvl < this.floor) this.floor += (lvl - this.floor) * 0.2;
    else this.floor += (lvl - this.floor) * 0.0005;
    if (lvl > this.floor + 15) this.learn(lvl);

    const slot = this.head;
    this.ring[slot].set(input.subarray(0, n));
    if (n < BLOCK) this.ring[slot].fill(0, n);
    this.energy[slot] = pw;
    this.head = (this.head + 1) % (LOOK + 1);
    const out = this.ring[this.head]; // oldest block

    // Gain from the level of the look-ahead window (the block going out and
    // the LOOK blocks after it): one 2.7 ms block is too spiky to judge by.
    let e = 0;
    for (let i = 0; i <= LOOK; i++) e += this.energy[i];
    const win = 10 * Math.log10(e / (LOOK + 1) + 1e-12);
    const threshold = Number.isNaN(this.speech) ? -Infinity : this.speech - this.range;
    let target = 1;
    if (win >= (this.open ? threshold - 6 : threshold)) {
      this.open = true;
      this.hold = this.holdBlocks;
    } else if (this.hold > 0) {
      this.hold--;
    } else {
      this.open = false;
      if (this.enabled) target = Math.pow(10, Math.max(-this.depth, 2 * (win - threshold)) / 20);
    }

    const from = this.gain;
    const to = target >= from ? target : from + (target - from) * this.release;
    const step = (to - from) / n;
    for (let i = 0; i < n; i++) output[i] = out[i] * (from + step * (i + 1));
    this.gain = to;
  }
}

if (typeof AudioWorkletProcessor !== 'undefined' && typeof registerProcessor === 'function') {
  class VoiceFocusProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      this.focus = new VoiceFocus(sampleRate, (options && options.processorOptions) || {});
      this.port.onmessage = (e) => {
        if (e.data && typeof e.data.enabled === 'boolean') this.focus.enabled = e.data.enabled;
      };
    }

    process(inputs, outputs) {
      const input = inputs[0] && inputs[0][0];
      const output = outputs[0] && outputs[0][0];
      if (!output) return true;
      if (!input) {
        output.fill(0);
        return true;
      }
      this.focus.process(input, output);
      for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(output);
      return true;
    }
  }
  registerProcessor('voice-focus', VoiceFocusProcessor);
}

if (typeof globalThis !== 'undefined') globalThis.__VoiceFocus = VoiceFocus;
