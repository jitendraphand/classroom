/**
 * Voice: the AI teacher's speech out (text-to-speech -> the teacher's
 * microphone track) and students' speech in (their mic -> voice activity
 * detection -> speech-to-text), as small pluggable pieces.
 *
 * Providers are plain HTTP so any vendor (or a model hosted at the school)
 * fits: an "audio/speech" endpoint that returns 16-bit PCM, and an
 * "audio/transcriptions" endpoint that takes a WAV file. Both are optional;
 * without them the AI teacher writes on the board and in chat instead.
 */

export type Tts = {
  /** Sample rate of the PCM it returns. */
  readonly sampleRate: number;
  synth(text: string, signal?: AbortSignal): Promise<Int16Array>;
};

export type Stt = {
  transcribe(pcm: Int16Array, sampleRate: number, signal?: AbortSignal): Promise<string>;
};

/** POST {model, voice, input, response_format: "pcm"} -> raw 16-bit mono PCM (24 kHz by default). */
export class HttpTts implements Tts {
  constructor(
    private readonly url: string,
    private readonly key: string | undefined,
    private readonly model: string,
    private readonly voice: string,
    readonly sampleRate = 24000
  ) {}

  async synth(text: string, signal?: AbortSignal): Promise<Int16Array> {
    const r = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.key ? { authorization: `Bearer ${this.key}` } : {}) },
      body: JSON.stringify({ model: this.model, voice: this.voice, input: text, response_format: 'pcm' }),
      signal: signal ?? AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`text-to-speech HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
  }
}

/** multipart POST file=<wav> model=<model> -> { text }. */
export class HttpStt implements Stt {
  constructor(
    private readonly url: string,
    private readonly key: string | undefined,
    private readonly model: string,
    private readonly language?: string
  ) {}

  async transcribe(pcm: Int16Array, sampleRate: number, signal?: AbortSignal): Promise<string> {
    const form = new FormData();
    form.append('file', new Blob([wav(pcm, sampleRate)], { type: 'audio/wav' }), 'speech.wav');
    form.append('model', this.model);
    if (this.language) form.append('language', this.language);
    const r = await fetch(this.url, {
      method: 'POST',
      headers: this.key ? { authorization: `Bearer ${this.key}` } : {},
      body: form,
      signal: signal ?? AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`speech-to-text HTTP ${r.status}`);
    const j = (await r.json()) as { text?: unknown };
    return typeof j.text === 'string' ? j.text.trim() : '';
  }
}

/** 16-bit mono PCM -> a WAV file. */
export function wav(pcm: Int16Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(44 + pcm.byteLength);
  const v = new DataView(out.buffer);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + pcm.byteLength, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, pcm.byteLength, true);
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 44);
  return out;
}

/** A 16-bit PCM WAV file -> mono samples and rate (first channel). */
export function parseWav(bytes: Uint8Array): { pcm: Int16Array; sampleRate: number } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let o = 12;
  let rate = 0;
  let channels = 1;
  let bits = 16;
  while (o + 8 <= bytes.length) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    if (id === 'fmt ') {
      channels = v.getUint16(o + 10, true);
      rate = v.getUint32(o + 12, true);
      bits = v.getUint16(o + 22, true);
    } else if (id === 'data') {
      if (bits !== 16) throw new Error('only 16-bit WAV is supported');
      const n = Math.floor(Math.min(size, bytes.length - o - 8) / 2 / channels);
      const pcm = new Int16Array(n);
      for (let i = 0; i < n; i++) pcm[i] = v.getInt16(o + 8 + i * 2 * channels, true);
      return { pcm, sampleRate: rate };
    }
    o += 8 + size + (size % 2);
  }
  throw new Error('WAV file has no data');
}

/** Linear-interpolation resample (speech quality is ample for 16/24 -> 48 kHz). */
export function resample(pcm: Int16Array, from: number, to: number): Int16Array {
  if (from === to) return pcm;
  const n = Math.floor((pcm.length * to) / from);
  const out = new Int16Array(n);
  const step = from / to;
  for (let i = 0; i < n; i++) {
    const x = i * step;
    const j = Math.floor(x);
    const f = x - j;
    const a = pcm[j] ?? 0;
    const b = pcm[j + 1] ?? a;
    out[i] = Math.round(a + (b - a) * f);
  }
  return out;
}

/**
 * Energy voice-activity detection for a student given the floor: collects
 * an utterance from the first loud frame until `hangMs` of quiet, with a
 * little audio before the onset so the first syllable is kept. Pure:
 * feed 10 ms frames, get finished utterances.
 */
export class Utterances {
  private pre: Int16Array[] = [];
  private cur: Int16Array[] | null = null;
  private quietMs = 0;
  private noise = 300;

  constructor(
    readonly sampleRate: number,
    private readonly hangMs = 700,
    private readonly maxMs = 20_000
  ) {}

  /** Inside an utterance (someone is talking). */
  get active(): boolean {
    return this.cur !== null;
  }

  /** One frame in; a finished utterance out (or null). */
  push(frame: Int16Array): Int16Array | null {
    let e = 0;
    for (let i = 0; i < frame.length; i++) e += frame[i]! * frame[i]!;
    const rms = Math.sqrt(e / Math.max(1, frame.length));
    const ms = (frame.length / this.sampleRate) * 1000;
    const loud = rms > Math.max(500, this.noise * 3);
    if (!this.cur) {
      if (!loud) this.noise = this.noise * 0.95 + rms * 0.05;
      this.pre.push(frame);
      if (this.pre.length > 20) this.pre.shift();
      if (loud) {
        this.cur = [...this.pre];
        this.pre = [];
        this.quietMs = 0;
      }
      return null;
    }
    this.cur.push(frame);
    this.quietMs = loud ? 0 : this.quietMs + ms;
    const total = this.cur.reduce((s, f) => s + f.length, 0);
    if (this.quietMs >= this.hangMs || (total / this.sampleRate) * 1000 >= this.maxMs) {
      const out = new Int16Array(total);
      let o = 0;
      for (const f of this.cur) {
        out.set(f, o);
        o += f.length;
      }
      this.cur = null;
      // Too short to be words (a cough, a click).
      return total / this.sampleRate >= 0.4 ? out : null;
    }
    return null;
  }
}
