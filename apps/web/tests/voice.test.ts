import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { defaultVoiceSettings, needsGraph, parseVoiceSettings, planLabel, planVoice, type VoiceEnv } from '../src/lib/audio/voiceSettings';

const desktop: VoiceEnv = { worklet: true, wasm: true, cores: 8, phone: false };

test('voice settings: defaults, parsing and bad input', () => {
  assert.deepEqual(defaultVoiceSettings(true), { noise: 'enhanced', focus: true });
  assert.deepEqual(defaultVoiceSettings(false), { noise: 'enhanced', focus: false });
  assert.deepEqual(parseVoiceSettings('{"noise":"strong","focus":false}', true), { noise: 'strong', focus: false });
  assert.deepEqual(parseVoiceSettings('{"noise":"loud","focus":"yes"}', true), { noise: 'enhanced', focus: true });
  assert.deepEqual(parseVoiceSettings('not json', false), { noise: 'enhanced', focus: false });
  assert.deepEqual(parseVoiceSettings(null, false), defaultVoiceSettings(false));
});

test('voice plan: per device and role, browser suppression only when no denoiser runs', () => {
  assert.deepEqual(planVoice({ noise: 'enhanced', focus: true }, desktop, true), { denoiser: 'rnnoise', focus: true, browserNs: false });
  // Students never get voice focus, even if a stored setting says so.
  assert.deepEqual(planVoice({ noise: 'enhanced', focus: true }, desktop, false), { denoiser: 'rnnoise', focus: false, browserNs: false });
  assert.equal(planVoice({ noise: 'strong', focus: false }, desktop, true).denoiser, 'gtcrn');
  // Strong is too heavy for phones and 2-core machines: RNNoise instead.
  assert.equal(planVoice({ noise: 'strong', focus: false }, { ...desktop, phone: true }, false).denoiser, 'rnnoise');
  assert.equal(planVoice({ noise: 'strong', focus: false }, { ...desktop, cores: 2 }, false).denoiser, 'rnnoise');
  const std = planVoice({ noise: 'standard', focus: true }, desktop, true);
  assert.deepEqual(std, { denoiser: null, focus: true, browserNs: true });
  assert.equal(needsGraph(std), true);
  assert.equal(needsGraph(planVoice({ noise: 'standard', focus: false }, desktop, true)), false);
  // No AudioWorklet (old browsers): the plain browser-processed mic.
  assert.deepEqual(planVoice({ noise: 'strong', focus: true }, { ...desktop, worklet: false }, true), { denoiser: null, focus: false, browserNs: true });
  // No WebAssembly: voice focus still runs, suppression stays the browser's.
  assert.deepEqual(planVoice({ noise: 'enhanced', focus: true }, { ...desktop, wasm: false }, true), { denoiser: null, focus: true, browserNs: true });
  assert.equal(planLabel({ denoiser: 'rnnoise', focus: true, browserNs: false }), 'Enhanced noise removal + voice focus');
  assert.equal(planLabel({ denoiser: null, focus: false, browserNs: true }), 'Browser noise suppression');
});

type Focus = {
  process(input: Float32Array, output: Float32Array): void;
  gain: number;
  speech: number;
  enabled: boolean;
};
type FocusCtor = new (sampleRate: number, opts?: { range?: number }) => Focus;

/** The worklet file as the browser loads it, with a stub AudioWorklet scope. */
function loadFocus(): { VoiceFocus: FocusCtor; registered: string[] } {
  const src = fs.readFileSync(path.join(__dirname, '../public/audio/voice-focus-worklet.js'), 'utf8');
  const registered: string[] = [];
  const scope: Record<string, unknown> = {
    sampleRate: 48000,
    AudioWorkletProcessor: class {
      port = { onmessage: null };
    },
    registerProcessor: (name: string) => registered.push(name),
  };
  scope.globalThis = scope;
  vm.runInNewContext(src, scope);
  return { VoiceFocus: scope.__VoiceFocus as FocusCtor, registered };
}

const BLOCK = 128;
const LOOK = 3;

function tone(db: number, blocks: number, f = 220): Float32Array[] {
  const a = Math.SQRT2 * 10 ** (db / 20);
  const out: Float32Array[] = [];
  for (let b = 0; b < blocks; b++) {
    const x = new Float32Array(BLOCK);
    for (let i = 0; i < BLOCK; i++) x[i] = a * Math.sin((2 * Math.PI * f * (b * BLOCK + i)) / 48000);
    out.push(x);
  }
  return out;
}

function run(f: Focus, blocks: Float32Array[]): Float32Array[] {
  return blocks.map((x) => {
    const y = new Float32Array(BLOCK);
    f.process(x, y);
    return y;
  });
}

function db(x: Float32Array): number {
  let e = 0;
  for (const v of x) e += v * v;
  return 10 * Math.log10(e / x.length + 1e-12);
}

test('voice focus: registers its processor; output is the input delayed by the look-ahead', () => {
  const { VoiceFocus, registered } = loadFocus();
  assert.deepEqual(registered, ['voice-focus']);
  const f = new VoiceFocus(48000);
  const input = tone(-20, 40);
  const out = run(f, input);
  for (let b = LOOK; b < 40; b++) assert.ok(Math.abs(db(out[b]) - db(input[b - LOOK])) < 0.01, `block ${b} passes at unity`);
  assert.ok(out.flatMap((x) => [...x]).every(Number.isFinite));
});

