/**
 * Bundle the main process, the preload, and the renderer pages.
 * livekit-client is bundled into the engine page (browser build).
 */
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

fs.mkdirSync('dist/renderer', { recursive: true });

// A school's build can bake in its server: CLASSROOM_DEFAULT_SERVER=https://… npm run build
const shared = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  define: { 'process.env.CLASSROOM_DEFAULT_SERVER': JSON.stringify(process.env.CLASSROOM_DEFAULT_SERVER || '') },
};

await esbuild.build({
  ...shared,
  entryPoints: ['src/main/main.ts'],
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/main.js',
  external: ['electron'],
  target: 'node20',
});

await esbuild.build({
  ...shared,
  entryPoints: ['src/preload/preload.ts'],
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/preload.js',
  external: ['electron'],
  target: 'node20',
});

await esbuild.build({
  ...shared,
  entryPoints: {
    engine: 'src/renderer/engine.ts',
    toolbar: 'src/renderer/toolbar.tsx',
    panel: 'src/renderer/panel.tsx',
    videos: 'src/renderer/videos.tsx',
    annotate: 'src/renderer/annotate.ts',
    region: 'src/renderer/region.ts',
    captureTest: 'src/renderer/captureTest.tsx',
    tools: 'src/renderer/tools.tsx',
    whiteboard: 'src/renderer/whiteboard.tsx',
  },
  outdir: 'dist/renderer',
  format: 'esm',
  platform: 'browser',
  jsx: 'automatic',
  target: 'chrome128',
  conditions: ['browser', 'import', 'default'],
  mainFields: ['browser', 'module', 'main'],
  define: { ...shared.define, 'process.env.NODE_ENV': '"production"' },
});

const srcDir = 'src/renderer';
for (const file of fs.readdirSync(srcDir)) {
  if (file.endsWith('.html') || file.endsWith('.css')) {
    fs.copyFileSync(path.join(srcDir, file), path.join('dist/renderer', file));
  }
}
console.log('bundled dist/');
