/**
 * Live-class UX review against https://13-201-89-150.sslip.io.
 *
 *   CLASSROOM_TEACHER_PASSWORD='…' node run.mjs
 *
 * The password is read only from the environment. It is never written to
 * results, logs, or screenshot names. Devices are emulated Chromium contexts,
 * not real phones or tablets.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'https://13-201-89-150.sslip.io';
const EMAIL = 'jitendraphand@gmail.com';
const PASS = process.env.CLASSROOM_TEACHER_PASSWORD || '';
const Y4M = path.join(ROOT, 'media', 'green.y4m');
const WAV = path.join(ROOT, 'media', 'tone.wav');
const SHOTS = path.join(ROOT, 'shots');
const RESULTS = path.join(ROOT, 'results.json');
const HZ = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim()) || 100;

const UA = {
  windows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  android:
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  tablet:
    'Mozilla/5.0 (Linux; Android 14; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1',
  ipad:
    'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1',
};

const ROSTER = [
  { id: 'WD1', family: 'windows-desktop', ua: UA.windows, w: 1366, h: 768, mobile: false, primary: 'landscape' },
  { id: 'WD2', family: 'windows-desktop', ua: UA.windows, w: 1280, h: 800, mobile: false, primary: 'landscape' },
  { id: 'AP1', family: 'android-phone', ua: UA.android, w: 412, h: 915, mobile: true, primary: 'portrait' },
  { id: 'AP2', family: 'android-phone', ua: UA.android, w: 412, h: 915, mobile: true, primary: 'portrait' },
  { id: 'AT1', family: 'android-tablet', ua: UA.tablet, w: 1280, h: 800, mobile: true, primary: 'landscape' },
  { id: 'AT2', family: 'android-tablet', ua: UA.tablet, w: 1280, h: 800, mobile: true, primary: 'landscape' },
  { id: 'IP1', family: 'iphone', ua: UA.iphone, w: 390, h: 844, mobile: true, primary: 'portrait' },
  { id: 'IP2', family: 'iphone', ua: UA.iphone, w: 390, h: 844, mobile: true, primary: 'portrait' },
  { id: 'ID1', family: 'ipad', ua: UA.ipad, w: 1180, h: 820, mobile: true, primary: 'landscape' },
  { id: 'ID2', family: 'ipad', ua: UA.ipad, w: 1180, h: 820, mobile: true, primary: 'landscape', late: true },
];
const FAMILIES = ['WD1', 'AP1', 'AT1', 'IP1', 'ID1'];
const REV = new Set(ROSTER.map((s) => `${s.id} Rev`));

const steps = [];
const consoleErrors = {};
let browser = null;
let teacher = null;
let teacherCtx = null;
let roomCode = '';
let classEnded = false;
let launchMode = '';
const students = {};
let cpuPrev = null;

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
    devices: ROSTER.map((s) => ({
      id: s.id,
      sid: `TEST-REV-${s.id}`,
      family: s.family,
      viewport: [s.w, s.h],
      mobile: s.mobile,
      late: !!s.late,
    })),
    steps,
    consoleErrors,
  });
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(RESULTS, JSON.stringify(payload, null, 2));
}
function note(name, status, detail) {
  const row = { t: new Date().toISOString(), name, status, detail: detail ?? null };
  steps.push(row);
  const brief = detail && detail.error ? String(detail.error).slice(0, 240) : '';
  console.log(`STEP ${row.t} ${status.toUpperCase()} ${name}${brief ? ' ' + brief : ''}`);
  save();
  return row;
}
function shortName(full) {
  const parts = String(full).trim().split(/\s+/);
  if (parts.length < 2) return parts[0] || '';
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}
function simOnly(list) {
  return (list || []).every((p) => REV.has(p.displayName || p.name));
}

async function shot(page, name) {
  if (!page || page.isClosed()) return null;
  const file = path.join(SHOTS, `${name}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    await page.screenshot({ path: file, timeout: 15000 });
  } catch (e) {
    return { file: path.relative(ROOT, file), error: String(e).slice(0, 160) };
  }
  return path.relative(ROOT, file);
}
async function shotFamilies(tag) {
  const out = {};
  if (teacher) out.teacher = await shot(teacher, `${tag}/teacher`);
  for (const id of FAMILIES) {
    const s = students[id];
    if (s?.page && !s.page.isClosed()) out[id] = await shot(s.page, `${tag}/${id}`);
  }
  return out;
}
async function shotAll(tag) {
  const out = await shotFamilies(tag);
  for (const [id, s] of Object.entries(students)) {
    if (out[id] || !s.page || s.page.isClosed()) continue;
    out[id] = await shot(s.page, `${tag}/${id}`);
  }
  return out;
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
function procStat(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return { ppid: Number(rest[1]), utime: Number(rest[11]), stime: Number(rest[12]), comm: s.slice(s.indexOf('(') + 1, s.lastIndexOf(')')) };
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
function chromeRootPid() {
  let found = null;
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const text = fs.readFileSync(`/proc/${name}/cmdline`).toString('utf8');
      if (!text.includes('green.y4m') || !text.includes('chrome') || text.includes('--type=')) continue;
      found = Number(name);
    } catch {
      /* gone */
    }
  }
  return found;
}
function sampleCpu(label) {
  try {
    const root = chromeRootPid();
    if (!root) return { label, error: 'chrome pid not found' };
    const procs = processTree(root);
    const ticks = procs.reduce((n, p) => n + p.ticks, 0);
    const rss = procs.reduce((n, p) => n + p.rss, 0);
    const now = Date.now();
    let cpuCores = null;
    if (cpuPrev) {
      const dt = (now - cpuPrev.at) / 1000;
      if (dt > 0) cpuCores = Math.round(((ticks - cpuPrev.ticks) / HZ / dt) * 100) / 100;
    }
    cpuPrev = { at: now, ticks };
    console.log(`PROGRESS cpu ${label} rssMb=${Math.round(rss / 1048576)} procs=${procs.length} cores=${cpuCores}`);
    return {
      t: new Date().toISOString(),
      label,
      root,
      processCount: procs.length,
      rssMb: Math.round(rss / 1048576),
      cpuCores,
      note: 'One Chrome tree hosts every context. Per-device CPU is not separable.',
    };
  } catch (e) {
    return { label, error: String(e).slice(0, 160) };
  }
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
        }));
        return stream;
      };
    }
  }
};

async function newContext(id, spec) {
  const ctx = await browser.newContext({
    userAgent: spec.ua,
    viewport: { width: spec.w, height: spec.h },
    deviceScaleFactor: 1,
    isMobile: spec.mobile,
    hasTouch: spec.mobile,
    locale: 'en-US',
    timezoneId: 'UTC',
    permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'],
  });
  await ctx.addInitScript(INIT);
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(45000);
  consoleErrors[id] = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const list = consoleErrors[id];
    if (list.length < 20) list.push(msg.text().slice(0, 240));
  });
  page.on('dialog', async (dialog) => {
    const message = dialog.message();
    if (message.includes('End class for everyone?')) await dialog.accept();
    else await dialog.dismiss();
  });
  return { ctx, page };
}

