#!/usr/bin/env node
/**
 * Lightweight classroom load generator. Credentials come from the environment
 * only; this file never embeds secrets and never prints tokens or cookies.
 *
 *   LOADTEST_BASE_URL=http://127.0.0.1:3000 LOADTEST_CODE=ABC234 \
 *     LOADTEST_COUNT=50 node scripts/loadtest/loadtest.mjs
 */
'use strict';

const BASE = (process.env.LOADTEST_BASE_URL || '').replace(/\/+$/, '');
const COUNT = Math.min(2500, Math.max(1, Number(process.env.LOADTEST_COUNT || 50)));
const RAMP_MS = Math.max(0, Number(process.env.LOADTEST_RAMP_MS || 15_000));
const CODES = (process.env.LOADTEST_CODES || process.env.LOADTEST_CODE || '')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const CLASS_REPEAT = Math.max(1, Number(process.env.LOADTEST_CLASSES || 1));
const WANT_LK = process.env.LOADTEST_LIVEKIT === '1';
const FEATURES = new Set(
  (process.env.LOADTEST_FEATURES || 'chat,hand,mute,whiteboard').split(',').map((s) => s.trim())
);
const TEACHER_EMAIL = process.env.LOADTEST_TEACHER_EMAIL || '';
const TEACHER_PASSWORD = process.env.LOADTEST_TEACHER_PASSWORD || '';

if (!BASE || !CODES.length) {
  console.error('Set LOADTEST_BASE_URL and LOADTEST_CODE (or LOADTEST_CODES). See scripts/loadtest/README.md');
  process.exit(2);
}

function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

function summarize(ms) {
  const s = [...ms].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  return { n: s.length, p50: pct(s, 50), p95: pct(s, 95), max: s[s.length - 1] ?? null };
}

function cookieJar() {
  const map = new Map();
  return {
    header() {
      return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    store(res) {
      const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      for (const c of list) {
        const nv = c.split(';')[0];
        const i = nv.indexOf('=');
        if (i > 0) map.set(nv.slice(0, i).trim(), nv.slice(i + 1).trim());
      }
    },
  };
}

async function api(jar, method, path, body, extra = {}) {
  const headers = { ...(extra.headers || {}) };
  const ck = jar.header();
  if (ck) headers.cookie = ck;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  jar.store(res);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { res, json, text };
}

async function tryLiveKit() {
  if (!WANT_LK) return null;
  try {
    return await import('@livekit/rtc-node');
  } catch {
    console.error('[loadtest] LOADTEST_LIVEKIT=1 but @livekit/rtc-node is not installed (cd scripts/loadtest && npm install)');
    return null;
  }
}

async function connectLiveKit(lk, url, token, onData) {
  const room = new lk.Room();
  const t0 = Date.now();
  if (onData) {
    room.on(lk.RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      onData({ payload, participant, topic, at: Date.now() });
    });
  }
  await room.connect(url, token, { autoSubscribe: false });
  return { room, connectMs: Date.now() - t0 };
}

async function teacherSession() {
  if (!TEACHER_EMAIL || !TEACHER_PASSWORD) return null;
  const jar = cookieJar();
  const { res, json } = await api(jar, 'POST', '/api/auth/login', {
    email: TEACHER_EMAIL,
    password: TEACHER_PASSWORD,
  });
  if (!res.ok) {
    console.error('[loadtest] teacher login failed', res.status, json?.error || '');
    return null;
  }
  return jar;
}

async function admitAll(teacher, code) {
  if (!teacher) return;
  await api(teacher, 'POST', `/api/rooms/${code}/admit`, { all: true });
}

