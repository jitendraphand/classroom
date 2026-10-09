/**
 * Whole-class simulation against the live classroom.
 *
 *   E2E_TEACHER_PASSWORD='…' node run.mjs
 *
 * The password is read only from the environment. This script never writes it
 * to disk, logs, or screenshot names. It does not modify the classroom app.
 *
 * Devices are Playwright contexts in one Chrome process (channel "chrome"):
 * desktop Windows Chrome, iPhone-sized CriOS, and Pixel-7-sized Android Chrome.
 * They are emulated, not real phones.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'https://13-201-89-150.sslip.io';
const EMAIL = 'jitendraphand@gmail.com';
const PASS = process.env.E2E_TEACHER_PASSWORD || '';
const Y4M = path.join(ROOT, 'media', 'green.y4m');
const WAV = path.join(ROOT, 'media', 'tone.wav');
const SHOTS = path.join(ROOT, 'shots');
const RESULTS = path.join(ROOT, 'results.json');
const HZ = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()) || 100;

const SIM_NAMES = new Set(['W1 Sim', 'W2 Sim', 'I1 Sim', 'I2 Sim', 'A1 Sim', 'A2 Sim']);

const UA = {
  windows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1',
  android:
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
};

const DEVICES = {
  teacher: { ua: UA.windows, viewport: { width: 1200, height: 720 }, mobile: false },
  W1: { ua: UA.windows, viewport: { width: 1200, height: 720 }, mobile: false },
  W2: { ua: UA.windows, viewport: { width: 1100, height: 700 }, mobile: false },
  I1: { ua: UA.iphone, viewport: { width: 390, height: 844 }, mobile: true },
  I2: { ua: UA.iphone, viewport: { width: 390, height: 844 }, mobile: true },
  A1: { ua: UA.android, viewport: { width: 412, height: 915 }, mobile: true },
  A2: { ua: UA.android, viewport: { width: 412, height: 915 }, mobile: true },
};

const steps = [];
const consoleErrors = {};
const pinLog = [];
const dialogs = [];
let browser = null;
let xvfb = null;
let teacher = null;
let teacherCtx = null;
let roomCode = '';
let classEnded = false;
let launchMode = '';
const students = {};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function redact(value) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  const cleaned = PASS ? raw.split(PASS).join('[redacted]') : raw;
  return typeof value === 'string' ? cleaned : JSON.parse(cleaned);
}

function save() {
  const payload = redact({
    generatedAt: new Date().toISOString(),
    base: BASE,
    launchMode,
    roomCode,
    classEnded,
    steps,
    pinLog,
    dialogs,
    consoleErrors,
    students: Object.fromEntries(
      Object.entries(students).map(([id, s]) => [id, { sid: s.sid, device: s.device, grade: s.grade, division: s.division }])
    ),
  });
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(RESULTS, JSON.stringify(payload, null, 2));
}

function note(name, status, detail) {
  const row = { t: new Date().toISOString(), name, status, detail: detail ?? null };
  steps.push(row);
  const brief = detail && detail.error ? String(detail.error).slice(0, 220) : '';
  console.log(`STEP ${row.t} ${status.toUpperCase()} ${name}${brief ? ' ' + brief : ''}`);
  save();
  return row;
}

async function shot(page, name) {
  if (!page || page.isClosed()) return null;
  const file = path.join(SHOTS, `${name}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    await page.screenshot({ path: file, fullPage: true, timeout: 15000 });
  } catch {
    try {
      await page.screenshot({ path: file, fullPage: false, timeout: 10000 });
    } catch (e) {
      return { file, error: String(e).slice(0, 200) };
    }
  }
  return path.relative(ROOT, file);
}

async function shotAll(tag) {
  const out = {};
  if (teacher) out.teacher = await shot(teacher, `${tag}/teacher`);
  for (const [id, s] of Object.entries(students)) {
    if (s.page && !s.page.isClosed()) out[id] = await shot(s.page, `${tag}/${id}`);
  }
  return out;
}

function procStat(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return {
      ppid: Number(rest[1]),
      utime: Number(rest[11]),
      stime: Number(rest[12]),
      comm: s.slice(s.indexOf('(') + 1, s.lastIndexOf(')')),
    };
  } catch {
    return null;
  }
}

function rssBytes(pid) {
  try {
    const m = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/);
    return m ? Number(m[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

function processTree(root) {
  const pids = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map(Number);
  const kids = new Map();
  for (const pid of pids) {
    const st = procStat(pid);
    if (!st) continue;
    if (!kids.has(st.ppid)) kids.set(st.ppid, []);
    kids.get(st.ppid).push(pid);
  }
  const out = [];
  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    const st = procStat(pid);
    if (!st) continue;
    out.push({ pid, comm: st.comm, ticks: st.utime + st.stime, rss: rssBytes(pid) });
    for (const c of kids.get(pid) || []) stack.push(c);
  }
  return out;
}

let cpuPrev = null;
function chromeRootPid() {
  const marker = 'green.y4m';
  let found = null;
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const cmd = fs.readFileSync(`/proc/${name}/cmdline`);
      const text = cmd.toString('utf8');
      if (!text.includes(marker) || !text.includes('chrome')) continue;
      if (text.includes('--type=')) continue;
      found = Number(name);
    } catch {
      /* process exited */
    }
  }
  return found;
}

function sampleCpu(label) {
  try {
  if (!browser) return null;
  const root = chromeRootPid();
  if (!root) return { label, error: 'chrome pid not found' };
  const procs = processTree(root);
  const ticks = procs.reduce((n, p) => n + p.ticks, 0);
  const rss = procs.reduce((n, p) => n + p.rss, 0);
  const now = Date.now();
  let cpuCores = null;
  if (cpuPrev) {
    const dt = (now - cpuPrev.at) / 1000;
    const dTicks = ticks - cpuPrev.ticks;
    if (dt > 0) cpuCores = dTicks / HZ / dt;
  }
  cpuPrev = { at: now, ticks };
  return {
    t: new Date().toISOString(),
    label,
    root,
    processCount: procs.length,
    rssMb: Math.round(rss / 1048576),
    cpuCores: cpuCores == null ? null : Math.round(cpuCores * 100) / 100,
    note: 'One Chrome process tree hosts every device context. Per-device CPU is not separable. cpuCores is the tree since the previous sample, as a fraction of one core (1.0 = one core).',
    top: procs
      .sort((a, b) => b.rss - a.rss)
      .slice(0, 8)
      .map((p) => ({ pid: p.pid, comm: p.comm, rssMb: Math.round(p.rss / 1048576) })),
  };
  } catch (e) {
    return { label, error: String(e).slice(0, 200) };
  }
}

function ensureMedia() {
  fs.mkdirSync(path.dirname(Y4M), { recursive: true });
  if (!fs.existsSync(Y4M) || fs.statSync(Y4M).size < 1000) {
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=0x00ff00:s=640x360:r=15:d=4', '-pix_fmt', 'yuv420p', Y4M], { stdio: 'ignore' });
  }
  if (!fs.existsSync(WAV) || fs.statSync(WAV).size < 1000) {
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=10', '-ac', '2', '-c:a', 'pcm_s16le', WAV], { stdio: 'ignore' });
  }
}

