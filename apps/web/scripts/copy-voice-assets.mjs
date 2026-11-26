#!/usr/bin/env node
/**
 * Copies the noise-suppression worklets and WebAssembly models from
 * @sapphi-red/web-noise-suppressor (pinned, MIT; RNNoise BSD-3, GTCRN MIT)
 * into public/audio/vendor, where the classroom loads them on demand the
 * first time a microphone is turned on (lib/audio/voiceProcessor.ts). Runs
 * before `next dev` and `next build`; the output is not committed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(here, '..');
const pkg = path.join(web, 'node_modules/@sapphi-red/web-noise-suppressor/dist');
const out = path.join(web, 'public/audio/vendor');

/** [source under dist, published name] */
const VOICE_ASSETS = [
  ['rnnoise/workletProcessor.js', 'rnnoise-worklet.js'],
  ['rnnoise.wasm', 'rnnoise.wasm'],
  ['rnnoise_simd.wasm', 'rnnoise_simd.wasm'],
  ['gtcrn/workletProcessor.js', 'gtcrn-worklet.js'],
  ['gtcrn.wasm', 'gtcrn.wasm'],
];

if (!fs.existsSync(pkg)) {
  // Not fatal: the classroom falls back to the browser's own noise suppression.
  console.warn('copy-voice-assets: @sapphi-red/web-noise-suppressor is not installed; enhanced noise removal will be unavailable');
  process.exit(0);
}
fs.mkdirSync(out, { recursive: true });
for (const [from, to] of VOICE_ASSETS) fs.copyFileSync(path.join(pkg, from), path.join(out, to));
console.log(`copy-voice-assets: ${VOICE_ASSETS.length} files -> public/audio/vendor`);

// Whiteboard PDF import (lib/whiteboard/pdfImport.ts): the pdf.js worker, legacy
// build (older Safari / Chrome on tablets), served from /pdfjs on demand.
const pdfWorker = path.join(web, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs');
if (fs.existsSync(pdfWorker)) {
  const pdfOut = path.join(web, 'public/pdfjs');
  fs.mkdirSync(pdfOut, { recursive: true });
  fs.copyFileSync(pdfWorker, path.join(pdfOut, 'pdf.worker.min.mjs'));
  console.log('copy-voice-assets: pdf.js worker -> public/pdfjs');
} else {
  console.warn('copy-voice-assets: pdfjs-dist is not installed; whiteboard PDF import will be unavailable');
}