async function oneStudent(lk, code, index, teacher) {
  const jar = cookieJar();
  const name = `LT${String(index).padStart(4, '0')}`;
  const t0 = Date.now();
  const join = await api(jar, 'POST', `/api/rooms/${code}/join`, { displayName: name });
  if (!join.res.ok) {
    return { ok: false, stage: 'join', status: join.res.status, error: join.json?.error, ms: Date.now() - t0 };
  }
  let admitted = join.json?.status === 'ADMITTED';
  const waitDeadline = Date.now() + 60_000;
  while (!admitted && Date.now() < waitDeadline) {
    if (teacher) await admitAll(teacher, code);
    const st = await api(jar, 'GET', `/api/rooms/${code}/state?as=student`, undefined, {
      headers: { 'x-classroom-as': 'student' },
    });
    // Only ADMITTED counts: a waiting student in a live room is still waiting,
    // and the server refuses its media token.
    if (st.json?.me?.status === 'ADMITTED') {
      admitted = true;
      break;
    }
    if (st.json?.ended) return { ok: false, stage: 'ended', ms: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!admitted) return { ok: false, stage: 'admit', error: 'not admitted within 60 s', ms: Date.now() - t0 };
  const tok = await api(jar, 'GET', `/api/rooms/${code}/token?as=student`, undefined, {
    headers: { 'x-classroom-as': 'student' },
  });
  if (!tok.res.ok || !tok.json?.token) {
    return { ok: false, stage: 'token', status: tok.res.status, error: tok.json?.error, ms: Date.now() - t0 };
  }
  let lkMs = null;
  let room = null;
  const dataLog = [];
  if (lk && tok.json.url) {
    try {
      const conn = await connectLiveKit(lk, tok.json.url, tok.json.token, (ev) => dataLog.push(ev));
      room = conn.room;
      lkMs = conn.connectMs;
    } catch (e) {
      return {
        ok: false,
        stage: 'livekit',
        error: e instanceof Error ? e.message : String(e),
        ms: Date.now() - t0,
      };
    }
  }
  return {
    ok: true,
    jar,
    code,
    identity: tok.json.identity,
    joinMs: Date.now() - t0,
    lkMs,
    room,
    dataLog,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function featurePass(clients, teacher) {
  const out = { chat: [], hand: [], mute: [], whiteboard: [] };
  const ready = clients.filter((c) => c.ok);
  if (!ready.length) return out;
  const sample = ready[0];

  if (FEATURES.has('chat')) {
    const t0 = Date.now();
    const sent = await api(sample.jar, 'POST', `/api/rooms/${sample.code}/messages?as=student`, { text: `lt-${t0}` }, {
      headers: { 'x-classroom-as': 'student' },
    });
    const httpMs = Date.now() - t0;
    out.chat.push(httpMs);
    if (sample.room) {
      const deadline = Date.now() + 8000;
      for (const c of ready.slice(1, 25)) {
        while (Date.now() < deadline) {
          const hit = c.dataLog.find((d) => d.topic === 'chat' && d.at >= t0);
          if (hit) {
            out.chat.push(hit.at - t0);
            break;
          }
          await sleep(20);
        }
      }
    }
    void sent;
  }

  if (FEATURES.has('hand')) {
    const t0 = Date.now();
    await api(sample.jar, 'POST', `/api/rooms/${sample.code}/hand?as=student`, { raised: true }, {
      headers: { 'x-classroom-as': 'student' },
    });
    out.hand.push(Date.now() - t0);
    if (sample.room) {
      const deadline = Date.now() + 8000;
      for (const c of ready.slice(0, 25)) {
        while (Date.now() < deadline) {
          const hit = c.dataLog.find((d) => d.topic === 'cls-signal' && d.at >= t0);
          if (hit) {
            out.hand.push(hit.at - t0);
            break;
          }
          await sleep(20);
        }
      }
    }
  }

  if (FEATURES.has('mute') && teacher) {
    const t0 = Date.now();
    await api(teacher, 'POST', `/api/rooms/${sample.code}/mute`, { all: true, muted: true });
    out.mute.push(Date.now() - t0);
    if (sample.room) {
      const deadline = Date.now() + 15000;
      for (const c of ready.slice(0, 25)) {
        while (Date.now() < deadline) {
          const hit = c.dataLog.find((d) => d.topic === 'cls-state' && d.at >= t0);
          if (hit) {
            out.mute.push(hit.at - t0);
            break;
          }
          await sleep(20);
        }
      }
    }
  }

  if (FEATURES.has('whiteboard') && sample.room?.localParticipant) {
    const t0 = Date.now();
    const payload = new TextEncoder().encode(JSON.stringify({ v: 1, t: 'ops', ops: [] }));
    try {
      await sample.room.localParticipant.publishData(payload, { reliable: true, topic: 'wb' });
      out.whiteboard.push(Date.now() - t0);
      const deadline = Date.now() + 8000;
      for (const c of ready.slice(1, 25)) {
        while (Date.now() < deadline) {
          const hit = c.dataLog.find((d) => d.topic === 'wb' && d.at >= t0);
          if (hit) {
            out.whiteboard.push(hit.at - t0);
            break;
          }
          await sleep(20);
        }
      }
    } catch (e) {
      out.whiteboard.push(NaN);
      void e;
    }
  }
  return out;
}

async function main() {
  const lk = await tryLiveKit();
  const teacher = await teacherSession();
  const codes = [];
  for (let i = 0; i < CLASS_REPEAT; i++) codes.push(...CODES);
  const perClass = Math.ceil(COUNT / codes.length);
  const jobs = [];
  let n = 0;
  for (const code of codes) {
    const k = Math.min(perClass, COUNT - n);
    for (let i = 0; i < k; i++) {
      const delay = COUNT <= 1 || RAMP_MS <= 0 ? 0 : Math.floor((n / (COUNT - 1)) * RAMP_MS);
      const idx = n;
      jobs.push(
        (async () => {
          if (delay) await sleep(delay);
          return oneStudent(lk, code, idx, teacher);
        })()
      );
      n++;
      if (n >= COUNT) break;
    }
    if (n >= COUNT) break;
  }

  const clients = await Promise.all(jobs);
  const ok = clients.filter((c) => c.ok);
  const fail = clients.filter((c) => !c.ok);
  const features = await featurePass(ok, teacher);

  for (const c of ok) {
    try {
      await c.room?.disconnect();
    } catch {
      /* ignore */
    }
  }

  const report = {
    base: BASE,
    count: COUNT,
    codes,
    livekit: Boolean(lk),
    joined: ok.length,
    failed: fail.length,
    failStages: fail.reduce((acc, f) => {
      acc[f.stage] = (acc[f.stage] || 0) + 1;
      return acc;
    }, {}),
    joinMs: summarize(ok.map((c) => c.joinMs)),
    livekitConnectMs: summarize(ok.map((c) => c.lkMs).filter((x) => x != null)),
    chatMs: summarize(features.chat),
    handMs: summarize(features.hand),
    muteAllMs: summarize(features.mute),
    whiteboardMs: summarize(features.whiteboard),
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error('[loadtest]', e instanceof Error ? e.message : e);
  process.exit(1);
});
