import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Reflex, SpeechChunker, pollAnswer, quoteable, triage } from '../src/reflex';
import { Utterances, parseWav, resample, wav } from '../src/speech';
import { BoardHost, wrap, PAGE_H } from '../src/board';
import { outboundProblem } from '../src/tools';

const chat = (from: string, text: string, at = 0) => ({ id: `${from}-${at}-${text}`, from, fromName: from.toUpperCase(), role: 'STUDENT', text, private: false, at });

test('triage: questions, greetings, unsafe, other', () => {
  assert.equal(triage('Why is 2/4 the same as 1/2?'), 'question');
  assert.equal(triage('how do I add fractions'), 'question');
  assert.equal(triage('I dont understand step 2'), 'question');
  assert.equal(triage('my brother hits me'), 'unsafe');
  assert.equal(triage('I got bullied today'), 'unsafe');
  assert.equal(triage('the bully in the story was mean'), 'unsafe', 'broad on purpose: the supervisor glances');
  assert.equal(triage("i don't understand step 2"), 'question');
  assert.equal(triage('Good morning!'), 'greeting');
  assert.equal(triage('ok'), 'greeting');
  assert.equal(triage('someone keeps bullying me'), 'unsafe');
  assert.equal(triage('I want to die'), 'unsafe');
  assert.equal(triage('my number is 98765 43210'), 'unsafe');
  assert.equal(triage('the answer is 3/4'), 'other');
  // Word starts only: "skill" is not "kill".
  assert.equal(triage('this is a useful skill'), 'other');
});

test('poll answers: letters and numbers within range', () => {
  assert.equal(pollAnswer('B', 3), 1);
  assert.equal(pollAnswer('b)', 3), 1);
  assert.equal(pollAnswer('option 3', 3), 2);
  assert.equal(pollAnswer('2', 2), 1);
  assert.equal(pollAnswer('D', 3), null);
  assert.equal(pollAnswer('0', 3), null);
  assert.equal(pollAnswer('I think B', 3), null);
});

test('reflex: digest carries questions as quoted data, then resets', () => {
  const r = new Reflex();
  assert.equal(r.onChat(chat('s1', 'Why is the sky blue?'), 1000), 'question');
  assert.equal(r.onChat(chat('s2', 'hello'), 1000), 'greeting');
  assert.equal(r.onChat({ ...chat('t', 'hi'), role: 'TEACHER' }, 1000), 'other');
  assert.ok(r.pending());
  const d = r.digest(2000);
  assert.equal(d.questions.length, 1);
  assert.equal(d.questions[0]!.text, 'Why is the sky blue?');
  assert.equal(d.greetings, 1);
  const again = r.digest(3000);
  assert.equal(again.questions.length, 0);
  assert.equal(again.greetings, 0);
  assert.ok(!r.pending());
  assert.equal(quoteable('a\u0000b\n\nc'), 'a b c');
  assert.equal(quoteable('x'.repeat(400)).length, 280);
});

test('reflex: per-student chat flood counts as spam', () => {
  const r = new Reflex({ admit: 'roster', chatPerMinute: 3 });
  const kinds = [0, 1, 2, 3, 4].map((i) => r.onChat(chat('s1', `msg ${i}`, i), i * 1000));
  assert.deepEqual(kinds.slice(3), ['spam', 'spam']);
  assert.equal(r.onChat(chat('s2', 'msg'), 5000), 'other', 'other students are unaffected');
  assert.equal(r.onChat(chat('s1', 'later'), 70_000), 'other', 'the window moves on');
  assert.equal(r.digest(70_000).spamDropped, 2);
});

test('reflex: unsafe messages are escalated and logged, not treated as questions', () => {
  const r = new Reflex();
  r.onChat(chat('s1', 'Is it ok if someone hits me at home?'), 1);
  const d = r.digest(2);
  assert.equal(d.questions.length, 0);
  assert.equal(d.escalations.length, 1);
  assert.equal(d.escalations[0]!.from, 's1');
  assert.equal(r.escalationLog.length, 1);
  assert.equal(r.digest(3).escalations.length, 0, 'reported once');
});

