import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BOARD_MAX_H,
  PAGE_H,
  PAGE_W,
  applyOp,
  cleanDoc,
  cleanItem,
  clampScroll,
  contentBottom,
  emptyDoc,
  pageBand,
  studentOpAllowed,
  type Doc,
} from '../src/lib/whiteboard/model';
import { bandView, itemsInBand, shownBand, visibleH } from '../src/lib/whiteboard/render';
import { WhiteboardSession } from '../src/lib/whiteboard/session';
import { ASSET_MAX_BYTES, assetBytesValid, assetId } from '../src/lib/whiteboardAssets';
import { pdfScale, PDF_MAX_PAGES } from '../src/lib/whiteboard/pdfImport';
import { bodyLimitFor } from '../src/lib/bodyLimit';

const src = (p: string) => readFileSync(`src/${p}`, 'utf8');

test('one long page: fixed top edge, runs far down, fixed width', () => {
  assert.equal(PAGE_W, 1920);
  assert.equal(BOARD_MAX_H, PAGE_H * 200);
  assert.equal(clampScroll(-500), 0); // never above the top edge
  assert.equal(clampScroll(5000), 5000);
  assert.equal(clampScroll(BOARD_MAX_H * 2, PAGE_H), BOARD_MAX_H - PAGE_H);
  // Ink far down the page is kept, not clipped to the first screen.
  const s = cleanItem({ k: 'stroke', id: 's1', by: 't', c: '#111111', w: 4, pts: [100, 50_000, 200, 50_100] });
  assert.deepEqual(s && s.k === 'stroke' ? s.pts : null, [100, 50_000, 200, 50_100]);
  const t = cleanItem({ k: 'text', id: 'x1', by: 't', c: '#111111', size: 24, x: 10, y: 90_000, text: 'deep' });
  assert.equal(t && t.k === 'text' ? t.y : null, 90_000);
});

test('teacher scroll is a view op: students follow, snapshots keep it, students cannot send it', () => {
  const doc: Doc = emptyDoc();
  const p = doc.pages[0]!;
  assert.deepEqual(pageBand(p), { y: 0, h: PAGE_H });
  assert.equal(applyOp(doc, { k: 'view', p: p.id, y: 4321, h: 900 }), true);
  assert.deepEqual(pageBand(p), { y: 4321, h: 900 });
  assert.equal(applyOp(doc, { k: 'view', p: p.id, y: 4321, h: 900 }), false); // no change
  applyOp(doc, { k: 'view', p: p.id, y: -10, h: 900 });
  assert.equal(p.y, 0);
  const back = cleanDoc(JSON.parse(JSON.stringify(doc)));
  assert.deepEqual(back && pageBand(back.pages[0]!), { y: 0, h: 900 });
  assert.equal(studentOpAllowed({ k: 'view', p: p.id, y: 10, h: 900 }, 'student_x', doc), false);
  // Scrolling does not rebuild the drawing layer (the view key does that).
  const s = new WhiteboardSession(emptyDoc(), true);
  const before = s.structVersion;
  s.apply([{ k: 'view', p: s.doc.pages[0]!.id, y: 100, h: 900 }]);
  assert.equal(s.structVersion, before);
});

test('content bottom: where the PDF import starts and how far the export goes', () => {
  const doc = emptyDoc();
  const p = doc.pages[0]!;
  assert.equal(contentBottom(p), 0);
  applyOp(doc, { k: 'add', p: p.id, item: { k: 'img', id: 'i1', by: 't', src: 'asset:0123456789abcdef0123456789abcdef', x: 160, y: 3000, w: 1600, h: 2000 } });
  assert.equal(contentBottom(p), 5000);
});

test('views: teacher fills the width; students fit the teacher band, top aligned', () => {
  const edit = bandView(1280, 720, { y: 2000, h: PAGE_H }, 'edit');
  assert.equal(edit.scale, 1280 / 1920);
  assert.equal(edit.tx, 0);
  assert.equal(edit.ty, -2000 * edit.scale);
  assert.equal(visibleH(edit, 720), 1080);
  // Phone in portrait: width-limited, shows the band and more below it.
  const phone = bandView(390, 800, { y: 2000, h: 1080 }, 'follow');
  assert.equal(phone.scale, 390 / 1920);
  assert.ok(shownBand(phone, 800).y0 === 2000 && shownBand(phone, 800).y1 > 3080);
  // Wide short screen: height-limited, the whole band still shows.
  const wide = bandView(1600, 400, { y: 2000, h: 1080 }, 'follow');
  assert.equal(wide.scale, 400 / 1080);
  assert.ok(Math.abs(shownBand(wide, 400).y1 - 3080) < 1e-6);
  const items = [
    { k: 'text' as const, id: 'a', by: 't', c: '#111111', size: 24, x: 0, y: 100, text: 'top' },
    { k: 'text' as const, id: 'b', by: 't', c: '#111111', size: 24, x: 0, y: 2500, text: 'here' },
  ];
  assert.deepEqual(itemsInBand(items, 2000, 3080).map((i) => i.id), ['b']);
});

