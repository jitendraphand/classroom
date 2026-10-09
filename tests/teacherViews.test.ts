import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PanelSnapshot } from '../src/shared/actions';
import type { AdmittedPerson } from '../src/shared/apiModel';
import { ChatView, RosterView } from '../src/renderer/teacherViews';

function person(over: Partial<AdmittedPerson>): AdmittedPerson {
  return {
    id: 'p',
    displayName: 'Asha Rao',
    role: 'STUDENT',
    livekitIdentity: 'p',
    mutedByTeacher: false,
    handRaised: false,
    handRaisedAt: null,
    pinned: false,
    pinnedAt: null,
    focus: null,
    rollNumber: null,
    gradeDivision: 'CC · 7-A',
    late: false,
    onTimetable: true,
    sid: 'S100',
    drawRequested: false,
    drawRequestedAt: null,
    drawing: false,
    ...over,
  };
}

function snap(over: Partial<PanelSnapshot['hud']> = {}): PanelSnapshot {
  return {
    hud: {
      inClass: true,
      sharing: true,
      shareKind: 'screen',
      captureMode: 'wgc-exclude',
      captureLabel: '',
      captureDetail: '',
      micOn: true,
      camOn: true,
      annotateOn: false,
      videosOn: false,
      waitingRoomOn: true,
      layout: 4,
      classLabel: 'Math',
      waitingCount: 2,
      hands: 1,
      focusAlerts: 0,
      unread: 0,
      oldestWaitingId: 'w1',
      oldestWaitingName: 'Ravi',
      videoMode: false,
      videoModeAuto: true,
      drawRequests: 1,
      drawHolderName: 'Meera',
      drawStrokes: 3,
      notice: '',
      ...over,
    },
    admitted: [
      person({ id: 'a', displayName: 'Asha Rao', handRaised: true, handRaisedAt: 1, mutedByTeacher: true, late: true }),
      person({ id: 'b', displayName: 'Bilal', sid: 'S200', drawRequested: true, drawRequestedAt: 2 }),
      person({ id: 'm', displayName: 'Meera', sid: 'S300', drawing: true, focus: 'left' }),
      person({ id: 't', displayName: 'Teacher', role: 'TEACHER', sid: null }),
    ],
    waiting: [
      { id: 'w1', displayName: 'Ravi', createdAt: null, gradeDivision: 'CC · 7-B', late: true },
      { id: 'w2', displayName: 'Zoya', createdAt: null, gradeDivision: null, late: false },
    ],
    messages: [
      {
        id: 'm1',
        senderParticipantId: 'a',
        senderName: 'Asha Rao',
        senderRole: 'STUDENT',
        body: 'Question <b>1</b>',
        scope: 'TEACHER',
        recipientParticipantId: null,
        recipientName: null,
        createdAt: '2026-10-09T10:00:00Z',
      },
    ],
    chatTo: 'b',
    meId: 't',
    devices: [],
    micId: '',
    camId: '',
  };
}

test('roster renders the website labels, rows and draw controls', () => {
  const html = renderToStaticMarkup(createElement(RosterView, { snap: snap(), send: () => {} }));
  for (const text of ['Waiting (2)', 'All', 'Mute all', 'Unmute all', 'Waiting room', 'Search name or SID…', 'Meera is drawing', 'Clear drawing', 'Revoke', 'Allow', 'Left fullscreen', 'Late', 'CC · 7-A']) {
    assert.ok(html.includes(text), `missing ${text}`);
  }
  assert.ok(html.includes('aria-label="Unmute Asha Rao"'));
  assert.ok(html.includes('aria-label="Lower Asha Rao&#x27;s hand"'));
  assert.ok(html.includes('aria-label="Asks to draw"'));
  assert.ok(html.includes('aria-label="Drawing on your screen"'));
  assert.ok(!html.includes('>Teacher<'), 'teacher is not a roster row');
  const off = renderToStaticMarkup(createElement(RosterView, { snap: { ...snap({ waitingRoomOn: false, sharing: false }), waiting: [] }, send: () => {} }));
  assert.ok(off.includes('Direct entry'));
  assert.ok(!off.includes('Waiting ('));
  assert.ok(!off.includes('is drawing'), 'draw strip only while sharing');
});

test('chat renders hands, search, To with SID, DM placeholder and escapes text', () => {
  const html = renderToStaticMarkup(createElement(ChatView, { snap: snap(), send: () => {} }));
  for (const text of ['Search students (name / SID) or messages…', 'Back to Everyone', 'Bilal · S200', 'Private message to Bilal…', 'To teacher', 'Lower hand']) {
    assert.ok(html.includes(text), `missing ${text}`);
  }
  assert.ok(html.includes('Question &lt;b&gt;1&lt;/b&gt;'), 'message text is escaped');
  assert.ok(html.includes('aria-label="Reply to Asha Rao"'));
});