test('reflex: hands queue is fair (least recently spoken, then longest waiting)', () => {
  const r = new Reflex();
  r.onHand('a', 'A', true, 100);
  r.onHand('b', 'B', true, 200);
  assert.equal(r.nextHand(), 'a');
  r.onSpoke('a', 300);
  r.onHand('a', 'A', true, 400);
  r.onHand('c', 'C', true, 500);
  assert.equal(r.nextHand(), 'b', 'b never spoke and waited longest');
  r.onSpoke('b', 600);
  assert.equal(r.nextHand(), 'c', 'c never spoke; a already did');
  r.onLeave('c', 'C');
  assert.equal(r.nextHand(), 'a');
  r.onHand('a', 'A', false, 700);
  assert.equal(r.nextHand(), null);
});

test('reflex: admission policy', () => {
  const list = [
    { id: 'w1', name: 'Signed', signed: true },
    { id: 'w2', name: 'Typed a code', signed: false },
  ];
  assert.deepEqual(new Reflex({ admit: 'roster', chatPerMinute: 6 }).onWaiting(list), ['w1']);
  assert.deepEqual(new Reflex({ admit: 'all', chatPerMinute: 6 }).onWaiting(list), ['w1', 'w2']);
  assert.deepEqual(new Reflex({ admit: 'manual', chatPerMinute: 6 }).onWaiting(list), []);
});

test('reflex: poll keeps the latest answer per student and closes on time', () => {
  const r = new Reflex();
  r.openPoll('p', 'Bigger?', ['1/2', '1/3'], 30, 0);
  assert.equal(r.onChat(chat('s1', 'A', 1), 1000), 'answer');
  assert.equal(r.onChat(chat('s2', 'b', 2), 2000), 'answer');
  assert.equal(r.onChat(chat('s1', 'B', 3), 3000), 'answer');
  let res = r.pollResult(4000)!;
  assert.deepEqual(res.counts, [0, 2]);
  assert.equal(res.voters, 2);
  assert.equal(res.open, true);
  assert.equal(r.onChat(chat('s3', 'A', 4), 40_000), 'other', 'after closing, "A" is ordinary chat');
  res = r.pollResult(40_000)!;
  assert.equal(res.open, false);
  assert.deepEqual(res.counts, [0, 2]);
});

test('speech chunker: sentences as they end, long clauses split, rest on flush', () => {
  const c = new SpeechChunker();
  assert.deepEqual(c.push('Good morning, cla'), []);
  assert.deepEqual(c.push('ss! Today we learn'), ['Good morning, class!']);
  assert.deepEqual(c.push(' fractions. W'), ['Today we learn fractions.']);
  assert.deepEqual(c.flush(), ['W']);
  const long = new SpeechChunker();
  const parts = long.push(`${'word '.repeat(50)}`);
  assert.ok(parts.length >= 1 && parts.every((p) => p.length <= 165));
  // Decimals are not sentence ends.
  const d = new SpeechChunker();
  assert.deepEqual(d.push('It is 3.5 metres long. Next'), ['It is 3.5 metres long.']);
});

test('voice activity: one utterance from onset to the hang time, with the onset kept; clicks dropped', () => {
  const rate = 16000;
  const frame = (amp: number) => {
    const f = new Int16Array(160);
    for (let i = 0; i < f.length; i++) f[i] = Math.round(amp * Math.sin(i / 3));
    return f;
  };
  const v = new Utterances(rate, 300);
  let out: Int16Array | null = null;
  for (let i = 0; i < 30; i++) assert.equal(v.push(frame(20)), null);
  for (let i = 0; i < 80 && !out; i++) out = v.push(frame(6000));
  assert.equal(out, null, 'still talking');
  assert.ok(v.active);
  for (let i = 0; i < 40 && !out; i++) out = v.push(frame(20));
  assert.ok(out, 'utterance ends after the hang time');
  assert.ok(out!.length / rate >= 0.8 + 0.2, 'includes pre-roll and the hang');
  assert.ok(!v.active);
  const click = new Utterances(rate, 300);
  let c: Int16Array | null = null;
  click.push(frame(9000));
  for (let i = 0; i < 40 && !c; i++) c = click.push(frame(20));
  assert.equal(c, null, 'a 10 ms click is not speech');
});