async function teacherState() {
  return teacher.evaluate(async (code) => {
    const r = await fetch(`/api/rooms/${code}/state`, { credentials: 'same-origin' });
    const data = await r.json().catch(() => ({}));
    return { http: r.status, data };
  }, roomCode);
}
function people(list) {
  return (list || []).map((p) => ({
    name: REV.has(p.displayName) ? p.displayName : '[non-rev]',
    role: p.role,
    mutedByTeacher: p.mutedByTeacher,
    handRaised: p.handRaised,
    handRaisedAt: p.handRaisedAt,
    pinned: p.pinned,
    isVisible: p.isVisible,
    focus: p.focus,
    viaSchoolApp: p.viaSchoolApp,
    gradeDivision: p.gradeDivision,
  }));
}
async function clickNamed(page, name) {
  const loc = page.getByRole('button', { name, exact: true });
  const n = await loc.count();
  for (let i = 0; i < n; i++) {
    const el = loc.nth(i);
    if (await el.isVisible().catch(() => false)) {
      await el.click({ timeout: 8000 });
      return true;
    }
  }
  return false;
}
async function clickRe(page, re) {
  const loc = page.getByRole('button', { name: re });
  const n = await loc.count();
  for (let i = 0; i < n; i++) {
    const el = loc.nth(i);
    if (await el.isVisible().catch(() => false)) {
      await el.click({ timeout: 8000 });
      return true;
    }
  }
  return false;
}
async function ready(page) {
  for (let i = 0; i < 2; i++) {
    const cover = page.getByRole('button', { name: 'Tap to return to fullscreen' });
    if (!(await cover.count())) return;
    if (!(await cover.first().isVisible().catch(() => false))) return;
    await cover.first().click({ timeout: 5000 }).catch(() => {});
    await sleep(250);
  }
}
async function rosterOpen() {
  const loc = teacher.getByRole('button', { name: 'Close roster', exact: true });
  const n = await loc.count();
  for (let i = 0; i < n; i++) if (await loc.nth(i).isVisible().catch(() => false)) return true;
  return false;
}
async function openRoster() {
  if (await rosterOpen()) return true;
  if (await clickNamed(teacher, 'Open roster')) return true;
  return clickRe(teacher, /^Roster$/);
}
async function openChat(page) {
  await ready(page);
  const close = page.getByRole('button', { name: 'Close chat', exact: true });
  if ((await close.count()) && (await close.first().isVisible().catch(() => false))) return 'already';
  if (await clickNamed(page, 'Open chat')) {
    await sleep(250);
    return 'dock';
  }
  if (!(await page.locator('input[aria-label="Chat message"]').count())) {
    await clickRe(page, /^Expand share controls/);
    await sleep(300);
  }
  const hud = page.getByRole('button', { name: 'Chat', exact: true });
  if ((await hud.count()) && (await hud.first().isVisible().catch(() => false))) {
    await hud.first().click();
    await sleep(300);
    return 'hud';
  }
  if (await page.locator('input[aria-label="Chat message"]').count()) return 'already-input';
  return 'missing';
}
async function closeChat(page) {
  if (await clickNamed(page, 'Close chat')) return true;
  if (await clickNamed(page, 'Close panel')) return true;
  const hud = page.getByRole('button', { name: 'Close chat window', exact: true });
  if ((await hud.count()) && (await hud.first().isVisible().catch(() => false))) {
    await hud.first().click();
    return true;
  }
  return false;
}
async function chatSnap(page) {
  return page.evaluate(() => {
    const input = document.querySelector('input[aria-label="Chat message"]');
    const root = input?.closest('.float-panel') || input?.closest('form')?.parentElement || null;
    const select = (root || document).querySelector('select');
    const send = document.querySelector('button[aria-label="Send message"]');
    const box = root?.getBoundingClientRect();
    const text = (root?.innerText || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1800);
    return {
      open: !!input,
      placeholder: input?.getAttribute('placeholder') || null,
      sendLabel: send?.getAttribute('aria-label') || null,
      sendDisabled: send ? !!send.disabled : null,
      toOptions: select ? [...select.options].map((o) => o.textContent.trim()) : [],
      toSelected: select?.selectedOptions?.[0]?.textContent?.trim() || null,
      text,
      box: box ? { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) } : null,
      vw: innerWidth,
      vh: innerHeight,
      coverPct: box ? Math.round((1000 * (box.width * box.height)) / (innerWidth * innerHeight)) / 10 : null,
    };
  });
}
async function badgeText(page, label) {
  return page.evaluate((label) => {
    const b = [...document.querySelectorAll('button')].find((el) => el.getAttribute('aria-label') === label);
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { label, text: (b.textContent || '').replace(/\s+/g, ' ').trim(), w: Math.round(r.width), h: Math.round(r.height), disabled: b.disabled };
  }, label);
}
async function waitBody(page, body, timeout = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const hit = await page
      .evaluate(async ({ code, body }) => {
        const r = await fetch(`/api/rooms/${code}/messages`, { credentials: 'same-origin' });
        if (!r.ok) return { http: r.status };
        const data = await r.json();
        const m = (data.messages || []).find((x) => x.body === body);
        if (!m) return null;
        return { scope: m.scope, sender: m.senderName, recipient: m.recipientName, createdAt: m.createdAt };
      }, { code: roomCode, body })
      .catch(() => null);
    if (hit && hit.scope) return { ms: Date.now() - t0, ...hit };
    await sleep(250);
  }
  return { ms: null };
}
async function sendChat(page, body, toLabel) {
  const t0 = Date.now();
  let clicks = 0;
  const how = await openChat(page);
  if (how === 'missing') return { ok: false, how, clicks, ms: Date.now() - t0 };
  if (how !== 'already' && how !== 'already-input') clicks += 1;
  if (toLabel) {
    const sel = page.locator('select').last();
    await sel.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    const labels = (await sel.locator('option').allTextContents().catch(() => [])).map((s) => s.trim());
    if (!labels.includes(toLabel)) {
      return { ok: false, how, clicks, ms: Date.now() - t0, error: 'missing option', options: labels.slice(0, 20) };
    }
    await sel.selectOption({ label: toLabel });
    clicks += 1;
  }
  const input = page.locator('input[aria-label="Chat message"]');
  await input.fill(body);
  await page.locator('button[aria-label="Send message"]').click();
  clicks += 1;
  return { ok: true, how, clicks, ms: Date.now() - t0, sentAt: new Date().toISOString() };
}
async function micInfo(page) {
  return page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((el) => /microphone|Muted by teacher/i.test(el.getAttribute('aria-label') || ''));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { label: b.getAttribute('aria-label'), disabled: b.disabled, w: Math.round(r.width), h: Math.round(r.height) };
  });
}
async function floatInfo(page) {
  return page.evaluate(() => {
    const pane = document.querySelector('.student-media-float');
    if (!pane) return { present: false, vw: innerWidth, vh: innerHeight };
    const r = pane.getBoundingClientRect();
    return {
      present: true,
      minimized: pane.getAttribute('data-minimized'),
      aria: pane.getAttribute('aria-label'),
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
      teacherCam: !!pane.querySelector('[aria-label="Teacher camera"]'),
      selfCam: !!pane.querySelector('[aria-label="Your camera"]'),
      buttons: [...pane.querySelectorAll('button')].map((b) => (b.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean),
      vw: innerWidth,
      vh: innerHeight,
    };
  });
}
async function dragFloat(page) {
  const head = page.locator('.student-media-head');
  if (!(await head.count())) return { dragged: false, reason: 'no drag handle' };
  const before = await floatInfo(page);
  const box = await head.boundingBox();
  if (!box) return { dragged: false, reason: 'no box', before };
  await page.mouse.move(box.x + Math.min(40, box.width / 2), box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(Math.max(8, box.x - 90), Math.max(8, box.y - 70), { steps: 8 });
  await page.mouse.up();
  await sleep(200);
  const after = await floatInfo(page);
  return { dragged: true, dx: after.x - before.x, dy: after.y - before.y, before, after };
}
async function measureFrame(page) {
  return page.evaluate(async () => {
    const videos = [...document.querySelectorAll('video')];
    let best = null;
    for (const v of videos) if (v.videoWidth > (best?.videoWidth || 0)) best = v;
    if (!best?.videoWidth) return { ok: false, videoCount: videos.length };
    const w = 160;
    const h = Math.max(1, Math.round((160 * best.videoHeight) / best.videoWidth));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    try {
      ctx.drawImage(best, 0, 0, w, h);
    } catch (e) {
      return { ok: false, reason: String(e).slice(0, 120), videoCount: videos.length };
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
    const vw = innerWidth;
    const vh = innerHeight;
    const sels = ['.student-media-float', '.stage-float-chrome', '.stage-fullscreen-badge', '.control-float', '.control-rail', '.float-panel', '[aria-label="Tap to return to fullscreen"]'];
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
    return { vw, vh, overlayPct: Math.round((1000 * cells.size) / (grid * grid)) / 10, boxes };
  });
}
async function sampleStats(page) {
  const read = () =>
    page.evaluate(async () => {
      const pcs = window.__e2ePcs || [];
      const rows = [];
      for (const pc of pcs) {
        let report;
        try {
          report = await pc.getStats();
        } catch {
          continue;
        }
        report.forEach((r) => {
          if (r.type !== 'inbound-rtp' && r.type !== 'outbound-rtp') return;
          rows.push({
            type: r.type,
            kind: r.kind || r.mediaType || null,
            bytes: r.bytesReceived || r.bytesSent || 0,
            w: r.frameWidth || null,
            h: r.frameHeight || null,
            fps: r.framesPerSecond || null,
            rid: r.rid || null,
            audioLevel: r.audioLevel ?? null,
            energy: r.totalAudioEnergy ?? null,
            mime: r.mimeType || null,
          });
        });
      }
      return rows;
    });
  const a = await read();
  await sleep(1000);
  const b = await read();
  const key = (r) => `${r.type}|${r.kind}|${r.w}|${r.h}|${r.rid}`;
  const map = new Map(a.map((r) => [key(r), r]));
  return b.map((r) => {
    const prev = map.get(key(r));
    const kbps = prev ? Math.max(0, Math.round((((r.bytes || 0) - (prev.bytes || 0)) * 8) / 1000)) : null;
    return { ...r, kbps };
  });
}
function summarizeShare(rows) {
  const video = rows.filter((r) => r.type === 'inbound-rtp' && r.kind === 'video' && r.w);
  const audio = rows.filter((r) => r.type === 'inbound-rtp' && r.kind === 'audio');
  return {
    video: video.map((r) => ({ w: r.w, h: r.h, fps: r.fps, rid: r.rid, kbps: r.kbps, mime: r.mime })),
    audio: audio.map((r) => ({ kbps: r.kbps, level: r.audioLevel, energy: r.energy, mime: r.mime })),
  };
}
async function inboundVideoCount(page) {
  const rows = await sampleStats(page).catch(() => []);
  return {
    inboundVideo: rows.filter((r) => r.type === 'inbound-rtp' && r.kind === 'video' && r.w).length,
    connections: await page.evaluate(() => (window.__e2ePcs || []).map((pc) => ({ connection: pc.connectionState, ice: pc.iceConnectionState }))).catch(() => []),
  };
}
async function orient(id, mode) {
  const spec = ROSTER.find((s) => s.id === id);
  const page = students[id].page;
  if (mode === 'primary') {
    await page.setViewportSize(spec.primary === 'portrait' ? { width: spec.w, height: spec.h } : { width: Math.max(spec.w, spec.h), height: Math.min(spec.w, spec.h) });
  } else if (mode === 'portrait') {
    await page.setViewportSize({ width: Math.min(spec.w, spec.h), height: Math.max(spec.w, spec.h) });
  } else {
    await page.setViewportSize({ width: Math.max(spec.w, spec.h), height: Math.min(spec.w, spec.h) });
  }
  await sleep(300);
  await ready(page);
}
async function endClass() {
  if (classEnded || !teacher || !roomCode) return { skipped: true };
  try {
    if (await clickNamed(teacher, 'End class')) await sleep(800);
    let st = await teacherState().catch(() => null);
    if (st?.data?.status !== 'ENDED') {
      await teacher.evaluate(async (code) => {
        await fetch(`/api/rooms/${code}/end`, { method: 'POST', credentials: 'same-origin' });
      }, roomCode);
      st = await teacherState().catch(() => null);
    }
    classEnded = st?.data?.status === 'ENDED' || /dashboard/.test(teacher.url());
    return { status: st?.data?.status || null, href: teacher.url() };
  } catch (e) {
    return { error: String(e).slice(0, 200) };
  }
}

async function login() {
  if (!PASS) {
    note('login', 'fail', { error: 'CLASSROOM_TEACHER_PASSWORD is empty' });
    return false;
  }
  const meta = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    await teacher.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await teacher.locator('input[type="email"], input[name="email"]').first().fill(EMAIL);
    await teacher.locator('input[type="password"]').first().fill(PASS);
    const respP = teacher.waitForResponse((r) => r.url().includes('/api/auth/login'), { timeout: 30000 }).catch(() => null);
    await teacher.getByRole('button', { name: 'Sign in' }).click();
    const resp = await respP;
    let apiError = null;
    if (resp) {
      const body = await resp.json().catch(() => ({}));
      apiError = body.error || body.message || null;
    }
    await teacher.waitForURL(/\/teacher\/dashboard|\/account\/password/, { timeout: 30000 }).catch(() => {});
    const href = teacher.url();
    meta.push({ attempt, http: resp ? resp.status() : null, apiError, href });
    if (/\/account\/password/.test(href)) {
      note('login', 'fail', { blocked: 'mustChangePassword', meta, shots: { teacher: await shot(teacher, '01-login/teacher') } });
      return false;
    }
    if (/\/teacher\/dashboard/.test(href)) {
      note('login', 'pass', { href, meta, shots: { teacher: await shot(teacher, '01-login/teacher') } });
      return true;
    }
  }
  note('login', 'fail', { meta, shots: { teacher: await shot(teacher, '01-login/fail') } });
  return false;
}

async function startClass() {
  await teacher.locator('select').first().selectOption('9');
  await sleep(200);
  const hint = await teacher.locator('body').innerText();
  await teacher.locator('input[name="subject"]').fill('REV ux');
  const all = teacher.getByRole('checkbox', { name: /All divisions of grade/ });
  if (await all.count()) await all.check();
  const divisions = await teacher.evaluate(() =>
    [...document.querySelectorAll('fieldset label')].map((n) => n.textContent.replace(/\s+/g, ' ').trim()).slice(0, 12)
  );
  await teacher.getByRole('button', { name: 'Start ad-hoc class' }).click();
  await teacher.waitForURL(/\/classroom\//, { timeout: 30000 });
  roomCode = (teacher.url().match(/\/classroom\/([^/?#]+)/) || [])[1] || '';
  await sleep(800);
  const st = await teacherState();
  const session = st.data?.classSession || st.data?.session || null;
  note('start', roomCode ? 'pass' : 'fail', {
    roomCode,
    waitingRoomOn: st.data?.waitingRoomOn ?? null,
    maxVisibleVideos: st.data?.maxVisibleVideos ?? null,
    subject: session?.subject || null,
    audience: session?.audience || null,
    divisions,
    dashboardHint: /Max visible student videos[\s\S]{0,180}/.exec(hint)?.[0]?.replace(/\s+/g, ' ') || null,
    outsiderCount: (st.data?.admitted || []).filter((p) => p.role === 'STUDENT' && !REV.has(p.displayName)).length,
    cpu: sampleCpu('start'),
    shots: { teacher: await shot(teacher, '01-start/teacher') },
  });
  return !!roomCode;
}

async function joinOne(spec) {
  const page = students[spec.id].page;
  const t0 = Date.now();
  const url = `${BASE}/join?FirstName=${spec.id}&LastName=Rev&SID=TEST-REV-${spec.id}&Grade=9&Division=Alpha`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  let text = '';
  let href = page.url();
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    href = page.url();
    text = await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 400)).catch(() => '');
    if (/Waiting room|Connecting to classroom|Teacher is in the room|Class ended/.test(text) || /\/classroom\//.test(href)) break;
    await sleep(300);
  }
  return { id: spec.id, ms: Date.now() - t0, href, text };
}

async function waitInClass(id, timeout = 40000) {
  const page = students[id].page;
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (/\/classroom\//.test(page.url())) {
      await ready(page);
      return Date.now() - t0;
    }
    await sleep(400);
  }
  return null;
}

async function main() {
  if (!PASS) {
    note('login', 'fail', { error: 'CLASSROOM_TEACHER_PASSWORD is empty' });
    return;
  }
  ensureMedia();
  const probeBrowser = await chromium.launch({ channel: 'chrome', headless: true, args: chromeArgs() });
  const probeCtx = await probeBrowser.newContext();
  const probe = await probeCtx.newPage();
  await probe.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await probe.evaluate(() => {
    const b = document.createElement('button');
    b.id = 'e2e-fs';
    b.textContent = 'go';
    document.body.appendChild(b);
  });
  const pending = probe.evaluate(
    () =>
      new Promise((resolve) => {
        document.getElementById('e2e-fs').addEventListener('click', () => {
          const enabled = !!document.fullscreenEnabled;
          if (!enabled) return resolve({ enabled, entered: false });
          document.documentElement.requestFullscreen().then(
            () => resolve({ enabled, entered: !!document.fullscreenElement }),
            (e) => resolve({ enabled, entered: false, error: String(e).slice(0, 160) })
          );
        });
      })
  );
  await probe.click('#e2e-fs');
  const headlessProbe = await pending;
  await probeBrowser.close();
  launchMode = headlessProbe.entered ? 'headless-chrome-fullscreen-ok' : 'headless-chrome-fullscreen-unavailable';
  note('fullscreen-probe', headlessProbe.entered ? 'pass' : 'fail', { headlessProbe, launchMode });

  browser = await chromium.launch({ channel: 'chrome', headless: true, args: chromeArgs() });
  const teacherSpec = { ua: UA.windows, w: 1400, h: 860, mobile: false };
  const made = await newContext('teacher', teacherSpec);
  teacher = made.page;
  teacherCtx = made.ctx;
  if (!(await login())) return;
  if (!(await startClass())) return;

  for (const spec of ROSTER) {
    const ctx = await newContext(spec.id, spec);
    students[spec.id] = { ...spec, ...ctx, sid: `TEST-REV-${spec.id}` };
  }

  const first = ROSTER.filter((s) => !s.late);
  const joins = [];
  for (let i = 0; i < first.length; i += 3) {
    const batch = first.slice(i, i + 3);
    joins.push(...(await Promise.all(batch.map((s) => joinOne(s)))));
  }
  let st = await teacherState();
  for (let i = 0; i < 20; i++) {
    const n = (st.data?.waiting || []).filter((p) => REV.has(p.displayName)).length;
    if (n >= first.length) break;
    await sleep(400);
    st = await teacherState();
  }
  const waiting = people(st.data?.waiting);
  note('join-waiting', waiting.filter((p) => p.name !== '[non-rev]').length >= 4 ? 'pass' : 'fail', {
    joins,
    waitingRoomOn: st.data?.waitingRoomOn,
    waiting,
    outsiderWaiting: (st.data?.waiting || []).filter((p) => !REV.has(p.displayName)).length,
    shots: await shotFamilies('02-waiting'),
  });

  const waitingNames = (st.data?.waiting || []).filter((p) => p.role !== 'TEACHER');
  const outsidersWaiting = waitingNames.filter((p) => !REV.has(p.displayName));
  if (outsidersWaiting.length) {
    note('admit', 'fail', { error: 'non-REV students are waiting; Admit all skipped', count: outsidersWaiting.length });
  } else if (!waitingNames.length) {
    note('admit', 'fail', { error: 'waiting list empty' });
  } else {
    const firstName = waitingNames[0].displayName;
    const header = `Admit ${shortName(firstName)}`;
    let ui = 'header';
    if (!(await clickNamed(teacher, header))) {
      ui = 'roster';
      await openRoster();
      await clickNamed(teacher, `Admit ${firstName}`);
    }
    const reached = await waitInClass(firstName.split(' ')[0]);
    note('admit-one', reached != null ? 'pass' : 'fail', { admitted: firstName, button: header, ui, reachedMs: reached });
    st = await teacherState();
    const rest = (st.data?.waiting || []).filter((p) => !REV.has(p.displayName));
    if (rest.length) {
      note('admit-all', 'fail', { error: 'non-REV still waiting; Admit all skipped' });
    } else {
      const before = (st.data?.waiting || []).map((p) => (REV.has(p.displayName) ? p.displayName : '[non-rev]'));
      if (!(await clickRe(teacher, /^Admit all/))) {
        await openRoster();
        await clickRe(teacher, /Admit all/);
      }
      await sleep(1500);
      const times = {};
      for (const spec of first) times[spec.id] = await waitInClass(spec.id, 35000);
      st = await teacherState();
      const allIn = first.every((spec) => times[spec.id] != null);
      note('admit-all', allIn ? 'pass' : 'fail', {
        before,
        admitted: people(st.data?.admitted).filter((p) => p.role === 'STUDENT' || p.name),
        waiting: people(st.data?.waiting),
        muted: people(st.data?.admitted).filter((p) => p.name !== '[non-rev]').map((p) => ({ name: p.name, mutedByTeacher: p.mutedByTeacher })),
        times,
        shots: await shotFamilies('02-admitted'),
      });
    }
  }

  // —— A. Chat ——
  try {
    const empty = {};
    for (const id of ['teacher', ...FAMILIES]) {
      const page = id === 'teacher' ? teacher : students[id].page;
      await openChat(page);
      empty[id] = await chatSnap(page);
    }
    const emptyShots = await shotFamilies('03-chat-empty');
    for (const id of ['teacher', ...FAMILIES]) {
      const page = id === 'teacher' ? teacher : students[id].page;
      await closeChat(page);
    }
    const unreadSend = await sendChat(teacher, 'Unread ping REV-U');
    await sleep(1200);
    const unreadBadge = {};
    for (const id of FAMILIES) unreadBadge[id] = await badgeText(students[id].page, 'Open chat');
    await openChat(students.WD1.page);
    const unreadAfterOpen = await badgeText(students.WD1.page, 'Close chat');
    const wd1After = await chatSnap(students.WD1.page);
    await closeChat(teacher);

    const deliveries = [];
    async function broadcast(fromPage, body, toLabel, watchers) {
      const sent = await sendChat(fromPage, body, toLabel);
      const seen = {};
      await Promise.all(
        watchers.map(async (id) => {
          const page = id === 'teacher' ? teacher : students[id].page;
          const hit = await waitBody(page, body, 10000);
          let visible = false;
          if (hit.ms != null) {
            visible = await page.evaluate((body) => (document.body?.innerText || '').includes(body), body).catch(() => false);
          }
          seen[id] = { ...hit, visible };
        })
      );
      deliveries.push({ body, toLabel: toLabel || null, sent, seen });
    }
    await broadcast(teacher, 'Hello class REV-1', null, ['teacher', 'WD1', 'AP1', 'AT1', 'IP1', 'ID1']);
    await broadcast(teacher, 'Private note REV-2', 'WD1 Rev', ['teacher', 'WD1', 'WD2', 'AP1', 'IP1']);
    const afterDm = await teacher.evaluate(() => {
      const select = document.querySelector('select');
      return select ? select.selectedOptions[0]?.textContent?.trim() : null;
    });
    await broadcast(teacher, 'Second DM REV-3', 'IP1 Rev', ['teacher', 'IP1', 'WD1', 'AP1']);
    const afterDm2 = await teacher.evaluate(() => document.querySelector('select')?.selectedOptions?.[0]?.textContent?.trim() || null);
    await broadcast(students.WD1.page, 'WD1 reply REV-4', null, ['teacher', 'WD1', 'AP1', 'IP1']);
    await closeChat(teacher);
    const teacherBadgeBefore = await badgeText(teacher, 'Open roster');
    const teacherChatBadge = await badgeText(teacher, 'Open chat');
    await broadcast(students.AP1.page, 'AP1 reply REV-5', null, ['teacher', 'AP1', 'WD1']);
    let teacherChatBadgeAfter = null;
    for (let i = 0; i < 8; i++) {
      teacherChatBadgeAfter = await badgeText(teacher, 'Open chat');
      if (teacherChatBadgeAfter && /\d/.test(teacherChatBadgeAfter.text || '')) break;
      await sleep(400);
    }
    await broadcast(students.AT1.page, 'AT1 reply REV-6', null, ['teacher', 'AT1', 'WD1']);
    await broadcast(students.IP1.page, 'IP1 reply REV-7', null, ['teacher', 'IP1', 'AP1']);
    await broadcast(students.ID1.page, 'ID1 reply REV-8', null, ['teacher', 'ID1', 'WD1']);

    const replyOne = await sendChat(teacher, 'Reply to WD1 REV-9', 'WD1 Rev');
    const replyAll = await sendChat(teacher, 'Reply to everyone REV-10', 'Everyone');
    const finalSnap = {};
    for (const id of ['teacher', ...FAMILIES]) {
      const page = id === 'teacher' ? teacher : students[id].page;
      await openChat(page);
      finalSnap[id] = await chatSnap(page);
    }
    const views = {};
    for (const id of ['teacher', 'WD1', 'WD2', 'AP1', 'AT1', 'IP1', 'ID1']) {
      const page = id === 'teacher' ? teacher : students[id].page;
      views[id] = await page.evaluate(async (code) => {
        const r = await fetch(`/api/rooms/${code}/messages`, { credentials: 'same-origin' });
        const data = await r.json();
        return (data.messages || [])
          .filter((m) => /REV-/.test(m.body))
          .map((m) => ({ body: m.body, scope: m.scope, sender: m.senderName, recipient: m.recipientName }));
      }, roomCode);
    }
    note('chat', 'pass', {
      empty,
      emptyShots,
      unreadSend,
      unreadBadge,
      unreadAfterOpen,
      wd1AfterText: wd1After.text,
      afterDmSelect: afterDm,
      afterDm2Select: afterDm2,
      deliveries,
      teacherBadgeBefore,
      teacherChatBadge,
      teacherChatBadgeAfter,
      replyOne,
      replyAll,
      finalSnap,
      views,
      shots: await shotFamilies('03-chat'),
    });
  } catch (e) {
    note('chat', 'fail', { error: String(e).slice(0, 500), shots: await shotFamilies('03-chat-fail') });
  }

  // —— D. Hands (before share, while chat can close) ——
  try {
    for (const id of ['teacher', ...FAMILIES]) await closeChat(id === 'teacher' ? teacher : students[id].page);
    const order = ['WD1', 'AP1', 'AT1', 'IP1', 'ID1'];
    const raises = [];
    for (const id of order) {
      await ready(students[id].page);
      const t0 = Date.now();
      const clicked = await clickNamed(students[id].page, 'Raise hand');
      let seen = null;
      for (let i = 0; i < 20; i++) {
        const cur = await teacherState();
        const row = (cur.data?.admitted || []).find((p) => p.displayName === `${id} Rev`);
        if (row?.handRaised) {
          seen = Date.now() - t0;
          break;
        }
        await sleep(200);
      }
      await openRoster();
      const names = await teacher.evaluate(() =>
        [...document.querySelectorAll('.roster-row')].map((li) => ({
          name: li.querySelector('.roster-name')?.textContent?.trim() || '',
          hand: !!li.querySelector('[aria-label="Hand raised"]'),
          text: li.innerText.replace(/\s+/g, ' ').trim().slice(0, 160),
        }))
      );
      raises.push({ id, clicked, ms: seen, roster: names.filter((n) => REV.has(n.name) || n.name === '') });
      await sleep(700);
    }
    await openRoster();
    await sleep(300);
    const rosterShot = await shot(teacher, '04-hands/teacher-roster');
    await closeChat(teacher);
    await openChat(teacher);
    const duringChat = {
      handLabels: await teacher.evaluate(() => document.querySelectorAll('[aria-label="Hand raised"]').length),
      rosterOpen: await teacher.getByRole('button', { name: 'Close roster', exact: true }).count(),
      chatText: (await chatSnap(teacher)).text?.slice(0, 400),
      rosterBadge: await badgeText(teacher, 'Open roster'),
    };
    const duringChatShot = await shot(teacher, '04-hands/teacher-chat-open');
    await closeChat(teacher);
    await openRoster();
    const tLower = Date.now();
    const lowered = await clickNamed(teacher, "Lower WD1 Rev's hand");
    let lowerMs = null;
    for (let i = 0; i < 20; i++) {
      const cur = await teacherState();
      const row = (cur.data?.admitted || []).find((p) => p.displayName === 'WD1 Rev');
      if (row && !row.handRaised) {
        lowerMs = Date.now() - tLower;
        break;
      }
      await sleep(200);
    }
    const notice = await teacher.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 400));
    note('hands', raises.every((r) => r.ms != null) ? 'pass' : 'fail', {
      raises,
      rosterShot,
      duringChat,
      duringChatShot,
      lowered,
      lowerMs,
      notice: /hand/i.test(notice) ? notice : null,
      shots: await shotFamilies('04-hands'),
    });
  } catch (e) {
    note('hands', 'fail', { error: String(e).slice(0, 400), shots: await shotFamilies('04-hands-fail') });
  }

  // —— Late join ——
  try {
    let stNow = await teacherState();
    const waitingNow = stNow.data?.waiting || [];
    if (waitingNow.some((p) => !REV.has(p.displayName))) {
      note('direct-entry', 'fail', { error: 'non-REV students waiting; waiting room left on' });
    } else {
      await openRoster();
      const beforeLabel = await teacher.evaluate(() => {
        const sw = document.querySelector('[role="switch"]');
        return sw ? { aria: sw.getAttribute('aria-label'), text: sw.textContent.replace(/\s+/g, ' ').trim() } : null;
      });
      if (stNow.data?.waitingRoomOn !== false) {
        const sw = teacher.getByRole('switch');
        if (await sw.count()) await sw.first().click();
        await sleep(700);
      }
      stNow = await teacherState();
      const off = { waitingRoomOn: stNow.data?.waitingRoomOn, beforeLabel };
      const lateJoin = await joinOne(ROSTER.find((s) => s.id === 'ID2'));
      let admitted = false;
      let muted = null;
      for (let i = 0; i < 30; i++) {
        const cur = await teacherState();
        const row = (cur.data?.admitted || []).find((p) => p.displayName === 'ID2 Rev');
        const still = (cur.data?.waiting || []).some((p) => p.displayName === 'ID2 Rev');
        if (row && !still) {
          admitted = true;
          muted = row.mutedByTeacher;
          break;
        }
        await sleep(400);
      }
      const reached = await waitInClass('ID2', 20000);
      const lateText = await students.ID2.page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 300));
      stNow = await teacherState();
      if (stNow.data?.waitingRoomOn === false && !(stNow.data?.waiting || []).some((p) => !REV.has(p.displayName))) {
        await openRoster();
        const sw = teacher.getByRole('switch');
        if (await sw.count()) await sw.first().click();
        await sleep(500);
      }
      const restored = await teacherState();
      note('direct-entry', admitted ? 'pass' : 'fail', {
        off,
        lateJoin,
        admitted,
        mutedByTeacher: muted,
        reachedMs: reached,
        lateText,
        waitingRoomRestored: restored.data?.waitingRoomOn,
        deviation: 'Waiting room turned back on after ID2 entered so a real student would not walk in.',
        shots: await shotAll('05-direct'),
      });
    }
  } catch (e) {
    note('direct-entry', 'fail', { error: String(e).slice(0, 400) });
  }

  // —— Mute labels, then leave WD1 audible for speaker rotation ——
  try {
    const stNow = await teacherState();
    const outsiders = (stNow.data?.admitted || []).filter((p) => p.role === 'STUDENT' && !REV.has(p.displayName));
    const before = {};
    for (const id of FAMILIES) before[id] = await micInfo(students[id].page);
    if (await clickNamed(teacher, 'Mute microphone')) await sleep(200);
    let unlockMs = null;
    if (!outsiders.length) {
      await openRoster();
      const t0 = Date.now();
      await clickNamed(teacher, 'Unmute WD1 Rev');
      for (let i = 0; i < 20; i++) {
        const cur = await teacherState();
        const row = (cur.data?.admitted || []).find((p) => p.displayName === 'WD1 Rev');
        if (row && row.mutedByTeacher === false) {
          unlockMs = Date.now() - t0;
          break;
        }
        await sleep(200);
      }
    }
    await sleep(500);
    const wd1AfterUnlock = await micInfo(students.WD1.page);
    let allow = null;
    if (!outsiders.length) {
      await clickNamed(teacher, 'Unmute all');
      await sleep(800);
      allow = {};
      for (const id of FAMILIES) allow[id] = await micInfo(students[id].page);
      await ready(students.WD1.page);
      await clickNamed(students.WD1.page, 'Unmute microphone');
      await sleep(1000);
    }
    const wd1Local = await micInfo(students.WD1.page);
    note('mute-labels', 'pass', {
      outsiders: outsiders.length,
      before,
      unlockMs,
      wd1AfterUnlock,
      allow,
      wd1Local,
      shots: await shotFamilies('06-mute'),
    });
  } catch (e) {
    note('mute-labels', 'fail', { error: String(e).slice(0, 400) });
  }

  // —— C. Video panel ——
  try {
    if (await clickNamed(teacher, 'Turn camera on')) await sleep(500);
    const teacherCam = await teacher.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((el) => /camera/i.test(el.getAttribute('aria-label') || ''));
      return b ? b.getAttribute('aria-label') : null;
    });
    const layouts = {};
    for (const n of [2, 4, 6]) {
      await clickNamed(teacher, `Show ${n} videos`);
      await sleep(700);
      const cur = await teacherState();
      const visible = people(cur.data?.admitted).filter((p) => p.isVisible).map((p) => p.name);
      layouts[n] = {
        maxVisibleVideos: cur.data?.maxVisibleVideos,
        visible,
        header: await teacher.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 280)),
        shot: await shot(teacher, `07-layout/show-${n}`),
      };
    }
    await clickNamed(teacher, 'Show 6 videos');
    await sleep(400);
    const rotation = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 40000) {
      const cur = await teacherState();
      rotation.push({
        t: new Date().toISOString(),
        elapsedMs: Date.now() - t0,
        maxVisibleVideos: cur.data?.maxVisibleVideos,
        visible: people(cur.data?.admitted).filter((p) => p.isVisible).map((p) => p.name),
      });
      await sleep(4000);
    }
    const distinct = [...new Set(rotation.flatMap((r) => r.visible))];
    const privacy = {};
    for (const id of FAMILIES) {
      const rows = await sampleStats(students[id].page).catch(() => []);
      privacy[id] = {
        inboundVideo: rows.filter((r) => r.type === 'inbound-rtp' && r.kind === 'video' && r.w),
        videoAria: await students[id].page.evaluate(() =>
          [...document.querySelectorAll('video')].map((v) => v.getAttribute('aria-label') || v.closest('[aria-label]')?.getAttribute('aria-label') || '')
        ),
      };
    }
    note('video', 'pass', {
      teacherCam,
      layouts,
      rotation,
      distinctOver40s: distinct,
      privacy,
      cpu: sampleCpu('video'),
      shots: await shotFamilies('07-video'),
    });
  } catch (e) {
    note('video', 'fail', { error: String(e).slice(0, 400) });
  }

  // —— Pin ——
  try {
    await clickNamed(teacher, 'Show 4 videos');
    await sleep(400);
    await openRoster();
    const rosterClicked = await clickNamed(teacher, "Pin WD1 Rev's video");
    await sleep(500);
    const pinButtons = await teacher.evaluate(() =>
      [...document.querySelectorAll('button')]
        .map((b) => b.getAttribute('aria-label') || '')
        .filter((n) => /pin/i.test(n))
    );
    const tile = pinButtons.find((n) => /keep in the panel/i.test(n) && !n.includes('WD1'));
    let tileClicked = null;
    if (tile) {
      tileClicked = tile;
      await clickNamed(teacher, tile);
      await sleep(400);
    } else {
      const anyTile = teacher.locator('button[aria-label*="keep in the panel"]');
      if (await anyTile.count()) {
        tileClicked = await anyTile.first().getAttribute('aria-label');
        await anyTile.first().click({ force: true });
      }
    }
    const stay = [];
    for (let i = 0; i < 3; i++) {
      await sleep(8000);
      const cur = await teacherState();
      stay.push({
        t: new Date().toISOString(),
        visible: people(cur.data?.admitted).filter((p) => p.isVisible).map((p) => p.name),
        pinned: people(cur.data?.admitted).filter((p) => p.pinned).map((p) => p.name),
      });
    }
    await openRoster();
    for (const name of stay[stay.length - 1]?.pinned || []) {
      await clickNamed(teacher, `Unpin ${name}'s video`);
      await sleep(200);
    }
    await clickNamed(teacher, 'Show 2 videos');
    await sleep(400);
    await openRoster();
    await clickNamed(teacher, "Pin WD1 Rev's video");
    await sleep(400);
    const pinLog = [];
    teacher.on('response', (res) => {
      if (res.url().includes('/pin-student')) {
        res.text().then((body) => pinLog.push({ status: res.status(), body: body.slice(0, 240) })).catch(() => {});
      }
    });
    await clickNamed(teacher, "Pin AP1 Rev's video");
    await sleep(1000);
    const after = await teacherState();
    const notice = await teacher.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 360));
    note('pin', rosterClicked ? 'pass' : 'fail', {
      rosterClicked,
      pinButtons,
      tileClicked,
      stay,
      overflow: {
        maxVisibleVideos: after.data?.maxVisibleVideos,
        pinned: people(after.data?.admitted).filter((p) => p.pinned).map((p) => p.name),
        responses: pinLog,
        notice: /pin/i.test(notice) ? notice : null,
      },
      shots: { teacher: await shot(teacher, '08-pin/teacher'), ...(await shotFamilies('08-pin')) },
    });
  } catch (e) {
    note('pin', 'fail', { error: String(e).slice(0, 400), shots: await shotFamilies('08-pin-fail') });
  }

  // Mute all now that speaker observation is done.
  try {
    const stNow = await teacherState();
    const outsiders = (stNow.data?.admitted || []).filter((p) => p.role === 'STUDENT' && !REV.has(p.displayName));
    if (!outsiders.length) {
      const t0 = Date.now();
      await clickNamed(teacher, 'Mute all');
      await sleep(1000);
      const after = {};
      for (const id of FAMILIES) after[id] = await micInfo(students[id].page);
      const cur = await teacherState();
      note('mute-all', 'pass', {
        ms: Date.now() - t0,
        after,
        locks: people(cur.data?.admitted).filter((p) => REV.has(p.name) || p.name).map((p) => ({ name: p.name, mutedByTeacher: p.mutedByTeacher })),
      });
    } else {
      note('mute-all', 'fail', { error: 'skipped because a non-REV student is admitted' });
    }
  } catch (e) {
    note('mute-all', 'fail', { error: String(e).slice(0, 300) });
  }

  // Float before share.
  try {
    const floats = {};
    for (const id of FAMILIES) {
      await ready(students[id].page);
      const info = await floatInfo(students[id].page);
      const drag = await dragFloat(students[id].page);
      let minimized = null;
      const minBtn = students[id].page.locator('.student-media-float button', { hasText: 'Minimize' });
      if (await minBtn.count()) {
        await minBtn.first().click();
        await sleep(200);
        minimized = await floatInfo(students[id].page);
        const show = students[id].page.locator('.student-media-float button', { hasText: 'Show videos' });
        if (await show.count()) await show.first().click();
      }
      floats[id] = { info, drag, minimized };
    }
    note('float-before-share', 'pass', { floats, shots: await shotFamilies('09-float-before') });
  } catch (e) {
    note('float-before-share', 'fail', { error: String(e).slice(0, 400) });
  }

  // —— B. Share, coverage, annotate, chat during share ——
  try {
    const clip = await teacherCtx.newPage();
    await clip.setContent('<!doctype html><title>REV clip</title><p id="label">REV-CLIP playing</p><canvas id="c" width="320" height="180"></canvas>');
    await clip.evaluate(() => {
      const c = document.getElementById('c');
      const g = c.getContext('2d');
      g.fillStyle = '#ff00ff';
      g.fillRect(0, 0, 320, 180);
      const ctx = new AudioContext();
      const o = ctx.createOscillator();
      o.frequency.value = 440;
      o.connect(ctx.destination);
      o.start();
    }).catch(() => {});
    await shot(clip, '10-share/clip-tab');
    await teacher.bringToFront();
    for (const id of Object.keys(students)) await closeChat(students[id].page);
    const tShare = Date.now();
    await clickNamed(teacher, 'Share screen');
    await sleep(2500);
    const capture = await teacher.evaluate(() => ({
      constraints: window.__e2eDisplayConstraints || null,
      tracks: window.__e2eDisplayTracks || null,
    }));
    await clickRe(teacher, /^Expand share controls/);
    await sleep(400);
    const annotateBtn = await teacher.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((el) => (el.textContent || '').trim() === 'Annotate');
      if (!b) return null;
      return { disabled: b.disabled, title: b.getAttribute('title'), text: b.textContent.trim() };
    });
    const teacherShareText = await teacher.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 700));
    const stats = {};
    for (const id of FAMILIES) stats[id] = summarizeShare(await sampleStats(students[id].page).catch(() => []));
    note('share', 'pass', {
      clickToCaptureMs: Date.now() - tShare,
      capture,
      annotateBtn,
      teacherShareText,
      stats,
      cpu: sampleCpu('share'),
      shots: await shotAll('10-share'),
    });

    const coverage = {};
    for (const id of FAMILIES) {
      const spec = ROSTER.find((s) => s.id === id);
      coverage[id] = {};
      const modes = spec.family === 'windows-desktop' ? ['primary'] : ['portrait', 'landscape'];
      for (const mode of modes) {
        console.log(`PROGRESS coverage ${id} ${mode}`);
        await orient(id, mode);
        await closeChat(students[id].page);
        const closed = { frame: await measureFrame(students[id].page), overlay: await measureOverlay(students[id].page), float: await floatInfo(students[id].page) };
        await openChat(students[id].page);
        const opened = { overlay: await measureOverlay(students[id].page), chat: await chatSnap(students[id].page) };
        const shotPath = await shot(students[id].page, `11-coverage/${id}-${mode}`);
        await closeChat(students[id].page);
        coverage[id][mode] = { closed, opened, shot: shotPath };
      }
      await orient(id, 'primary');
    }
    const duringFloats = {};
    for (const id of FAMILIES) {
      const drag = await dragFloat(students[id].page);
      duringFloats[id] = { float: await floatInfo(students[id].page), drag };
    }
    note('coverage', 'pass', {
      coverage,
      duringFloats,
      howToRead: 'blackPct/greenPct are of the largest decoded video. overlayPct is the union of the student float, chrome, controls, chat panel, and fullscreen cover. closed = chat shut; opened = chat open.',
      shots: await shotFamilies('11-share-stage'),
    });

    // Chat during share, one per family, already opened above and closed. Reopen and snapshot strings.
    const duringShareChat = {};
    for (const id of FAMILIES) {
      await orient(id, 'primary');
      await openChat(students[id].page);
      duringShareChat[id] = await chatSnap(students[id].page);
    }
    await openChat(teacher);
    duringShareChat.teacher = await chatSnap(teacher);
    const studentAnnotate = {};
    for (const id of FAMILIES) {
      studentAnnotate[id] = await students[id].page.evaluate(() =>
        [...document.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') || b.textContent.trim()).filter((t) => /annot|draw|pen|eraser/i.test(t))
      );
    }
    note('chat-during-share', 'pass', {
      duringShareChat,
      studentAnnotate,
      shots: await shotFamilies('12-chat-during-share'),
    });

    // Annotate if the live button allows it.
    let drew = false;
    const strokeTimes = {};
    if (annotateBtn && !annotateBtn.disabled) {
      await clickNamed(teacher, 'Annotate');
      await sleep(1200);
      const surface = teacher.locator('svg[viewBox="0 0 100 100"]').last();
      const box = (await surface.count()) ? await surface.boundingBox() : null;
      if (box && box.width > 40) {
        const tDraw = Date.now();
        const x = box.x;
        const y = box.y;
        const w = box.width;
        const h = box.height;
        await teacher.mouse.move(x + w * 0.15, y + h * 0.15);
        await teacher.mouse.down();
        await teacher.mouse.move(x + w * 0.85, y + h * 0.85, { steps: 8 });
        await teacher.mouse.up();
        await teacher.mouse.move(x + w * 0.85, y + h * 0.15);
        await teacher.mouse.down();
        await teacher.mouse.move(x + w * 0.15, y + h * 0.85, { steps: 8 });
        await teacher.mouse.up();
        await teacher.mouse.move(x + w * 0.5, y + h * 0.28);
        await teacher.mouse.down();
        await teacher.mouse.move(x + w * 0.72, y + h * 0.4, { steps: 4 });
        await teacher.mouse.move(x + w * 0.5, y + h * 0.72, { steps: 4 });
        await teacher.mouse.move(x + w * 0.28, y + h * 0.4, { steps: 4 });
        await teacher.mouse.move(x + w * 0.5, y + h * 0.28, { steps: 4 });
        await teacher.mouse.up();
        drew = true;
        for (const id of FAMILIES) {
          const t0 = Date.now();
          let count = 0;
          for (let i = 0; i < 24; i++) {
            count = await students[id].page.evaluate(() => document.querySelectorAll('svg[viewBox="0 0 100 100"] path').length).catch(() => 0);
            if (count > 0) break;
            await sleep(250);
          }
          const sample = await students[id].page.evaluate(() =>
            [...document.querySelectorAll('svg[viewBox="0 0 100 100"] path')].slice(0, 4).map((p) => p.getAttribute('d'))
          );
          strokeTimes[id] = { ms: count > 0 ? Date.now() - t0 : null, count, sample, sinceDrawMs: Date.now() - tDraw };
        }
      }
    }
    const teacherStrokes = await teacher.evaluate(() => ({
      count: document.querySelectorAll('svg[viewBox="0 0 100 100"] path').length,
      annotateTitle: [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Annotate')?.getAttribute('title') || null,
    }));
    note(drew ? 'annotate' : 'annotate', drew ? 'pass' : 'fail', {
      annotateBtn,
      drew,
      teacherStrokes,
      strokeTimes,
      studentAnnotate,
      reason: drew ? null : 'Annotate could not be drawn through the live UI.',
      shots: await shotAll('13-annotate'),
    });
  } catch (e) {
    note('share', 'fail', { error: String(e).slice(0, 500), shots: await shotFamilies('10-share-fail') });
  }

  // Hand visible during share.
  try {
    await ready(students.AP2.page);
    const clicked = await clickNamed(students.AP2.page, 'Raise hand');
    await sleep(1000);
    await clickRe(teacher, /^Expand share controls/);
    const raisedBtn = teacher.getByRole('button', { name: 'Raised hands', exact: true });
    if (await raisedBtn.count()) await raisedBtn.first().click();
    await sleep(400);
    const hud = await teacher.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 500));
    note('hand-during-share', clicked ? 'pass' : 'fail', {
      clicked,
      hud: /hand|AP2/i.test(hud) ? hud : hud,
      shot: await shot(teacher, '14-hand-share/teacher'),
    });
  } catch (e) {
    note('hand-during-share', 'fail', { error: String(e).slice(0, 300) });
  }

  // End.
  try {
    const endInfo = await endClass();
    await sleep(800);
    const endedViews = {};
    for (const id of Object.keys(students)) {
      const page = students[id].page;
      endedViews[id] = {
        href: page.url(),
        text: await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 240)).catch(() => ''),
      };
    }
    const homes = {};
    for (const id of Object.keys(students)) {
      const page = students[id].page;
      const home = page.getByRole('button', { name: 'Home', exact: true });
      if (await home.count()) {
        await home.first().click();
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
        await sleep(400);
      }
      homes[id] = {
        href: page.url(),
        text: await page.evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 180)).catch(() => ''),
      };
    }
    note('end', endInfo.status === 'ENDED' || /dashboard/.test(teacher.url()) ? 'pass' : 'fail', {
      endInfo,
      endedViews,
      homes,
      teacherHref: teacher.url(),
      cpu: sampleCpu('end'),
      shots: await shotAll('15-ended'),
    });
    if (homes.WD1) await shot(students.WD1.page, '15-ended/WD1-home');
  } catch (e) {
    note('end', 'fail', { error: String(e).slice(0, 400) });
  }
}

