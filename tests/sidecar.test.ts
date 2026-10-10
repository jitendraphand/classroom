import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { controlLine, cropFractions, inkMessage, isSidecarIdentity, sidecarInit, SIDECAR_PUBLISH_TIMEOUT_MS } from '../src/shared/sidecar';

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
const rs = readFileSync(new URL('../native/share-sidecar/src/main.rs', import.meta.url), 'utf8');

const media = { slidesFps: 8, videoFps: 24, maxBitrate: 700_000, videoBitrate: 1_500_000 };

test('sidecar init: validated, VP9, hardware-preferred, fps clamped', () => {
  assert.equal(sidecarInit({ url: 'http://x', token: 'a'.repeat(30) }, media), null);
  assert.equal(sidecarInit({ url: 'wss://x', token: 'short' }, media), null);
  const i = sidecarInit({ url: 'wss://lk.example', token: 't'.repeat(40), fps: 5, videoFps: 99, audio: true }, media)!;
  assert.equal(i.codec, 'vp9');
  assert.equal(i.encoder, 'hardware');
  assert.equal(i.fps, 5);
  assert.equal(i.videoFps, 30);
  assert.equal(i.audio, true);
  assert.equal(i.videoBitrate, 1_500_000);
});

test('sidecar identity and region crop fractions', () => {
  assert.ok(isSidecarIdentity('teacher_abc__screen'));
  assert.ok(!isSidecarIdentity('student_abc__screen'));
  assert.ok(!isSidecarIdentity('teacher_abc'));
  assert.deepEqual(cropFractions({ x: 960, y: 0, w: 960, h: 540 }, { x: 0, y: 0, w: 1920, h: 1080 }), { x: 0.5, y: 0, w: 0.5, h: 0.5 });
  assert.deepEqual(cropFractions({ x: 1920 + 480, y: 270, w: 960, h: 540 }, { x: 1920, y: 0, w: 1920, h: 1080 }), { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
  assert.equal(cropFractions(null, { x: 0, y: 0, w: 1, h: 1 }), null);
});

test('control + ink wire format matches the Rust reader', () => {
  assert.equal(controlLine({ op: 'mode', videoMode: true }), '{"op":"mode","videoMode":true}\n');
  const msg = inkMessage({ fw: 4, fh: 4, x: 1, y: 1, w: 1, h: 1, rgba: new Uint8Array([1, 2, 3, 4]) });
  const nl = msg.indexOf(10);
  const head = JSON.parse(msg.subarray(0, nl).toString());
  assert.deepEqual(head, { op: 'ink', fw: 4, fh: 4, x: 1, y: 1, w: 1, h: 1, bytes: 4 });
  assert.deepEqual([...msg.subarray(nl + 1)], [1, 2, 3, 4]);
  assert.equal(inkMessage(null).toString(), '{"op":"ink-clear"}\n');
  for (const op of ['"mode"', '"fps"', '"audio"', '"ink"', '"ink-clear"', '"stop"']) assert.ok(rs.includes(op), op);
});

test('sidecar publishes VP9 L1T3 (VP8 retry), screen share + loopback audio, music quality', () => {
  assert.match(rs, /VideoCodec::VP9, Some\("L1T3"\.into\(\)\)/);
  assert.match(rs, /VideoCodec::VP8, None/);
  assert.match(rs, /TrackSource::Screenshare/);
  assert.match(rs, /source: TrackSource::ScreenshareAudio, dtx: false, red: false/);
  assert.match(rs, /VideoEncoderBackend::Hardware/);
  assert.match(rs, /BELOW_NORMAL_PRIORITY_CLASS/);
  assert.match(rs, /composite_ink\(&mut work/);
  assert.match(rs, /auto_subscribe = false/);
});

test('main falls back to Electron publishing when the sidecar does not publish', () => {
  const main = src('main/main.ts');
  assert.ok(SIDECAR_PUBLISH_TIMEOUT_MS >= 10_000);
  assert.match(main, /fallback to Electron publishing/);
  assert.match(main, /publisher = 'sidecar'/);
  assert.match(main, /if \(sidecarActive\(\)\) \{\s*wgc\.send\(inkMessage\(inkLayer\)\)/);
  assert.match(main, /controlLine\(\{ op: 'stop' \}\)/);
  const cs = src('renderer/classSession.ts');
  assert.match(cs, /'\/screen-token'/);
  assert.match(cs, /started\.publisher === 'sidecar'/);
  assert.match(cs, /\^teacher_\.\*__screen\$/);
  const yml = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8');
  assert.match(yml, /share-sidecar\.exe/);
  assert.ok(existsSync(new URL('../scripts/build-sidecar.sh', import.meta.url)));
});