test('wav round trip and resampling', () => {
  const pcm = new Int16Array([0, 1000, -1000, 32767, -32768]);
  const back = parseWav(wav(pcm, 24000));
  assert.equal(back.sampleRate, 24000);
  assert.deepEqual([...back.pcm], [...pcm]);
  const up = resample(new Int16Array([0, 100, 200]), 24000, 48000);
  assert.deepEqual([...up], [0, 50, 100, 150, 200, 200]);
  assert.equal(resample(pcm, 48000, 48000), pcm);
});

test('board: wraps, writes down the page, turns pages when full, describes items', async () => {
  const sent: Uint8Array[][] = [];
  const board = new BoardHost({ publish: async (p) => void sent.push(p), storeSnapshot: async () => undefined }, 'teacher_x');
  assert.deepEqual(wrap('one two three four', 40, 200), ['one two', 'three', 'four']);
  const a = await board.write('Fractions', { size: 72 });
  assert.equal(a.page, 0);
  assert.ok(sent.length === 1, 'published as ops');
  const id = await board.shape('rect', 100, 300, 400, 500, { fill: true });
  const desc = board.describe();
  assert.equal(desc.items.length, 2);
  assert.equal(desc.items[0]!.kind, 'text');
  assert.equal(desc.items[1]!.id, id);
  // Fill the page: the next write turns to page 2.
  for (let i = 0; i < 12; i++) await board.write('A line of body text that takes some room.', { size: 48 });
  assert.ok(board.doc.pages.length >= 2, 'new page when full');
  assert.ok(board.cursorY < PAGE_H);
  assert.equal(await board.erase(['nope']), 0);
  await board.clearPage();
  assert.equal(board.page.items.length, 0);
  const snap = await board.session.snapshotPackets();
  assert.ok(snap.length >= 1);
});

test('outbound guard: phone numbers, e-mails, links, supervisor commands', () => {
  assert.match(outboundProblem('Call 98765 43210', false)!, /phone/);
  assert.match(outboundProblem('mail me at a@b.com', false)!, /e-mail/);
  assert.match(outboundProblem('see https://x.y', false)!, /Links/);
  assert.equal(outboundProblem('see https://x.y', true), null);
  assert.match(outboundProblem('/ai resume', false)!, /\/ai/);
  assert.equal(outboundProblem('3/4 of 12 is 9.', false), null);
});

test('supervisor control: token required, status, pause/resume', async () => {
  const { startControl } = await import('../src/control');
  const live = {
    code: 'ABC123',
    state: { name: 'Maths', admittedStudentCount: 2 },
    paused: false,
    ended: false,
    reflex: { escalationLog: [1] },
    commands: [] as string[],
    supervise(cmd: string) {
      this.commands.push(cmd);
      this.paused = cmd === 'pause';
    },
  };
  const session = { live, startedAt: Date.now() - 5 * 60_000 } as never;
  assert.throws(() => startControl(session, { port: 0, host: '127.0.0.1', token: 'short' }), /16 characters/);
  const server = startControl(session, { port: 0, host: '127.0.0.1', token: 'a-long-enough-token-123' });
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  const auth = { authorization: 'Bearer a-long-enough-token-123' };
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/status`)).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/status`, { headers: { authorization: 'Bearer wrong-token-of-same-len' } })).status, 401);
    const st = (await (await fetch(`http://127.0.0.1:${port}/status`, { headers: auth })).json()) as Record<string, unknown>;
    assert.deepEqual(st, { class: 'ABC123', name: 'Maths', paused: false, ended: false, students: 2, minutes: 5, escalations: 1 });
    const p = (await (await fetch(`http://127.0.0.1:${port}/pause`, { method: 'POST', headers: auth })).json()) as { paused: boolean };
    assert.equal(p.paused, true);
    await fetch(`http://127.0.0.1:${port}/resume`, { method: 'POST', headers: auth });
    assert.deepEqual(live.commands, ['pause', 'resume']);
    assert.equal((await fetch(`http://127.0.0.1:${port}/explode`, { method: 'POST', headers: auth })).status, 404);
  } finally {
    server.close();
  }
});