function chromeArgs() {
  return [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-video-capture=${Y4M}`,
    `--use-file-for-fake-audio-capture=${WAV}`,
    '--autoplay-policy=no-user-gesture-required',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ];
}

async function launch(headless) {
  return chromium.launch({ channel: 'chrome', headless, args: chromeArgs() });
}

async function probeFullscreen(b) {
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  await p.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await p.evaluate(() => {
    const b = document.createElement('button');
    b.id = 'e2e-fs';
    b.textContent = 'go';
    document.body.appendChild(b);
  });
  const pending = p.evaluate(
    () =>
      new Promise((resolve) => {
        document.getElementById('e2e-fs').addEventListener(
          'click',
          () => {
            const enabled = !!document.fullscreenEnabled;
            if (!enabled) {
              resolve({ enabled, entered: false });
              return;
            }
            document.documentElement.requestFullscreen().then(
              () => resolve({ enabled, entered: !!document.fullscreenElement }),
              (e) => resolve({ enabled, entered: false, error: String(e).slice(0, 180) })
            );
          },
          { once: true }
        );
      })
  );
  await p.click('#e2e-fs');
  const result = await pending;
  await ctx.close();
  return result;
}

async function startXvfb() {
  xvfb = spawn('Xvfb', [':99', '-screen', '0', '1400x900x24', '-ac', '+extension', 'GLX', '+render', '-noreset'], {
    stdio: 'ignore',
  });
  process.env.DISPLAY = ':99';
  await sleep(600);
}

const INIT = () => {
  const pcs = [];
  const Orig = window.RTCPeerConnection;
  function Wrapped(cfg) {
    const pc = new Orig(cfg);
    pcs.push(pc);
    return pc;
  }
  Wrapped.prototype = Orig.prototype;
  window.RTCPeerConnection = Wrapped;
  window.__e2ePcs = pcs;
  const md = navigator.mediaDevices;
  if (md && !md.__e2eHooked) {
    md.__e2eHooked = true;
    const gdm = md.getDisplayMedia && md.getDisplayMedia.bind(md);
    if (gdm) {
      md.getDisplayMedia = async (constraints) => {
        window.__e2eDisplayConstraints = constraints;
        const stream = await gdm(constraints);
        window.__e2eDisplayTracks = stream.getTracks().map((t) => ({
          kind: t.kind,
          label: t.label,
          settings: t.getSettings(),
          muted: t.muted,
        }));
        return stream;
      };
    }
    const gum = md.getUserMedia && md.getUserMedia.bind(md);
    if (gum) {
      md.getUserMedia = async (constraints) => {
        const stream = await gum(constraints);
        const rec = {
          constraints,
          tracks: stream.getTracks().map((t) => ({ kind: t.kind, label: t.label, settings: t.getSettings() })),
        };
        (window.__e2eGum = window.__e2eGum || []).push(rec);
        return stream;
      };
    }
  }
};

async function newContext(id) {
  const d = DEVICES[id];
  const ctx = await browser.newContext({
    userAgent: d.ua,
    viewport: d.viewport,
    deviceScaleFactor: 1,
    isMobile: d.mobile,
    hasTouch: d.mobile,
    locale: 'en-US',
    permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'],
  });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(45000);
  consoleErrors[id] = [];
  page.on('pageerror', (e) => {
    const list = consoleErrors[id];
    if (list.length < 30) list.push(String(e).slice(0, 300));
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const list = consoleErrors[id];
    if (list.length < 30) list.push(msg.text().slice(0, 300));
  });
  page.on('dialog', async (dialog) => {
    const message = dialog.message();
    dialogs.push({ t: new Date().toISOString(), id, type: dialog.type(), message });
    if (message.includes('End class for everyone?')) await dialog.accept();
    else await dialog.dismiss();
  });
  return { ctx, page };
}

async function textOf(page, n = 600) {
  return page.evaluate((n) => (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, n), n).catch(() => '');
}

async function teacherState() {
  return teacher.evaluate(async (code) => {
    const r = await fetch(`/api/rooms/${code}/state`, { credentials: 'same-origin' });
    const data = await r.json().catch(() => ({}));
    return { http: r.status, data };
  }, roomCode);
}

function redactPeople(list) {
  return (list || []).map((p) => ({
    name: SIM_NAMES.has(p.displayName) ? p.displayName : '[non-sim]',
    role: p.role || 'STUDENT',
    mutedByTeacher: p.mutedByTeacher,
    handRaised: p.handRaised,
    handRaisedAt: p.handRaisedAt,
    pinned: p.pinned,
    isVisible: p.isVisible,
    focus: p.focus,
    focusIphone: p.focusIphone,
    gradeDivision: SIM_NAMES.has(p.displayName) ? p.gradeDivision : undefined,
    late: p.late,
    viaSchoolApp: p.viaSchoolApp,
    onTimetable: p.onTimetable,
  }));
}

function simOnly(list) {
  return (list || []).every((p) => SIM_NAMES.has(p.displayName));
}

function shortName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] || '';
  return `${parts[0]} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
}

async function clickFirst(locator) {
  const n = await locator.count();
  for (let i = 0; i < n; i++) {
    const el = locator.nth(i);
    if (await el.isVisible().catch(() => false)) {
      await el.click();
      return true;
    }
  }
  return false;
}

async function openRoster() {
  const sw = teacher.getByRole('switch');
  const switches = await sw.count();
  for (let i = 0; i < switches; i++) {
    if (await sw.nth(i).isVisible().catch(() => false)) return;
  }
  const open = teacher.getByRole('button', { name: /Open roster|^Roster$/ });
  const clicked = await clickFirst(open);
  if (!clicked) throw new Error('Open roster button was not visible');
  await teacher.getByRole('switch').first().waitFor({ state: 'visible', timeout: 8000 });
}

async function clickNamed(page, name, exact = true) {
  const btn = page.getByRole('button', { name, exact });
  const ok = await clickFirst(btn);
  if (!ok) throw new Error(`button not visible: ${name}`);
}

async function readyStudent(page) {
  if (!page || page.isClosed()) return;
  const cover = page.getByRole('button', { name: 'Tap to return to fullscreen', exact: true });
  if (await cover.count()) {
    await cover.first().click({ timeout: 4000 }).catch(() => {});
    await sleep(400);
  }
}

async function waitForBody(page, re, timeout = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const text = await textOf(page, 1500);
    if (re.test(text)) return { ok: true, ms: Date.now() - t0, text: text.slice(0, 400), href: page.url() };
    await sleep(400);
  }
  return { ok: false, ms: timeout, text: (await textOf(page, 400)), href: page.url() };
}

async function joinStudent(id) {
  const spec = students[id];
  const page = spec.page;
  const t0 = Date.now();
  const url = new URL('/join', BASE);
  url.searchParams.set('FirstName', id);
  url.searchParams.set('LastName', 'Sim');
  url.searchParams.set('SID', spec.sid);
  url.searchParams.set('Grade', spec.grade);
  url.searchParams.set('Division', spec.division);
  await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 50000;
  let last = '';
  while (Date.now() < deadline) {
    const href = page.url();
    const text = await textOf(page, 900);
    last = text;
    if (/\/classroom\//.test(href) && /Open chat|Turn camera|Muted by teacher|Teacher/.test(text)) {
      return { id, kind: 'classroom', ms: Date.now() - t0, href, text: text.slice(0, 300) };
    }
    if (/Waiting room/.test(text) && /lobby|admit you/i.test(text)) {
      return { id, kind: 'waiting', ms: Date.now() - t0, href, text: text.slice(0, 300) };
    }
    if (Date.now() - t0 > 14000 && /No class right now|Class ended|Could not load|Sign in|missing|invalid|not assigned|audience/i.test(text)) {
      return { id, kind: 'stuck', ms: Date.now() - t0, href, text: text.slice(0, 400) };
    }
    await sleep(500);
  }
  return { id, kind: 'timeout', ms: Date.now() - t0, href: page.url(), text: last.slice(0, 400) };
}

async function ensureStudent(id) {
  if (students[id]?.page) return students[id];
  const made = await newContext(id);
  students[id] = {
    ...students[id],
    id,
    sid: `TEST-SIM-${id}`,
    device: id.startsWith('W') ? 'Windows Chrome' : id.startsWith('I') ? 'iPhone CriOS (emulated)' : 'Android Chrome (emulated)',
    ctx: made.ctx,
    page: made.page,
  };
  return students[id];
}

async function messagesOf(page) {
  return page.evaluate(async (code) => {
    const r = await fetch(`/api/rooms/${code}/messages`, { credentials: 'same-origin' });
    const data = await r.json().catch(() => ({}));
    return { http: r.status, messages: data.messages || [], ended: !!data.ended, error: data.error || null };
  }, roomCode);
}

async function waitMessage(page, body, timeout = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const pack = await messagesOf(page);
    const hit = pack.messages.find((m) => m.body === body);
    const visible = (await textOf(page, 2500)).includes(body);
    if (hit) return { ms: Date.now() - t0, api: true, visible, scope: hit.scope, recipient: hit.recipientName, sender: hit.senderName, createdAt: hit.createdAt };
    await sleep(300);
  }
  return { ms: null, api: false, visible: false };
}

async function sendChat(page, body, toLabel) {
  await readyStudent(page);
  const open = page.getByRole('button', { name: 'Open chat', exact: true });
  if (!(await clickFirst(open))) {
    const fallback = page.getByRole('button', { name: /Open chat/ });
    await clickFirst(fallback);
  }
  if (toLabel) {
    const sel = page.locator('select').first();
    await sel.waitFor({ state: 'visible', timeout: 8000 });
    if (toLabel !== 'Everyone') {
      await page.waitForFunction(
        (name) => [...document.querySelectorAll('select option')].some((o) => o.textContent === name),
        toLabel,
        { timeout: 10000 }
      );
    }
    await sel.selectOption({ label: toLabel });
  }
  const input = page.getByLabel('Chat message');
  await input.fill(body);
  const sentAt = new Date().toISOString();
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  return { sentAt, t0 };
}

async function collectStats(page) {
  return page.evaluate(async () => {
    const pcs = window.__e2ePcs || [];
    const out = [];
    for (const pc of pcs) {
      if (!pc || pc.connectionState === 'closed' || pc.signalingState === 'closed') continue;
      let report;
      try {
        report = await pc.getStats();
      } catch {
        continue;
      }
      const rows = [];
      report.forEach((s) => {
        if (s.type !== 'inbound-rtp' && s.type !== 'outbound-rtp' && s.type !== 'media-source') return;
        rows.push({
          type: s.type,
          kind: s.kind || null,
          bytes: s.bytesReceived ?? s.bytesSent ?? null,
          packets: s.packetsReceived ?? s.packetsSent ?? null,
          fps: s.framesPerSecond ?? null,
          w: s.frameWidth ?? s.width ?? null,
          h: s.frameHeight ?? s.height ?? null,
          rid: s.rid || null,
          audioLevel: typeof s.audioLevel === 'number' ? s.audioLevel : null,
          energy: typeof s.totalAudioEnergy === 'number' ? s.totalAudioEnergy : null,
          q: s.qualityLimitationReason || null,
          mime: s.mimeType || null,
        });
      });
      out.push({ connection: pc.connectionState, ice: pc.iceConnectionState, rows });
    }
    const videos = [...document.querySelectorAll('video')].map((v) => ({
      w: v.videoWidth,
      h: v.videoHeight,
      aria: v.getAttribute('aria-label') || v.closest('[aria-label]')?.getAttribute('aria-label') || '',
    }));
    return {
      pcs: out,
      videos,
      display: window.__e2eDisplayTracks || null,
      displayConstraints: window.__e2eDisplayConstraints || null,
      gumCount: (window.__e2eGum || []).length,
      fullscreenEnabled: !!document.fullscreenEnabled,
      fullscreen: !!document.fullscreenElement,
      ua: navigator.userAgent,
    };
  });
}