async function cleanup() {
  try {
    const endInfo = await endClass();
    let adminProbe = null;
    if (teacher) {
      adminProbe = await teacher.evaluate(async () => {
        const r = await fetch('/api/admin/students', { credentials: 'same-origin' });
        const data = await r.json().catch(() => ({}));
        return { http: r.status, isArray: Array.isArray(data), keys: data && typeof data === 'object' ? Object.keys(data).slice(0, 6) : [] };
      });
    }
    note('cleanup', 'pass', {
      classEnded,
      endInfo,
      deleted: false,
      reason: 'Teacher session cannot delete students. TEST-REV rows are left for manual cleanup.',
      sids: ROSTER.map((s) => `TEST-REV-${s.id}`),
      names: ROSTER.map((s) => `${s.id} Rev`),
      grade: '9',
      division: 'Alpha',
      roomCode,
      subject: 'REV ux',
      adminProbe,
    });
  } catch (e) {
    note('cleanup', 'fail', { error: String(e).slice(0, 300) });
  }
  if (browser) await browser.close().catch(() => {});
}

main()
  .catch((e) => {
    note('run', 'fail', { error: String(e).slice(0, 500) });
  })
  .finally(async () => {
    await cleanup();
    console.log(classEnded ? 'SIM_DONE' : 'SIM_FAIL');
    process.exit(classEnded ? 0 : 1);
  });