test('board pictures: uploaded once as assets, referenced by id', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  assert.equal(assetBytesValid(jpeg, 'image/jpeg'), true);
  assert.equal(assetBytesValid(png, 'image/png'), true);
  assert.equal(assetBytesValid(png, 'image/jpeg'), false); // type must match the bytes
  assert.equal(assetBytesValid(jpeg, 'image/svg+xml'), false);
  assert.equal(assetBytesValid(new Uint8Array(ASSET_MAX_BYTES + 1).fill(0xff), 'image/jpeg'), false);
  assert.match(assetId(jpeg), /^[a-f0-9]{32}$/);
  assert.equal(assetId(jpeg), assetId(new Uint8Array(jpeg))); // same picture, same id
  assert.ok(cleanItem({ k: 'img', id: 'i1', by: 't', src: `asset:${assetId(jpeg)}`, x: 0, y: 0, w: 10, h: 10 }));
  assert.equal(cleanItem({ k: 'img', id: 'i1', by: 't', src: 'asset:../../etc', x: 0, y: 0, w: 10, h: 10 }), null);
  assert.equal(cleanItem({ k: 'img', id: 'i1', by: 't', src: 'https://evil.example/x.png', x: 0, y: 0, w: 10, h: 10 }), null);
  assert.equal(bodyLimitFor('/api/rooms/ABC/whiteboard/asset'), 8 * 1024 * 1024);
  const post = src('app/api/rooms/[code]/whiteboard/asset/route.ts');
  assert.match(post, /room\.teacherId !== teacher\.id/);
  assert.match(post, /readBodyCapped\(req, ASSET_MAX_BYTES\)/);
  const get = src('app/api/rooms/[code]/whiteboard/asset/[id]/route.ts');
  assert.match(get, /!access\.isTeacher && !admitted && adminApiDenied/);
  assert.match(get, /X-Content-Type-Options': 'nosniff'/);
  assert.match(src('lib/teacherRoom.ts'), /clearAssets\(code\)/);
});

test('PDF import: pages rendered as pictures, capped, stacked below the content', () => {
  assert.equal(PDF_MAX_PAGES, 40);
  // Imported pages carry a thin outline; it survives the network clean-up.
  const page = cleanItem({ k: 'img', id: 'p1', by: 't', src: 'asset:0123456789abcdef0123456789abcdef', x: 0, y: 0, w: 10, h: 10, bd: 1 });
  assert.equal(page && page.k === 'img' ? page.bd : null, 1);
  const pic = cleanItem({ k: 'img', id: 'p2', by: 't', src: 'asset:0123456789abcdef0123456789abcdef', x: 0, y: 0, w: 10, h: 10, bd: 'x' });
  assert.equal(pic && pic.k === 'img' ? pic.bd : 'missing', undefined);
  assert.match(src('lib/whiteboard/render.ts'), /if \(it\.bd\) \{/);
  assert.equal(pdfScale(800), 2); // A4 width ~595 pt / letter 612 pt render ~1600 px
  assert.equal(pdfScale(100), 3); // never more than 3×
  const board = src('lib/whiteboard/WhiteboardBoard.tsx');
  assert.match(board, /const startY = Math\.max\(40, contentBottom\(pg\) \+ 80\)/);
  assert.match(board, /application\/pdf/);
  assert.match(board, /undoRef\.current\.push\(\{ redo: ops, undo: \[\{ k: 'del', p: pg\.id, ids \}\] \}\)/);
  assert.match(src('components/classroom/Whiteboard.tsx'), /uploadImage=\{uploadImage\}/);
  assert.match(readFileSync('scripts/copy-voice-assets.mjs', 'utf8'), /pdfjs-dist\/legacy\/build\/pdf\.worker\.min\.mjs/);
});

test('teacher scrolls with wheel, two fingers, PgUp/PgDn and the rail', () => {
  const board = src('lib/whiteboard/WhiteboardBoard.tsx');
  assert.match(board, /if \(px\) scrollBy\(px \/ viewRef\.current\.scale\)/);
  assert.match(board, /e\.key === 'PageDown'\) scrollBy\(bandH \* 0\.85\)/);
  assert.match(board, /data-testid="wb-scroll"/);
  assert.match(board, /send\(\[\{ k: 'view', p: pg\.id, y, h: bandH \}\]\)/);
});
