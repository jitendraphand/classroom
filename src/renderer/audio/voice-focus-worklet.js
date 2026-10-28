/**
 * Voice focus: keeps the voice closest to the microphone and turns down
 * everything well below it (people talking further away, a TV in the next
 * room, the residue a noise suppressor lets through between words).
 *
 * It is a look-ahead downward expander keyed to the speaker's own level:
 * the upper envelope of the speaker's speech is learned while they talk
 * (rises in ~0.1 s, falls over ~20 s), and sound more than `range` dB under
 * it is turned down 2 dB per dB, to at most `depth` dB. The decision uses
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

class VoiceFocus {
  /**
   * @param {number} sampleRate
   * @param {{ range?: number, depth?: number, holdMs?: number, releaseMs?: number }} [opts]
   */
  constructor(sampleRate, opts = {}) {
    this.sampleRate = sampleRate;
    this.range = opts.range ?? 22;
    this.depth = opts.depth ?? 30;
    const blockSec = BLOCK / sampleRate;
    this.holdBlocks = Math.round((opts.holdMs ?? 120) / 1000 / blockSec);
    this.open = false;
    this.release = 1 - Math.exp(-blockSec / ((opts.releaseMs ?? 80) / 1000));
    this.rise = 1 - Math.exp(-blockSec / 0.1);
    this.fall = 1 - Math.exp(-blockSec / 20);
    /** Upper envelope of the speaker's speech, dBFS. Starts low: open until learned. */
    this.speech = -45;
    /** Noise floor, dBFS. */
    this.floor = -60;
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

    // Learn the floor (fast down, slow up) and the speaker's level (the upper
    // envelope of blocks clearly above the floor).
    if (lvl < this.floor) this.floor += (lvl - this.floor) * 0.2;
    else this.floor += (lvl - this.floor) * 0.0005;
    if (lvl > this.floor + 15 && lvl > -70) {
      this.speech += (lvl - this.speech) * (lvl > this.speech ? this.rise : this.fall);
    }

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
    const threshold = this.speech - this.range;
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