function flatten(stats) {
  const rows = [];
  for (const pc of stats?.pcs || []) {
    pc.rows.forEach((row, i) => rows.push({ ...row, i, connection: pc.connection }));
  }
  return rows;
}

function withBitrate(a, b, dtMs) {
  const A = flatten(a);
  const B = flatten(b);
  return B.map((row) => {
    const prev = A.find((x) => x.type === row.type && x.kind === row.kind && x.rid === row.rid && x.mime === row.mime && x.i === row.i);
    const dBytes = prev && row.bytes != null && prev.bytes != null ? row.bytes - prev.bytes : null;
    const kbps = dBytes != null && dtMs > 0 ? Math.round((dBytes * 8) / dtMs) : null;
    return { ...row, kbps };
  });
}

async function statsPair(page) {
  const a = await collectStats(page);
  const t0 = Date.now();
  await sleep(1000);
  const b = await collectStats(page);
  const dt = Date.now() - t0;
  return { dt, rows: withBitrate(a, b, dt), videos: b.videos, display: b.display, displayConstraints: b.displayConstraints, fullscreenEnabled: b.fullscreenEnabled, fullscreen: b.fullscreen, connections: (b.pcs || []).map((p) => ({ connection: p.connection, ice: p.ice })) };
}

function audioSummary(rows) {
  const inbound = rows.filter((r) => r.type === 'inbound-rtp' && r.kind === 'audio');
  const outbound = rows.filter((r) => r.type === 'outbound-rtp' && r.kind === 'audio');
  return {
    inbound: inbound.map((r) => ({ energy: r.energy, level: r.audioLevel, kbps: r.kbps, mime: r.mime })),
    outbound: outbound.map((r) => ({ energy: r.energy, kbps: r.kbps, mime: r.mime })),
    inboundEnergy: inbound.reduce((n, r) => n + (r.energy || 0), 0),
    outboundKbps: outbound.reduce((n, r) => n + (r.kbps || 0), 0),
  };
}

function videoSummary(rows) {
  const pick = (type) =>
    rows
      .filter((r) => r.type === type && r.kind === 'video')
      .map((r) => ({ w: r.w, h: r.h, fps: r.fps, rid: r.rid, kbps: r.kbps, mime: r.mime, q: r.q }));
  return { inbound: pick('inbound-rtp'), outbound: pick('outbound-rtp'), inboundCount: pick('inbound-rtp').length };
}

async function measureFrame(page) {
  return page.evaluate(async () => {
    const videos = [...document.querySelectorAll('video')];
    let best = null;
    for (const v of videos) {
      if (v.videoWidth > (best?.videoWidth || 0)) best = v;
    }
    if (!best || !best.videoWidth) return { ok: false, reason: 'no decoded video frame', videoCount: videos.length };
    const w = 160;
    const h = Math.max(1, Math.round((160 * best.videoHeight) / best.videoWidth));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    try {
      ctx.drawImage(best, 0, 0, w, h);
    } catch (e) {
      return { ok: false, reason: String(e).slice(0, 160), videoCount: videos.length };
    }
    const data = ctx.getImageData(0, 0, w, h).data;
    let black = 0;
    let green = 0;
    const n = w * h;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (r < 18 && g < 18 && b < 18) black++;
      if (g > 160 && r < 90 && b < 90) green++;
    }
    return {
      ok: true,
      frameW: best.videoWidth,
      frameH: best.videoHeight,
      blackPct: Math.round((1000 * black) / n) / 10,
      greenPct: Math.round((1000 * green) / n) / 10,
      videoCount: videos.length,
    };
  });
}

async function measureOverlay(page) {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const sels = ['.stage-float-chrome', '[aria-label="Teacher camera"]', '.stage-fullscreen-badge', '[aria-label="Tap to return to fullscreen"]', '.control-float', '.student-media-tile'];
    const grid = 48;
    const cells = new Set();
    const boxes = [];
    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        boxes.push({ sel, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
        for (let gx = 0; gx < grid; gx++) {
          for (let gy = 0; gy < grid; gy++) {
            const cx = ((gx + 0.5) * vw) / grid;
            const cy = ((gy + 0.5) * vh) / grid;
            if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) cells.add(`${gx},${gy}`);
          }
        }
      }
    }
    return {
      vw,
      vh,
      overlayPct: Math.round((1000 * cells.size) / (grid * grid)) / 10,
      boxes,
    };
  });
}

async function rosterRows() {
  return teacher.evaluate(() =>
    [...document.querySelectorAll('.roster-row')].map((li) => {
      const name = li.querySelector('.roster-name')?.textContent?.trim() || '';
      const sim = /^(W1|W2|I1|I2|A1|A2) Sim$/.test(name);
      return {
        name: sim ? name : '[non-sim]',
        hand: !!li.querySelector('[aria-label="Hand raised"]'),
        handBeforeName: (() => {
          const hand = li.querySelector('[aria-label="Hand raised"]');
          const nameEl = li.querySelector('.roster-name');
          if (!hand || !nameEl) return false;
          return !!(hand.compareDocumentPosition(nameEl) & Node.DOCUMENT_POSITION_FOLLOWING);
        })(),
        chips: [...li.querySelectorAll('.roster-chip, .roster-meta')].map((n) => n.textContent.trim()),
        text: sim ? li.innerText.replace(/\s+/g, ' ').slice(0, 180) : '[non-sim row]',
      };
    })
  );
}

async function safeAdmitted() {
  const st = await teacherState();
  const admitted = (st.data.admitted || []).filter((p) => p.role === 'STUDENT');
  return { st, admitted, ok: simOnly(admitted), outsiderCount: admitted.filter((p) => !SIM_NAMES.has(p.displayName)).length };
}

async function endClass() {
  if (classEnded || !teacher || !roomCode) return { skipped: true };
  try {
    const btn = teacher.getByRole('button', { name: 'End class', exact: true });
    if ((await btn.count()) && (await btn.isVisible().catch(() => false))) {
      await btn.click({ timeout: 8000 });
      await sleep(1500);
    }
  } catch (e) {
    note('end-class-ui', 'fail', { error: String(e).slice(0, 300) });
  }
  let st = null;
  try {
    st = await teacherState();
  } catch {
    st = null;
  }
  if (!st || st.data?.status !== 'ENDED') {
    try {
      const api = await teacher.evaluate(async (code) => {
        const r = await fetch(`/api/rooms/${code}/end`, { method: 'POST', credentials: 'same-origin' });
        const data = await r.json().catch(() => ({}));
        return { http: r.status, data };
      }, roomCode);
      note('end-class-api-fallback', api.http >= 200 && api.http < 300 ? 'pass' : 'fail', api);
    } catch (e) {
      note('end-class-api-fallback', 'fail', { error: String(e).slice(0, 300) });
    }
    try {
      st = await teacherState();
    } catch {
      /* ignore */
    }
  }
  classEnded = st?.data?.status === 'ENDED' || classEnded;
  if (st?.data?.status === 'ENDED') classEnded = true;
  return { status: st?.data?.status || null, href: teacher.url() };
}

async function cleanup() {
  try {
    if (roomCode && teacher && !classEnded) await endClass();
  } catch (e) {
    console.log('CLEANUP end failed', String(e).slice(0, 200));
  }
  try {
    if (browser) await browser.close();
  } catch {
    /* ignore */
  }
  browser = null;
  try {
    if (xvfb && !xvfb.killed) xvfb.kill('SIGTERM');
  } catch {
    /* ignore */
  }
}

