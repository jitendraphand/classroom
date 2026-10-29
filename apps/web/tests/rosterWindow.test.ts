import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ROSTER_PAGE, rosterWindow } from '../src/lib/rosterWindow';

test('roster window: first page, then more on request; small classes render whole', () => {
  const rows = Array.from({ length: 2500 }, (_, i) => i);
  const a = rosterWindow(rows, ROSTER_PAGE);
  assert.equal(a.shown.length, ROSTER_PAGE);
  assert.equal(a.hidden, 2500 - ROSTER_PAGE);
  assert.equal(a.next, ROSTER_PAGE);
  const b = rosterWindow(rows, 2400);
  assert.equal(b.hidden, 100);
  assert.equal(b.next, 100);
  const small = rosterWindow([1, 2, 3], ROSTER_PAGE);
  assert.deepEqual(small, { shown: [1, 2, 3], hidden: 0, next: 0 });
  assert.equal(rosterWindow(rows, 0).shown.length, ROSTER_PAGE, 'never less than a page');
});

test('chat shows at most 40 raised-hand chips and counts the rest', async () => {
  const React = await import('react');
  const { createElement } = React;
  // tsx compiles the component's JSX with the classic runtime (tsconfig jsx: preserve).
  (globalThis as { React?: unknown }).React = React;
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { ChatView } = await import('../src/components/classroom/Chat');
  const hands = Array.from({ length: 300 }, (_, i) => ({ id: `p${i}`, displayName: `Student ${i}` }));
  const html = renderToStaticMarkup(
    createElement(ChatView, {
      thread: { messages: [], ended: false, sending: false, error: '', send: async () => true },
      isTeacher: true,
      myParticipantId: 't1',
      students: hands,
      raisedHands: hands,
      onLowerHand: () => undefined,
    })
  );
  assert.equal(html.match(/class="chat-hand-name"/g)?.length, 40);
  assert.match(html, /\+260 more/);
  assert.match(html, /aria-label="300 raised hands"/);
});

test('share HUD pages its roster, waiting list and hands like the main roster', () => {
  const hud = readFileSync(new URL('../src/components/classroom/TeacherShareHud.tsx', import.meta.url), 'utf8');
  for (const list of ['filterPeople(students, rosterQuery), rosterLimit', 'filterPeople(waiting, rosterQuery), waitingLimit', 'rosterWindow(hands, handsLimit)']) {
    assert.ok(hud.includes(list), list);
  }
  assert.doesNotMatch(hud, /\bhands\.map\(/);
});