test('voice focus: learns the speaking level, turns down sound far below it, opens before an onset', () => {
  const { VoiceFocus } = loadFocus();
  const f = new VoiceFocus(48000, { range: 18 });
  assert.ok(Number.isNaN(f.speech), 'nothing learned yet: never turns down');
  run(f, tone(-70, 100)); // room before the teacher speaks
  run(f, tone(-18, 400)); // ~1 s of the teacher speaking
  assert.ok(f.speech > -20 && f.speech < -16, `speech level learned (${f.speech.toFixed(1)})`);
  // Distant voice 30 dB under the teacher for 1 s: turned down after the hold.
  const far = run(f, tone(-48, 400, 300));
  const tail = far.slice(-50);
  const gainDb = tail.reduce((s, y) => s + db(y), 0) / tail.length + 48;
  assert.ok(gainDb < -20, `far voice attenuated (${gainDb.toFixed(1)} dB)`);
  // Sound just under the threshold is only slightly reduced (2 dB per dB).
  // Once closed, sound 2 dB under the threshold is only slightly reduced
  // (2 dB per dB); once open, it would stay open down to 6 dB under it.
  const g = new VoiceFocus(48000, { range: 18 });
  run(g, tone(-70, 100));
  run(g, tone(-18, 400));
  run(g, tone(-60, 400));
  const near = run(g, tone(-38, 400));
  const nearDb = near.slice(-50).reduce((s, y) => s + db(y), 0) / 50 + 38;
  assert.ok(nearDb > -6 && nearDb < -2, `2 dB under threshold -> about -4 dB (${nearDb.toFixed(1)})`);
  // The teacher speaks again: the first block of the word goes out at full level.
  const again = run(g, [...tone(-18, 10), ...tone(-120, LOOK)]);
  assert.ok(Math.abs(db(again[LOOK]) + 18) < 1.5, `onset not clipped (${db(again[LOOK]).toFixed(1)} dB)`);
});

test('voice focus: a door slam does not raise the learned level; a speaker who never paused is left alone', () => {
  const { VoiceFocus } = loadFocus();
  const f = new VoiceFocus(48000, { range: 18 });
  run(f, tone(-70, 100));
  for (let i = 0; i < 8; i++) run(f, [...tone(-24, 300), ...tone(-70, 60)]); // ~8 s of speech with pauses
  const before = f.speech;
  run(f, tone(-2, 40)); // 0.1 s bang, 22 dB louder
  assert.ok(Math.abs(f.speech - before) <= 1, `level held (${before} -> ${f.speech})`);
  // Speech right after the bang is not turned down.
  const after = run(f, tone(-26, 200));
  assert.ok(after.slice(-50).every((y) => db(y) > -27.5), 'speech after the bang passes');
  // No quieter block ever seen: the floor is the speech itself, nothing is learned, nothing turned down.
  const g = new VoiceFocus(48000);
  const all = run(g, tone(-20, 400));
  assert.ok(Number.isNaN(g.speech));
  assert.ok(Math.abs(db(all[399]) + 20) < 1);
});

test('voice focus: never turns down while disabled, and stays finite on silence', () => {
  const { VoiceFocus } = loadFocus();
  const f = new VoiceFocus(48000);
  f.enabled = false;
  run(f, tone(-18, 400));
  const quiet = tone(-60, 400);
  const out = run(f, quiet);
  assert.deepEqual([...out[399]], [...quiet[399 - LOOK]], 'passed through untouched');
  const s = new VoiceFocus(48000);
  const z = run(s, tone(-200, 100));
  assert.ok(z.every((y) => y.every(Number.isFinite)));
});

test('voice assets: vendored worklets register the processor names the app creates', () => {
  const dist = path.join(__dirname, '../node_modules/@sapphi-red/web-noise-suppressor/dist');
  if (!fs.existsSync(dist)) return; // installed by npm ci in CI
  const app = fs.readFileSync(path.join(__dirname, '../src/lib/audio/voiceProcessor.ts'), 'utf8');
  const copy = fs.readFileSync(path.join(__dirname, '../scripts/copy-voice-assets.mjs'), 'utf8');
  for (const [file, name] of [
    ['rnnoise/workletProcessor.js', 'rnnoise'],
    ['gtcrn/workletProcessor.js', 'gtcrn'],
  ]) {
    const id = `@sapphi-red/web-noise-suppressor/${name}`;
    assert.ok(fs.readFileSync(path.join(dist, file), 'utf8').includes(`registerProcessor(\`${id}\``), `${file} registers ${id}`);
    assert.ok(app.includes(`'${id}'`), `voiceProcessor creates ${id}`);
    assert.ok(copy.includes(`'${file}'`), `copy script ships ${file}`);
  }
  for (const f of ['vendor/rnnoise-worklet.js', 'vendor/rnnoise_simd.wasm', 'vendor/rnnoise.wasm', 'vendor/gtcrn-worklet.js', 'vendor/gtcrn.wasm']) {
    assert.ok(app.includes(`'${f}'`) || app.includes(`'${f.replace('_simd', '')}'`), `voiceProcessor loads ${f}`);
    assert.ok(copy.includes(`'${path.basename(f)}'`), `copy script publishes ${f}`);
  }
});
