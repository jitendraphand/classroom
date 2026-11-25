import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Nov 25: no "Allow all to unmute" anywhere; the teacher unmutes students one at a time.
test('no allow-all-unmute control in the teacher app', () => {
  for (const f of ['src/renderer/engine.ts', 'src/renderer/whiteboard.tsx', 'src/renderer/teacherViews.tsx']) {
    const s = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.doesNotMatch(s, /Allow all to unmute/, f);
    assert.doesNotMatch(s, /'mute-all', muted: (false|!)/, f);
  }
});