async function main() {
  if (!PASS) {
    console.error('E2E_TEACHER_PASSWORD is not set');
    process.exit(2);
  }
  ensureMedia();
  fs.mkdirSync(SHOTS, { recursive: true });

  browser = await launch(true);
  const headlessProbe = await probeFullscreen(browser);
  if (headlessProbe.enabled && headlessProbe.entered) {
    launchMode = 'headless-chrome-fullscreen-ok';
  } else {
    await browser.close();
    await startXvfb();
    browser = await launch(false);
    const headedProbe = await probeFullscreen(browser);
    launchMode = `headed-xvfb fullscreenEnabled=${headedProbe.enabled} entered=${headedProbe.entered}`;
    note('fullscreen-probe', headedProbe.entered ? 'pass' : 'fail', { headlessProbe, headedProbe, launchMode });
  }
  if (!steps.find((s) => s.name === 'fullscreen-probe')) {
    note('fullscreen-probe', 'pass', { headlessProbe, launchMode });
  }

  const teacherMade = await newContext('teacher');
  teacherCtx = teacherMade.ctx;
  teacher = teacherMade.page;
  teacher.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('/pin-student') && !url.includes('/sample/pin')) return;
    let body = '';
    try {
      body = (await res.text()).slice(0, 300);
    } catch {
      body = '';
    }
    pinLog.push({ t: new Date().toISOString(), status: res.status(), url: url.replace(BASE, ''), body });
  });

  // 1. Sign in and start the class from the dashboard.
  let loginMeta = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await teacher.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await teacher.locator('input[type="email"]').fill(EMAIL);
    await teacher.locator('input[type="password"]').fill(PASS);
    const respPromise = teacher.waitForResponse((r) => r.url().includes('/api/auth/login'), { timeout: 25000 }).catch(() => null);
    await teacher.getByRole('button', { name: 'Sign in', exact: true }).click();
    const resp = await respPromise;
    let apiError = null;
    let http = null;
    if (resp) {
      http = resp.status();
      const data = await resp.json().catch(() => null);
      apiError = data && (data.error || data.message) ? String(data.error || data.message).slice(0, 180) : null;
    }
    await teacher.waitForURL(/\/teacher\/dashboard|\/account\/password/, { timeout: 20000 }).catch(() => {});
    loginMeta = { attempt, http, apiError, href: teacher.url(), text: (await textOf(teacher, 240)).slice(0, 240) };
    if (/\/teacher\/dashboard|\/account\/password/.test(teacher.url())) break;
    await sleep(2000);
  }
  await sleep(500);
  const afterLogin = teacher.url();
  if (/\/account\/password/.test(afterLogin)) {
    note('01-login', 'blocked', {
      href: afterLogin,
      error: 'mustChangePassword sent the teacher to /account/password. Password was not changed. Class was not started.',
    });
    await shot(teacher, '01-login/teacher');
    return;
  }
  if (!/\/teacher\/dashboard/.test(teacher.url())) {
    const text = await textOf(teacher, 400);
    await shot(teacher, '01-login/fail');
    note('01-login', 'fail', { ...loginMeta, text });
    return;
  }
  note('01-login', 'pass', { href: teacher.url(), loginMeta, shots: { teacher: await shot(teacher, '01-login/teacher') } });

  await teacher.waitForSelector('text=Start ad-hoc class', { timeout: 25000 });
  await teacher.waitForFunction(() => {
    const sel = document.querySelector('form select');
    return !!(sel && sel.options.length && sel.value);
  });
  const schedule = await teacher.evaluate(async () => {
    const r = await fetch('/api/teacher/schedule', { credentials: 'same-origin' });
    const data = await r.json();
    return {
      http: r.status,
      gradeChoices: data.gradeChoices || [],
      active: data.active || null,
      gradesConfigured: data.gradesConfigured,
      timezone: data.timezone,
    };
  });
  const choices = schedule.gradeChoices || [];
  const preferred = choices.find((c) => c.grade === '9') || choices[0];
  if (!preferred) {
    note('01-start', 'fail', { error: 'Teacher has no assigned grades', schedule });
    await shot(teacher, '01-start/teacher-fail');
    return;
  }
  const division = preferred.divisions?.[0]?.label || preferred.divisions?.[0]?.name || '';
  if (!division) {
    note('01-start', 'fail', { error: 'No division available for the assigned grade', grade: preferred.grade, schedule });
    return;
  }
  for (const id of ['W1', 'W2', 'I1', 'A1', 'I2', 'A2']) {
    students[id] = { grade: preferred.grade, division, sid: `TEST-SIM-${id}` };
  }
  await teacher.locator('form select').first().selectOption(preferred.grade);
  await sleep(300);
  await teacher.locator('input[name="subject"]').fill('SIM e2e');
  await teacher.locator('input[name="maxVisible"]').fill('6');
  const allBox = teacher.getByRole('checkbox', { name: new RegExp(`All divisions of grade ${preferred.grade}`) });
  if (await allBox.count()) {
    await allBox.check();
  } else {
    const boxes = teacher.locator('fieldset input[type="checkbox"]');
    const n = await boxes.count();
    for (let i = 0; i < n; i++) await boxes.nth(i).check();
  }
  const cpuAtStart = sampleCpu('before-class');
  await teacher.getByRole('button', { name: 'Start ad-hoc class', exact: true }).click();
  try {
    await teacher.waitForURL(/\/classroom\//, { timeout: 30000 });
  } catch (e) {
    note('01-start', 'fail', { error: String(e).slice(0, 300), text: await textOf(teacher, 500), shots: { teacher: await shot(teacher, '01-start/teacher-fail') } });
    return;
  }
  roomCode = teacher.url().split('/classroom/')[1]?.split(/[/?#]/)[0] || '';
  await waitForBody(teacher, /End class|Open roster/, 25000);
  const live = await teacherState();
  const admitted0 = (live.data.admitted || []).filter((p) => p.role === 'STUDENT');
  note('01-start', live.data.waitingRoomOn === true ? 'pass' : 'fail', {
    roomCode,
    gradeRequested: '9',
    gradeUsed: preferred.grade,
    gradeLabel: preferred.label,
    divisionJoin: division,
    wholeGrade: !!preferred.whole,
    divisions: (preferred.divisions || []).map((d) => d.label || d.name),
    subject: 'SIM e2e',
    waitingRoomOn: live.data.waitingRoomOn,
    maxVisibleVideos: live.data.maxVisibleVideos,
    classSession: live.data.classSession || null,
    admittedStudents: admitted0.length,
    outsiderCount: admitted0.filter((p) => !SIM_NAMES.has(p.displayName)).length,
    activeBefore: schedule.active ? { subject: schedule.active.subject, adHoc: schedule.active.adHoc, code: schedule.active.code } : null,
    cpu: cpuAtStart,
    shots: { teacher: await shot(teacher, '01-start/teacher') },
    note: preferred.grade === '9' ? 'Started Class 9 as requested.' : `Grade 9 is not in this teacher's assigned grades. Students joined grade ${preferred.grade} so they route into this class.`,
  });

  // 2. Four students join the waiting room. Admit one, then Admit all if safe.
  try {
  for (const id of ['W1', 'W2', 'I1', 'A1']) await ensureStudent(id);
  const joins = await Promise.all(['W1', 'W2', 'I1', 'A1'].map((id) => joinStudent(id).catch((e) => ({ id, kind: 'error', error: String(e).slice(0, 300) }))));
  const stWait = await teacherState();
  const waitingNames = redactPeople(stWait.data.waiting || []);
  note('02-join-waiting', joins.every((j) => j.kind === 'waiting') ? 'pass' : 'fail', {
    joins,
    waitingRoomOn: stWait.data.waitingRoomOn,
    waiting: waitingNames,
    shots: await shotAll('02-waiting'),
  });

  const waiting = stWait.data.waiting || [];
  const first = waiting.find((p) => p.displayName === 'W1 Sim') || waiting.find((p) => SIM_NAMES.has(p.displayName));
  if (!first) {
    note('02-admit-one', 'fail', { error: 'No TEST-SIM student was waiting', waiting: waitingNames });
  } else {
    const t0 = Date.now();
    const headerName = `Admit ${shortName(first.displayName)}`;
    let how = 'header';
    if (!(await clickFirst(teacher.getByRole('button', { name: headerName, exact: true })))) {
      await openRoster();
      await clickNamed(teacher, `Admit ${first.displayName}`);
      how = 'roster';
    }
    let appeared = false;
    for (let i = 0; i < 40; i++) {
      const page = students[first.displayName.split(' ')[0]]?.page;
      if (page && /\/classroom\//.test(page.url())) {
        appeared = true;
        await readyStudent(page);
        break;
      }
      await sleep(500);
    }
    note('02-admit-one', appeared ? 'pass' : 'fail', {
      admitted: first.displayName,
      ui: how,
      studentReachedClassroomMs: appeared ? Date.now() - t0 : null,
    });
  }

  const beforeAll = await teacherState();
  const stillWaiting = beforeAll.data.waiting || [];
  if (!stillWaiting.length) {
    note('02-admit-all', 'skip', { reason: 'nobody left in the waiting room' });
  } else if (!simOnly(stillWaiting)) {
    const sims = stillWaiting.filter((p) => SIM_NAMES.has(p.displayName));
    for (const p of sims) {
      await openRoster();
      await clickNamed(teacher, `Admit ${p.displayName}`).catch((e) => note('02-admit-extra', 'fail', { name: p.displayName, error: String(e).slice(0, 200) }));
      await sleep(400);
    }
    note('02-admit-all', 'skip', {
      reason: 'Waiting list was not exclusively TEST-SIM. Admit all was not clicked. Remaining TEST-SIM students were admitted one by one.',
      outsiderCount: stillWaiting.filter((p) => !SIM_NAMES.has(p.displayName)).length,
      simAdmittedIndividually: sims.map((p) => p.displayName),
    });
  } else {
    const n = stillWaiting.length;
    const header = teacher.getByRole('button', { name: `Admit all (${n})`, exact: true });
    const roster = teacher.getByRole('button', { name: `Admit all ${n} waiting students`, exact: true });
    if (!(await clickFirst(header)) && !(await clickFirst(roster))) {
      await clickFirst(teacher.getByRole('button', { name: /Admit all/ }));
    }
    await sleep(1500);
    note('02-admit-all', 'pass', { count: n, names: stillWaiting.map((p) => p.displayName) });
  }

  for (const id of ['W1', 'W2', 'I1', 'A1']) {
    const page = students[id].page;
    if (!/\/classroom\//.test(page.url())) {
      const landed = await waitForBody(page, /Open chat|Turn camera|Muted by teacher|Tap to return to fullscreen/, 25000);
      students[id].afterAdmit = landed;
    }
    if (/\/classroom\//.test(page.url())) await readyStudent(page);
  }
  const afterAdmit = await teacherState();
  const admittedStudents = (afterAdmit.data.admitted || []).filter((p) => p.role === 'STUDENT');
  const simAdmitted = admittedStudents.filter((p) => SIM_NAMES.has(p.displayName));
  note('02-admitted-state', simAdmitted.length >= 4 && simAdmitted.every((p) => p.mutedByTeacher) ? 'pass' : 'fail', {
    waitingRoomOn: afterAdmit.data.waitingRoomOn,
    mutedByDefault: simAdmitted.every((p) => p.mutedByTeacher),
    admitted: redactPeople(admittedStudents),
    waiting: redactPeople(afterAdmit.data.waiting || []),
    shots: await shotAll('02-admitted'),
  });
  } catch (e) {
    note('02-section', 'fail', { error: String(e.stack || e).slice(0, 700) });
  }

  // 3. Chat.
  try {
  const chatPlan = [
    { from: 'teacher', body: 'Hello class SIM-1', to: 'Everyone' },
    { from: 'teacher', body: 'Private note SIM-2', to: 'W1 Sim' },
    { from: 'W1', body: 'W1 reply SIM-3' },
    { from: 'W2', body: 'W2 reply SIM-4' },
    { from: 'I1', body: 'I1 reply SIM-5' },
    { from: 'A1', body: 'A1 reply SIM-6' },
  ];
  const deliveries = [];
  for (const msg of chatPlan) {
    const page = msg.from === 'teacher' ? teacher : students[msg.from].page;
    try {
      const sent = await sendChat(page, msg.body, msg.to);
      const targets = msg.to && msg.to !== 'Everyone' ? ['teacher', 'W1'] : ['teacher', 'W1', 'W2', 'I1', 'A1'];
      const seen = {};
      for (const id of targets) {
        const who = id === 'teacher' ? teacher : students[id].page;
        seen[id] = await waitMessage(who, msg.body, 10000);
      }
      deliveries.push({ ...msg, sentAt: sent.sentAt, seen });
    } catch (e) {
      deliveries.push({ ...msg, error: String(e).slice(0, 300) });
    }
  }
  const views = {};
  for (const id of ['teacher', 'W1', 'W2', 'I1', 'A1']) {
    const page = id === 'teacher' ? teacher : students[id].page;
    const pack = await messagesOf(page);
    views[id] = pack.messages
      .filter((m) => /SIM-\d/.test(m.body))
      .map((m) => ({ body: m.body, scope: m.scope, sender: m.senderName, recipient: m.recipientName, createdAt: m.createdAt }));
  }
  const expect = {
    teacher: ['Hello class SIM-1', 'Private note SIM-2', 'W1 reply SIM-3', 'W2 reply SIM-4', 'I1 reply SIM-5', 'A1 reply SIM-6'],
    W1: ['Hello class SIM-1', 'Private note SIM-2', 'W1 reply SIM-3'],
    W2: ['Hello class SIM-1', 'W2 reply SIM-4'],
    I1: ['Hello class SIM-1', 'I1 reply SIM-5'],
    A1: ['Hello class SIM-1', 'A1 reply SIM-6'],
  };
  const mismatches = {};
  for (const [id, bodies] of Object.entries(expect)) {
    const got = (views[id] || []).map((m) => m.body).sort();
    const want = [...bodies].sort();
    if (got.join('|') !== want.join('|')) mismatches[id] = { got, want };
  }
  const chatLayouts = {};
  for (const id of ['W1', 'W2', 'I1', 'A1']) {
    chatLayouts[id] = await students[id].page.evaluate(() => {
      const panel = [...document.querySelectorAll('section, div')].find((el) => el.innerText?.includes('Chat message') || el.querySelector?.('[aria-label="Chat message"]'));
      const input = document.querySelector('[aria-label="Chat message"]');
      const r = input?.closest('form')?.getBoundingClientRect();
      return {
        vw: window.innerWidth,
        vh: window.innerHeight,
        toTeacher: /To\s+teacher/i.test(document.body.innerText),
        form: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
        hasPanel: !!panel,
      };
    });
  }
  note('03-chat', Object.keys(mismatches).length ? 'fail' : 'pass', {
    deliveries,
    views,
    mismatches,
    chatLayouts,
    shots: await shotAll('03-chat'),
  });
  } catch (e) {
    note('03-section', 'fail', { error: String(e.stack || e).slice(0, 700) });
  }

  // 4. Hands.
  try {
  const handTimes = {};
  for (const id of ['W2', 'I1']) {
    const t0 = Date.now();
    await readyStudent(students[id].page);
    await clickNamed(students[id].page, 'Raise hand');
    let seen = null;
    for (let i = 0; i < 20; i++) {
      const st = await teacherState();
      const row = (st.data.admitted || []).find((p) => p.displayName === `${id} Sim`);
      if (row?.handRaised) {
        seen = { ms: Date.now() - t0, at: row.handRaisedAt, raisedHands: st.data.raisedHands };
        break;
      }
      await sleep(300);
    }
    handTimes[id] = seen || { ms: null };
    await sleep(1200);
  }
  await openRoster();
  await sleep(400);
  const rowsRaised = await rosterRows();
  const raisedOrder = rowsRaised.filter((r) => r.hand).map((r) => r.name);
  const lowerT0 = Date.now();
  await clickNamed(teacher, "Lower W2 Sim's hand");
  let lowered = false;
  for (let i = 0; i < 20; i++) {
    const st = await teacherState();
    const row = (st.data.admitted || []).find((p) => p.displayName === 'W2 Sim');
    if (row && !row.handRaised) {
      lowered = true;
      break;
    }
    await sleep(300);
  }
  note('04-hands', raisedOrder[0] === 'W2 Sim' && raisedOrder[1] === 'I1 Sim' && rowsRaised.filter((r) => r.hand).every((r) => r.handBeforeName) && lowered ? 'pass' : 'fail', {
    handTimes,
    raisedOrder,
    handBeforeName: rowsRaised.filter((r) => r.hand).map((r) => ({ name: r.name, handBeforeName: r.handBeforeName })),
    lowerW2Ms: lowered ? Date.now() - lowerT0 : null,
    rows: rowsRaised.filter((r) => r.name !== '[non-sim]' || r.hand),
    shots: await shotAll('04-hands'),
  });
  } catch (e) {
    note('04-section', 'fail', { error: String(e.stack || e).slice(0, 700) });
  }

  // 5. Direct entry, then waiting room back on.
  try {
  const preDirect = await teacherState();
  const waitingBeforeOff = preDirect.data.waiting || [];
  if (!simOnly(waitingBeforeOff)) {
    note('05-waiting-off', 'skip', {
      reason: 'Did not turn the waiting room off because a non-TEST-SIM student was waiting. Turning it off would admit them.',
      outsiderCount: waitingBeforeOff.filter((p) => !SIM_NAMES.has(p.displayName)).length,
    });
  } else {
    await openRoster();
    await teacher.getByRole('switch').click();
    const off = await waitForBody(teacher, /Direct entry/, 10000);
    const stOff = await teacherState();
    note('05-waiting-off', off.ok && stOff.data.waitingRoomOn === false ? 'pass' : 'fail', {
      ui: off.ok,
      waitingRoomOn: stOff.data.waitingRoomOn,
      alsoAdmittedByToggle: redactPeople(stOff.data.admitted || []).filter((p) => p.role === 'STUDENT').map((p) => p.name),
    });
    let directJoins = [];
    try {
      for (const id of ['I2', 'A2']) await ensureStudent(id);
      directJoins = await Promise.all(['I2', 'A2'].map((id) => joinStudent(id).catch((e) => ({ id, kind: 'error', error: String(e).slice(0, 240) }))));
    } finally {
      try {
        const cur = await teacherState();
        if (cur.data?.waitingRoomOn === false) {
          // Turning the waiting room back on does not admit anyone. Turning it off does.
          await openRoster();
          await teacher.getByRole('switch').click();
        }
      } catch (e) {
        note('05-restore', 'fail', { error: String(e).slice(0, 220) });
      }
    }
    const onAgain = await waitForBody(teacher, /Waiting room/, 8000);
    const stOn = await teacherState();
    const directState = {};
    for (const id of ['I2', 'A2']) {
      const row = (stOn.data.admitted || []).find((p) => p.displayName === `${id} Sim`);
      const waitingRow = (stOn.data.waiting || []).find((p) => p.displayName === `${id} Sim`);
      directState[id] = {
        join: directJoins.find((j) => j.id === id),
        admitted: !!row,
        mutedByTeacher: row?.mutedByTeacher ?? null,
        stillWaiting: !!waitingRow,
      };
    }
    note('05-direct-entry', directJoins.every((j) => j.kind === 'classroom') && ['I2', 'A2'].every((id) => directState[id].admitted && directState[id].mutedByTeacher) ? 'pass' : 'fail', {
      directState,
      waitingRoomRestored: stOn.data.waitingRoomOn === true,
      restoreUi: onAgain.ok,
      deviation: 'Waiting room was turned back on after I2 and A2 entered so a real student with the school page open would not walk in.',
      outsiderCount: (stOn.data.admitted || []).filter((p) => p.role === 'STUDENT' && !SIM_NAMES.has(p.displayName)).length,
      shots: await shotAll('05-direct'),
    });
  }
  } catch (e) {
    note('05-section', 'fail', { error: String(e.stack || e).slice(0, 700) });
  }

  // 6. Mics.
  const gate = await safeAdmitted();
  const micEvidence = { gateOk: gate.ok, outsiderCount: gate.outsiderCount };
  try {
    const muteTeacher = teacher.getByRole('button', { name: 'Mute microphone', exact: true });
    if (await muteTeacher.count()) await muteTeacher.click();
    await sleep(500);
    await openRoster();
    const unmuteT0 = Date.now();
    await clickNamed(teacher, 'Unmute W1 Sim');
    let unlocked = false;
    for (let i = 0; i < 20; i++) {
      const st = await teacherState();
      const row = (st.data.admitted || []).find((p) => p.displayName === 'W1 Sim');
      if (row && row.mutedByTeacher === false) {
        unlocked = true;
        break;
      }
      await sleep(300);
    }
    micEvidence.unlockW1Ms = unlocked ? Date.now() - unmuteT0 : null;
    await readyStudent(students.W1.page);
    const w1btn = await students.W1.page.getByRole('button', { name: 'Unmute microphone', exact: true }).count();
    micEvidence.w1LocalButton = w1btn ? 'Unmute microphone' : await textOf(students.W1.page, 200);
    if (w1btn) await clickNamed(students.W1.page, 'Unmute microphone');
    await sleep(2500);
    const hear = {};
    for (const id of ['W2', 'I1', 'A1', 'teacher']) {
      const page = id === 'teacher' ? teacher : students[id].page;
      hear[id] = audioSummary((await statsPair(page)).rows);
    }
    micEvidence.afterW1Unmute = hear;

    if (!gate.ok) {
      micEvidence.bulkSkipped = 'Unmute all and Mute all were not clicked because a non-TEST-SIM student is admitted.';
      await openRoster();
      await clickNamed(teacher, 'Mute W1 Sim').catch((e) => (micEvidence.remuteError = String(e).slice(0, 200)));
    } else {
      const othersBefore = await students.W2.page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((n) => /microphone|Muted by teacher/i.test(n.getAttribute('aria-label') || ''));
        return b ? { label: b.getAttribute('aria-label'), disabled: b.disabled } : null;
      });
      await clickNamed(teacher, 'Unmute all');
      await sleep(1200);
      const othersAfter = await students.W2.page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((n) => /microphone|Muted by teacher/i.test(n.getAttribute('aria-label') || ''));
        return b ? { label: b.getAttribute('aria-label'), disabled: b.disabled } : null;
      });
      const stUnlock = await teacherState();
      micEvidence.allowUnmute = {
        label: 'Unmute all (this is the product control that clears the teacher mute lock; it does not turn the local mic on)',
        w2Before: othersBefore,
        w2After: othersAfter,
        locks: (stUnlock.data.admitted || [])
          .filter((p) => p.role === 'STUDENT' && SIM_NAMES.has(p.displayName))
          .map((p) => ({ name: p.displayName, mutedByTeacher: p.mutedByTeacher })),
      };
      if (othersAfter?.label === 'Unmute microphone' && !othersAfter.disabled) {
        await readyStudent(students.W2.page);
        await clickNamed(students.W2.page, 'Unmute microphone');
        await sleep(2500);
        micEvidence.afterW2Also = audioSummary((await statsPair(students.I1.page)).rows);
      }
      const muteAllT0 = Date.now();
      await clickNamed(teacher, 'Mute all');
      let allMuted = false;
      for (let i = 0; i < 20; i++) {
        const st = await teacherState();
        const sims = (st.data.admitted || []).filter((p) => p.role === 'STUDENT' && SIM_NAMES.has(p.displayName));
        if (sims.length && sims.every((p) => p.mutedByTeacher)) {
          allMuted = true;
          break;
        }
        await sleep(300);
      }
      await sleep(1500);
      const e1 = audioSummary((await statsPair(students.I1.page)).rows);
      await sleep(1000);
      const e2 = audioSummary((await statsPair(students.I1.page)).rows);
      micEvidence.muteAll = {
        ms: allMuted ? Date.now() - muteAllT0 : null,
        allMuted,
        i1First: e1,
        i1Second: e2,
        energyDelta: Math.round((e2.inboundEnergy - e1.inboundEnergy) * 1000) / 1000,
      };
    }
    note('06-mic', micEvidence.unlockW1Ms != null ? 'pass' : 'fail', { ...micEvidence, shots: await shotAll('06-mic'), cpu: sampleCpu('after-mic') });
  } catch (e) {
    note('06-mic', 'fail', { error: String(e).slice(0, 400), ...micEvidence, shots: await shotAll('06-mic-fail') });
  }

  // 7. Cameras, layouts, rotation, speaker, cap, privacy.
  const cam = {};
  try {
    for (const id of Object.keys(students)) {
      const page = students[id].page;
      if (!page || page.isClosed() || !/\/classroom\//.test(page.url())) continue;
      await readyStudent(page);
      const label = await page.evaluate(() => {
        const b = document.querySelector('[aria-label="Turn camera on"], [aria-label="Turn camera off"]');
        return b ? b.getAttribute('aria-label') : null;
      });
      if (label === 'Turn camera on') await clickNamed(page, 'Turn camera on');
      cam[id] = { labelBefore: label };
    }
    await sleep(3000);
    for (const n of [2, 4, 6]) {
      await clickNamed(teacher, `Show ${n} videos`);
      await sleep(800);
      const st = await teacherState();
      cam[`layout${n}`] = {
        maxVisibleVideos: st.data.maxVisibleVideos,
        visibleCount: st.data.visibleCount,
        visible: redactPeople((st.data.admitted || []).filter((p) => p.role === 'STUDENT' && p.isVisible)).map((p) => p.name),
      };
      cam[`shot${n}`] = await shot(teacher, `07-layout/teacher-show-${n}`);
    }
    await clickNamed(teacher, 'Show 2 videos');
    await sleep(500);
    // Speaker check: unlock only W1 if the room is still all TEST-SIM.
    const gate2 = await safeAdmitted();
    if (gate2.ok) {
      await openRoster();
      const already = (gate2.st.data.admitted || []).find((p) => p.displayName === 'W1 Sim');
      if (already?.mutedByTeacher) await clickNamed(teacher, 'Unmute W1 Sim');
      await readyStudent(students.W1.page);
      const local = students.W1.page.getByRole('button', { name: 'Unmute microphone', exact: true });
      if (await local.count()) await local.click();
      cam.speakerSetup = 'W1 unmuted so a constant fake tone can be an active speaker';
    } else {
      cam.speakerSetup = 'skipped unmute because a non-TEST-SIM student is admitted';
    }
    const rotation = [];
    const rotStart = Date.now();
    while (Date.now() - rotStart < 40000) {
      const st = await teacherState();
      rotation.push({
        t: new Date().toISOString(),
        elapsedMs: Date.now() - rotStart,
        maxVisibleVideos: st.data.maxVisibleVideos,
        visible: redactPeople((st.data.admitted || []).filter((p) => p.role === 'STUDENT' && p.isVisible)).map((p) => p.name),
      });
      await sleep(4000);
    }
    const privacy = {};
    for (const id of Object.keys(students)) {
      const page = students[id].page;
      if (!page || page.isClosed() || !/\/classroom\//.test(page.url())) continue;
      const pair = await statsPair(page);
      privacy[id] = {
        inboundVideo: videoSummary(pair.rows).inbound,
        inboundVideoCount: videoSummary(pair.rows).inboundCount,
        outboundVideo: videoSummary(pair.rows).outbound,
        videoElements: pair.videos,
        connections: pair.connections,
      };
    }
    const teacherPair = await statsPair(teacher);
    const distinct = new Set(rotation.flatMap((r) => r.visible));
    const privacyLeak = Object.entries(privacy).filter(([, v]) => v.inboundVideoCount > 0);
    note('07-video', privacyLeak.length ? 'fail' : 'pass', {
      cameras: cam,
      rotation,
      distinctOver40s: [...distinct],
      teacherInbound: videoSummary(teacherPair.rows),
      privacy,
      cap: 'Show 6 calls onSlotsChange(5), so maxVisibleVideos becomes 5. The dashboard field was set to 6, which is the product maximum (1–6).',
      cpu: sampleCpu('during-video'),
      shots: await shotAll('07-video'),
    });
    if (gate2.ok) {
      await openRoster();
      const muteBtn = teacher.getByRole('button', { name: 'Mute W1 Sim', exact: true });
      if (await muteBtn.count()) await muteBtn.click();
    }
  } catch (e) {
    note('07-video', 'fail', { error: String(e).slice(0, 400), cameras: cam, shots: await shotAll('07-video-fail') });
  }

  // 8. Pins.
  try {
    await clickNamed(teacher, 'Show 4 videos');
    await sleep(600);
    await openRoster();
    await clickNamed(teacher, "Pin W1 Sim's video");
    await sleep(800);
    const tilePins = teacher.locator('button[aria-label*="keep in the panel"]');
    const tileCount = await tilePins.count();
    const tileLabels = [];
    for (let i = 0; i < tileCount; i++) tileLabels.push(await tilePins.nth(i).getAttribute('aria-label'));
    const other = tileLabels.find((l) => l && !l.includes('W1 Sim'));
    if (other) await clickNamed(teacher, other);
    await sleep(800);
    const pinned1 = await teacherState();
    const pinnedNames = redactPeople((pinned1.data.admitted || []).filter((p) => p.role === 'STUDENT' && p.pinned)).map((p) => p.name);
    const stay = [];
    for (let i = 0; i < 3; i++) {
      await sleep(8000);
      const st = await teacherState();
      stay.push({
        t: new Date().toISOString(),
        visible: redactPeople((st.data.admitted || []).filter((p) => p.role === 'STUDENT' && p.isVisible)).map((p) => p.name),
        pinned: redactPeople((st.data.admitted || []).filter((p) => p.role === 'STUDENT' && p.pinned)).map((p) => p.name),
      });
    }
    await openRoster();
    for (const name of pinnedNames) {
      const btn = teacher.getByRole('button', { name: `Unpin ${name}'s video`, exact: true });
      if (await btn.count()) await btn.click();
      await sleep(300);
    }
    await clickNamed(teacher, 'Show 2 videos');
    await sleep(500);
    await openRoster();
    await clickNamed(teacher, "Pin W1 Sim's video");
    await sleep(600);
    const pinLogBefore = pinLog.length;
    await openRoster();
    await clickNamed(teacher, "Pin A1 Sim's video");
    await sleep(1000);
    const overflowResponses = pinLog.slice(pinLogBefore);
    const afterOverflow = await teacherState();
    const notice = await textOf(teacher, 500);
    note('08-pin', pinnedNames.includes('W1 Sim') ? 'pass' : 'fail', {
      tileLabels,
      pinnedFromRosterAndTile: pinnedNames,
      stayedThroughRotation: stay,
      overflow: {
        layout: 'Show 2 videos sets maxVisibleVideos to 1',
        responses: overflowResponses,
        pinnedAfter: redactPeople((afterOverflow.data.admitted || []).filter((p) => p.role === 'STUDENT' && p.pinned)).map((p) => p.name),
        maxVisibleVideos: afterOverflow.data.maxVisibleVideos,
        notice: /pinned|slot/i.test(notice) ? notice.slice(0, 240) : null,
      },
      shots: await shotAll('08-pin'),
    });
  } catch (e) {
    note('08-pin', 'fail', { error: String(e).slice(0, 400), pinLog: pinLog.slice(-6), shots: await shotAll('08-pin-fail') });
  }

  // 9. Screen share and the clip that fake capture will not actually record.
  try {
    const clip = await teacherCtx.newPage();
    const wavB64 = fs.readFileSync(WAV).toString('base64');
    await clip.setContent('<!doctype html><title>SIM clip</title><p id="label">SIM-CLIP playing</p><canvas id="c" width="320" height="180"></canvas>');
    await clip.evaluate(async (b64) => {
      const c = document.getElementById('c');
      const g = c.getContext('2d');
      g.fillStyle = '#ff00ff';
      g.fillRect(0, 0, 320, 180);
      g.fillStyle = '#fff';
      g.font = '24px sans-serif';
      g.fillText('SIM-CLIP', 20, 90);
      const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const audio = new Audio(URL.createObjectURL(new Blob([bin], { type: 'audio/wav' })));
      audio.loop = true;
      await audio.play().catch((e) => {
        window.__clipErr = String(e);
      });
      window.__clipStarted = !audio.paused;
    }, wavB64);
    await shot(clip, '09-share/clip-tab');
    const shareT0 = Date.now();
    await clickNamed(teacher, 'Share screen');
    await sleep(4000);
    const shareUi = await textOf(teacher, 1200);
    const expand = teacher.getByRole('button', { name: /Expand share controls/ });
    if (await expand.count()) await expand.first().click();
    await sleep(400);
    const annotateBtn = teacher.getByRole('button', { name: 'Annotate', exact: true });
    const annotate = {
      count: await annotateBtn.count(),
      disabled: (await annotateBtn.count()) ? await annotateBtn.first().isDisabled() : null,
      title: (await annotateBtn.count()) ? await annotateBtn.first().getAttribute('title') : null,
    };
    const teacherMedia = await collectStats(teacher);
    const studentShare = {};
    for (const id of Object.keys(students)) {
      const page = students[id].page;
      if (!page || page.isClosed() || !/\/classroom\//.test(page.url())) continue;
      await sleep(500);
      const pair = await statsPair(page);
      studentShare[id] = {
        video: videoSummary(pair.rows),
        audio: audioSummary(pair.rows),
        connections: pair.connections,
      };
    }
    note('09-screen-share', teacherMedia.display ? 'pass' : 'fail', {
      clickToSampleMs: Date.now() - shareT0,
      uiSnippet: shareUi.slice(0, 500),
      entireScreenCard: /entire screen/i.test(shareUi),
      displayConstraints: teacherMedia.displayConstraints,
      displayTracks: teacherMedia.display,
      annotate,
      clip: 'A second teacher-context tab played tone.wav and painted a magenta SIM-CLIP canvas. Fake getDisplayMedia returns the Y4M file, not that tab.',
      studentShare,
      cpu: sampleCpu('during-share'),
      shots: { ...(await shotAll('09-share')), clip: 'shots/09-share/clip-tab.png' },
    });
    await clip.close().catch(() => {});
  } catch (e) {
    note('09-screen-share', 'fail', { error: String(e).slice(0, 400), shots: await shotAll('09-share-fail') });
  }

  // 10. Annotation.
  try {
    const annotateBtn = teacher.getByRole('button', { name: 'Annotate', exact: true });
    const expand = teacher.getByRole('button', { name: /Expand share controls/ });
    if ((await annotateBtn.count()) === 0 && (await expand.count())) await expand.first().click();
    const disabled = (await annotateBtn.count()) ? await annotateBtn.first().isDisabled() : true;
    const title = (await annotateBtn.count()) ? await annotateBtn.first().getAttribute('title') : null;
    let drew = false;
    if (!disabled && (await annotateBtn.count())) {
      await annotateBtn.first().click();
      const pen = teacher.getByRole('button', { name: 'Pen', exact: true });
      if (await pen.count()) await pen.click();
      const surface = teacher.locator('canvas, svg.annotate, [data-annotate]').first();
      if (await surface.count()) {
        const box = await surface.boundingBox();
        if (box) {
          await teacher.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3);
          await teacher.mouse.down();
          await teacher.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 8 });
          await teacher.mouse.up();
          drew = true;
          const eraser = teacher.getByRole('button', { name: 'Erase', exact: true });
          if (await eraser.count()) {
            await eraser.click();
            await teacher.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.45);
          }
          const undo = teacher.getByRole('button', { name: 'Undo', exact: true });
          if (await undo.count()) await undo.click();
          const clear = teacher.getByRole('button', { name: 'Clear', exact: true });
          if (await clear.count()) await clear.click();
        }
      }
    }
    await sleep(1500);
    const studentStrokes = {};
    for (const id of Object.keys(students)) {
      if (id.startsWith('_')) continue;
      const page = students[id].page;
      if (!page || page.isClosed()) continue;
      studentStrokes[id] = await page.evaluate(() => {
        const shapes = [...document.querySelectorAll('svg path, svg line, svg polyline, svg circle')];
        return {
          shapeCount: shapes.length,
          sample: shapes.slice(0, 4).map((n) => ({ tag: n.tagName, d: (n.getAttribute('d') || '').slice(0, 80) })),
          annotateButton: !!document.querySelector('button') && [...document.querySelectorAll('button')].some((b) => /annotate/i.test(b.innerText || b.getAttribute('aria-label') || '')),
        };
      });
    }
    const anyStudentAnnotate = Object.values(studentStrokes).some((s) => s.annotateButton);
    note('10-annotation', 'fail', {
      expected: true,
      annotateDisabled: disabled,
      title,
      drew,
      studentStrokes,
      studentAnnotationExists: anyStudentAnnotate,
      reason: disabled
        ? 'Annotate was disabled. Entire-screen / fake capture has no preview to draw on, so strokes were not sent.'
        : drew
          ? 'A stroke was attempted on the teacher surface.'
          : 'No drawing surface was found.',
      shots: await shotAll('10-annotate'),
    });
    if (!disabled && drew && Object.values(studentStrokes).some((s) => s.shapeCount > 0)) {
      steps[steps.length - 1].status = 'pass';
    }
  } catch (e) {
    note('10-annotation', 'fail', { error: String(e).slice(0, 400) });
  }

  // 11. Blackout and overlay, portrait and landscape.
  const coverage = {};
  try {
    for (const id of Object.keys(students)) {
      if (!students[id].page || students[id].page.isClosed() || !/\/classroom\//.test(students[id].page.url())) continue;
      const page = students[id].page;
      const orientations = id.startsWith('W') ? ['portrait'] : ['portrait', 'landscape'];
      coverage[id] = {};
      for (const orient of orientations) {
        if (id.startsWith('I')) {
          await page.setViewportSize(orient === 'portrait' ? { width: 390, height: 844 } : { width: 844, height: 390 });
        } else if (id.startsWith('A')) {
          await page.setViewportSize(orient === 'portrait' ? { width: 412, height: 915 } : { width: 915, height: 412 });
        }
        await sleep(700);
        coverage[id][orient] = {
          frame: await measureFrame(page),
          overlay: await measureOverlay(page),
          shot: await shot(page, `11-coverage/${id}-${orient}`),
        };
      }
    }
    coverage.teacherShot = await shot(teacher, '11-coverage/teacher');
    note('11-coverage', 'pass', {
      coverage,
      howToRead: 'blackPct/greenPct are of the largest decoded <video> on the student page (the received share). The fake capturer feeds green.y4m (640x360, 0x00ff00), not the classroom tab, so a real toolbar mask only shows up if the publisher paints black onto those frames. overlayPct is the student viewport covered by the student chrome (controls, teacher-camera float, badges, fullscreen cover).',
    });
  } catch (e) {
    note('11-coverage', 'fail', { error: String(e).slice(0, 400), coverage });
  }

  // 12. Fullscreen.
  try {
    const focusPages = ['W1', 'I1', 'A1'].filter((id) => students[id]?.page && /\/classroom\//.test(students[id].page.url()));
    const focus = {};
    for (const id of focusPages) {
      const page = students[id].page;
      await page.evaluate(() => {
        window.__fsResult = null;
        document.addEventListener(
          'pointerdown',
          () => {
            const enabled = !!document.fullscreenEnabled;
            if (!document.fullscreenElement && enabled && document.documentElement.requestFullscreen) {
              document.documentElement.requestFullscreen().then(
                () => {
                  window.__fsResult = { enabled, entered: !!document.fullscreenElement };
                },
                (e) => {
                  window.__fsResult = { enabled, entered: false, error: String(e).slice(0, 160) };
                }
              );
            } else {
              window.__fsResult = { enabled, entered: !!document.fullscreenElement, already: true };
            }
          },
          { once: true, capture: true }
        );
      });
      await page.mouse.click(20, 20);
      await sleep(800);
      const entered = await page.evaluate(() => window.__fsResult);
      if (entered?.entered) await page.evaluate(() => document.exitFullscreen().catch(() => {}));
      await sleep(1500);
      const ui = await page.evaluate(() => ({
        cover: !!document.querySelector('[aria-label="Tap to return to fullscreen"]'),
        rotate: /Rotate your phone to landscape/.test(document.body.innerText),
        fullscreenEnabled: !!document.fullscreenEnabled,
        fullscreen: !!document.fullscreenElement,
        text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 240),
      }));
      focus[id] = { entered, ui, shot: await shot(page, `12-focus/${id}`) };
    }
    await sleep(1200);
    const st = await teacherState();
    const badge = await textOf(teacher, 800);
    const m = badge.match(/(\d+) not in fullscreen/);
    note('12-fullscreen', 'pass', {
      focus,
      teacherBadge: m ? m[0] : null,
      teacherFocus: redactPeople((st.data.admitted || []).filter((p) => p.role === 'STUDENT')).map((p) => ({
        name: p.name,
        focus: p.focus,
        focusIphone: p.focusIphone,
      })),
      shots: { teacher: await shot(teacher, '12-focus/teacher') },
      emulation: 'CriOS on Chromium still has the Fullscreen API, so an iPhone UA does not take the iOS Safari "no Fullscreen API" path unless fullscreenEnabled is false. This is not a real iPhone result.',
    });
  } catch (e) {
    note('12-fullscreen', 'fail', { error: String(e).slice(0, 400) });
  }

  // 13. Roster chips, invite, leave/rejoin, end.
  try {
    const stop = teacher.getByRole('button', { name: 'Stop sharing screen', exact: true });
    if (await stop.count()) await stop.click().catch(() => {});
    await sleep(1000);
    await openRoster();
    const chips = await rosterRows();
    let invite = { clicked: false };
    const copy = teacher.getByRole('button', { name: 'Copy invite link', exact: true });
    if (await copy.count()) {
      await copy.click();
      await sleep(400);
      invite = await teacher.evaluate(async () => {
        let clip = null;
        let clipError = null;
        try {
          clip = await navigator.clipboard.readText();
        } catch (e) {
          clipError = String(e).slice(0, 160);
        }
        return { clicked: true, copiedLabel: /Copied!/.test(document.body.innerText), clip, clipError };
      });
    }
    const leaveT0 = Date.now();
    await readyStudent(students.W2.page);
    await clickNamed(students.W2.page, 'Leave class');
    await students.W2.page.waitForURL((u) => !u.pathname.includes('/classroom'), { timeout: 20000 }).catch(() => {});
    const left = { href: students.W2.page.url(), ms: Date.now() - leaveT0, text: (await textOf(students.W2.page, 200)).slice(0, 180) };
    const rejoined = await joinStudent('W2');
    let readmit = null;
    if (rejoined.kind === 'waiting') {
      const st = await teacherState();
      const row = (st.data.waiting || []).find((p) => p.displayName === 'W2 Sim');
      if (row && simOnly([row])) {
        await openRoster();
        await clickNamed(teacher, 'Admit W2 Sim');
        readmit = await waitForBody(students.W2.page, /Open chat|Turn camera|Muted by teacher/, 20000);
      } else {
        readmit = { skipped: true, reason: row ? 'name mismatch' : 'W2 not waiting' };
      }
    }
    note('13-roster-invite-leave', 'pass', {
      chips: chips.filter((c) => c.name !== '[non-sim]'),
      outsiderRows: chips.filter((c) => c.name === '[non-sim]').length,
      invite,
      left,
      rejoined,
      readmit,
      deviceSwitch: 'not exercised (optional)',
      shots: await shotAll('13-roster'),
    });
  } catch (e) {
    note('13-roster-invite-leave', 'fail', { error: String(e).slice(0, 400), shots: await shotAll('13-roster-fail') });
  }

  const beforeEnd = await teacherState().catch(() => null);
  const endInfo = await endClass();
  await sleep(2000);
  const endedViews = {};
  for (const id of Object.keys(students)) {
    const page = students[id]?.page;
    if (!page || page.isClosed()) continue;
    endedViews[id] = { href: page.url(), text: (await textOf(page, 300)).slice(0, 280), shot: await shot(page, `13-ended/${id}`) };
  }
  let home = null;
  const homePage = students.W1?.page;
  if (homePage && /Class ended/.test(await textOf(homePage, 400))) {
    const homeBtn = homePage.getByRole('button', { name: 'Home', exact: true });
    if (await homeBtn.count()) {
      await homeBtn.click();
      await homePage.waitForURL(/\/student|\/$/, { timeout: 20000 }).catch(() => {});
      await sleep(1500);
      home = { href: homePage.url(), text: (await textOf(homePage, 300)).slice(0, 280), shot: await shot(homePage, '13-ended/W1-home') };
    }
  }
  const teacherHome = { href: teacher.url(), text: (await textOf(teacher, 240)).slice(0, 200), shot: await shot(teacher, '13-ended/teacher') };
  note('13-end', /Class ended/.test(Object.values(endedViews).map((v) => v.text).join(' ')) ? 'pass' : 'fail', {
    endInfo,
    sessionBeforeEnd: beforeEnd?.data?.classSession || null,
    endedViews,
    studentHome: home,
    teacherHome,
    cpu: sampleCpu('after-end'),
  });

  // Cleanup listing. No DELETE is attempted: the admin students route is GET-only.
  let admin = null;
  try {
    admin = await teacher.evaluate(async () => {
      const r = await fetch('/api/admin/students', { credentials: 'same-origin' });
      const data = await r.json().catch(() => null);
      return { http: r.status, isArray: Array.isArray(data), keys: data && typeof data === 'object' ? Object.keys(data).slice(0, 8) : [] };
    });
  } catch (e) {
    admin = { error: String(e).slice(0, 200) };
  }
  note('cleanup', 'pass', {
    classEnded,
    deleted: false,
    reason: 'Teacher session cannot delete students. /api/admin/students is GET-only and this account is not used to change records. TEST-SIM students and their attendance rows are left for manual cleanup.',
    sids: ['TEST-SIM-W1', 'TEST-SIM-W2', 'TEST-SIM-I1', 'TEST-SIM-I2', 'TEST-SIM-A1', 'TEST-SIM-A2'],
    names: [...SIM_NAMES],
    grade: students.W1?.grade,
    division: students.W1?.division,
    roomCode,
    subject: 'SIM e2e',
    adminProbe: admin,
  });
}

process.on('SIGINT', () => {
  cleanup().finally(() => process.exit(1));
});
process.on('SIGTERM', () => {
  cleanup().finally(() => process.exit(1));
});

main()
  .then(async () => {
    save();
    console.log('SIM_DONE');
  })
  .catch(async (e) => {
    note('fatal', 'fail', { error: String(e && e.stack ? e.stack : e).slice(0, 800) });
    console.log('SIM_FAIL');
  })
  .finally(async () => {
    await cleanup();
    save();
  });
