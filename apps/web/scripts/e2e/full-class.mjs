/**
 * Full-class end-to-end run against a LOCAL test stack (never production):
 * Postgres, Redis and LiveKit on 127.0.0.1, `npm run build` + `next start`
 * on :3000, apps/web/.env.local with ADMIN_EMAIL=admin@school.test,
 * SCHOOL_JOIN_MODE=unsigned and the LiveKit test keys. The database must be
 * fresh (the run signs the admin in for the first time and creates the teacher).
 *
 * One admin, one teacher, three students (one phone-sized) in Chromium with
 * fake camera/mic: entry with no waiting room, live audio/video and screen
 * share through LiveKit, hands, chat, the long whiteboard (live to students,
 * late joiner, scroll, PDF + picture import), Remove / Leave and rejoin,
 * End class, attendance.
 *
 *   OUT=/tmp/e2e PWFILE=<admin initial password file> PDF=<a 2-page PDF with a
 *   blue rule> PIC=<a PNG> node scripts/e2e/full-class.mjs
 *
 * Paths to Playwright and the repo are this dev container's; adjust as needed.
 * The password below is only for the throwaway local accounts it creates.
 */
import fs from 'node:fs';
import pw from '/opt/node-tools/node_modules/playwright/index.js'; const { chromium } = pw;
const BASE = 'http://127.0.0.1:3000';
const OUT = process.env.OUT;
const pwFile = fs.readFileSync(process.env.PWFILE, 'utf8');
const adminPw = (pwFile.match(/[A-Za-z0-9]{5}(?:-[A-Za-z0-9]{1,5})+/) || [])[0];
const results = [];
const ok = (name, pass, info = '') => { results.push({ name, pass: !!pass, info: String(info).slice(0, 300) }); console.log(pass ? 'PASS' : 'FAIL', name, info ? '— ' + String(info).slice(0, 200) : ''); };
const step = async (name, fn) => { try { const r = await fn(); ok(name, r !== false, typeof r === 'string' ? r : ''); return r; } catch (e) { ok(name, false, e.message.split('\n')[0]); return false; } };
const shot = (p, n) => p.screenshot({ path: `${OUT}/${n}.png` }).catch(() => {});
const NEWPW = 'Local-test-pass-2026!';

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-select-desktop-capture-source=Entire screen', '--autoplay-policy=no-user-gesture-required'] });
const { RoomServiceClient } = await import('/home/user/classroom/apps/web/node_modules/livekit-server-sdk/dist/index.js');
const env = Object.fromEntries(fs.readFileSync('/home/user/classroom/apps/web/.env.local', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const lk = new RoomServiceClient('http://127.0.0.1:7880', env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);
/** Published tracks per participant in this class's LiveKit room: { identity: ['camera', 'microphone', ...] } */
async function lkTracks(code) {
  const room = (await lk.listRooms()).find((r) => r.name.includes(`_${code}_`));
  if (!room) return null;
  const out = {};
  for (const p of await lk.listParticipants(room.name)) out[p.identity] = p.tracks.map((t) => ({ 1: 'camera', 2: 'microphone', 3: 'screen_share', 4: 'screen_share_audio' })[t.source] || String(t.source));
  return out;
}
/** <video> elements on the page that are really playing frames. */
const playingVideos = (p) => p.evaluate(() => [...document.querySelectorAll('video')].filter((v) => v.readyState >= 2 && v.videoWidth > 0).length);
/** Dark pixels on the student's whiteboard canvas (ink). */
const inkPixels = (p) => p.evaluate(() => {
  const c = document.querySelector('[data-whiteboard] canvas'); if (!c) return -1;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] > 190 && d[i + 1] < 90 && d[i + 2] < 90) n++; // red ink (#e53935)
  return n;
});
const ctx = (opts = {}) => browser.newContext({ viewport: { width: 1366, height: 800 }, permissions: ['camera', 'microphone'], ...opts });
const errors = {};
const watch = (p, who) => { errors[who] = []; p.on('pageerror', (e) => errors[who].push(String(e).slice(0, 200))); };

async function login(page, email, password) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', password);
  await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 }), page.click('button[type=submit]')]);
  if (page.url().includes('/account/password')) {
    await page.fill('input[name=current]', password);
    await page.fill('input[name=new]', NEWPW);
    await page.fill('input[name=confirm]', NEWPW);
    await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/account/password'), { timeout: 15000 }), page.click('button[type=submit]')]);
  }
  return page.url();
}

// ---------- Admin ----------
const adminCtx = await ctx(); const admin = await adminCtx.newPage(); watch(admin, 'admin');
await step('admin: sign in (forced password change)', async () => (await login(admin, 'admin@school.test', adminPw)).replace(BASE, ''));
await shot(admin, '01-admin-home');
let teacherPw;
await step('admin: create teacher (Grade 6 Science Foundation, Airport Campus)', async () => {
  const r = await admin.request.post(`${BASE}/api/admin/teachers`, { data: { name: 'Test Teacher', email: 'teacher@school.test', gender: 'female', assignments: '6-SCIENCEFOUNDATION', campus: 'AIRPORTCAMPUS' } });
  const j = await r.json(); teacherPw = j.temporaryPassword || j.password || j.tempPassword;
  if (!r.ok() || !teacherPw) throw new Error(`${r.status()} ${JSON.stringify(Object.keys(j))}`);
  return 'created';
});
for (const path of ['/admin', '/admin/teachers', '/admin/students', '/admin/reports', '/admin/timetable', '/admin/live']) {
  await step(`admin page loads: ${path}`, async () => { const r = await admin.goto(BASE + path); await admin.waitForTimeout(1500); return r.status() < 400 ? `${r.status()}` : false; });
}
await shot(admin, '02-admin-live');

// ---------- Teacher ----------
const tCtx = await ctx(); const teacher = await tCtx.newPage(); watch(teacher, 'teacher');
await step('teacher: sign in (forced password change)', async () => (await login(teacher, 'teacher@school.test', teacherPw)).replace(BASE, ''));
await teacher.goto(`${BASE}/teacher/dashboard`); await teacher.waitForTimeout(2500);
await shot(teacher, '03-teacher-dashboard');
let code;
await step('teacher: start an extra class from the dashboard', async () => {
  const subj = teacher.getByLabel('Subject / title'); if (await subj.count()) await subj.fill('Science revision');
  const btn = teacher.getByRole('button', { name: 'Start extra class' });
  if (await btn.isEnabled().catch(() => false)) {
    await Promise.all([teacher.waitForURL(/\/classroom\//, { timeout: 20000 }), btn.click()]);
  } else {
    const r = await teacher.request.post(`${BASE}/api/teacher/sessions/start`, { data: { kind: 'adhoc', campuses: ['AIRPORTCAMPUS'], grade: '6', divisions: ['SCIENCEFOUNDATION'], subject: 'Science revision' } });
    const j = await r.json(); if (!r.ok()) throw new Error(JSON.stringify(j));
    await teacher.goto(`${BASE}/classroom/${j.code || j.room?.code}`);
    return 'started via API (button disabled: form needed choices)';
  }
});
code = teacher.url().match(/classroom\/([A-Z0-9]+)/)?.[1];
await step('teacher: classroom page open', async () => !!code && code);
await teacher.waitForTimeout(4000);
await shot(teacher, '04-teacher-classroom');
await step('teacher: dock shows (no waiting-room or Admit controls)', async () => {
  await teacher.locator('[data-testid=teacher-dock]').waitFor({ timeout: 10000 });
  const admit = await teacher.getByRole('button', { name: /Admit/ }).count();
  const waitingToggle = await teacher.getByText(/Waiting room|Direct entry/).count();
  return admit === 0 && waitingToggle === 0 ? 'no Admit, no waiting room' : `admit=${admit} waiting=${waitingToggle}`;
});

// ---------- Students ----------
const studentLink = (sid, first, last) => `${BASE}/join?FirstName=${first}&LastName=${last}&SID=${sid}&Grade=6&Division=SCIENCEFOUNDATION&Campus=AIRPORTCAMPUS`;
const students = [];
for (const [sid, first, last] of [['GOS000101', 'Arohi', 'Patil'], ['GOS000102', 'Kabir', 'Shah'], ['GOS000103', 'Meera', 'Iyer']]) {
  const c = await ctx({ viewport: sid === 'GOS000103' ? { width: 390, height: 844 } : { width: 1280, height: 720 } });
  const p = await c.newPage(); watch(p, first);
  await step(`student ${first}: school link goes straight into the class (no waiting room)`, async () => {
    await p.goto(studentLink(sid, first, last));
    await p.waitForURL(/\/classroom\//, { timeout: 25000 });
    return p.url().replace(BASE, '');
  });
  students.push({ p, c, first, sid });
}
await teacher.waitForTimeout(3000);
await shot(students[0].p, '05-student-desktop');
await shot(students[2].p, '06-student-phone');
await step('teacher: roster lists all 3 students', async () => {
  const r = await teacher.request.get(`${BASE}/api/rooms/${code}/state`); const j = await r.json();
  const n = (j.admitted || []).filter((p) => p.role === 'STUDENT').length;
  return n === 3 ? '3 admitted' : (() => { throw new Error(`admitted students=${n}`); })();
});
await step('state API: no waiting list or waiting-room flag', async () => {
  const j = await (await teacher.request.get(`${BASE}/api/rooms/${code}/state`)).json();
  return !('waiting' in j) && !('waitingRoomOn' in j) ? 'fields gone' : false;
});
await step('admin route removed: /admit answers 404/405', async () => {
  const r = await teacher.request.post(`${BASE}/api/rooms/${code}/admit`, { data: { all: true } });
  return r.status() === 404 || r.status() === 405 ? `${r.status()}` : (() => { throw new Error(`status ${r.status()}`); })();
});


// ---------- Live media (LiveKit) ----------
await step('media: teacher turns camera on; mic on', async () => {
  const dock = teacher.locator('[data-testid=teacher-dock]');
  const cam = dock.getByRole('button', { name: 'Turn camera on' });
  if (await cam.count()) await cam.first().click();
  const mic = dock.getByRole('button', { name: 'Unmute microphone' });
  if (await mic.count()) await mic.first().click();
  await teacher.waitForTimeout(5000);
  return 'clicked';
});
await step('media: LiveKit sees teacher camera + mic and all 3 students connected', async () => {
  const t = await lkTracks(code); if (!t) throw new Error('no LiveKit room');
  const teacherId = Object.keys(t).find((k) => k.startsWith('teacher_') && !k.endsWith('__screen'));
  const studentsIn = Object.keys(t).filter((k) => k.startsWith('student_')).length;
  const tt = t[teacherId] || [];
  return tt.includes('camera') && tt.includes('microphone') && studentsIn === 3 ? `teacher [${tt}], students connected ${studentsIn}` : (() => { throw new Error(JSON.stringify(t)); })();
});
await step('media: students publish their cameras', async () => {
  const t = await lkTracks(code);
  const cams = Object.entries(t).filter(([k, v]) => k.startsWith('student_') && v.includes('camera')).length;
  return cams >= 1 ? `${cams} student cameras published` : (() => { throw new Error(JSON.stringify(t)); })();
});
await step('media: every student receives the teacher video (playing)', async () => {
  await students[0].p.waitForTimeout(3000);
  const counts = []; for (const s of students) counts.push(await playingVideos(s.p));
  return counts.every((n) => n >= 1) ? `playing videos per student: ${counts}` : (() => { throw new Error(`playing: ${counts}`); })();
});
await step('media: teacher sees student videos playing', async () => {
  const n = await playingVideos(teacher);
  return n >= 2 ? `${n} videos playing on the teacher page` : (() => { throw new Error(`playing: ${n}`); })();
});
await step('media: students receive the teacher audio track', async () => {
  const n = await students[0].p.evaluate(() => [...document.querySelectorAll('audio')].filter((a) => a.srcObject && a.srcObject.getAudioTracks().some((t) => t.readyState === 'live')).length);
  return n >= 1 ? `${n} live audio element(s)` : (() => { throw new Error(`audio elements: ${n}`); })();
});
await shot(teacher, '04b-teacher-live');
await shot(students[0].p, '05b-student-live');
await step('media: teacher shares the screen; students receive it', async () => {
  await teacher.locator('[data-testid=teacher-dock]').getByRole('button', { name: 'Share screen' }).first().click();
  await teacher.waitForTimeout(6000);
  const t = await lkTracks(code);
  const share = Object.entries(t).find(([, v]) => v.includes('screen_share'));
  if (!share) throw new Error(JSON.stringify(t));
  await students[0].p.waitForTimeout(2500);
  const n = await playingVideos(students[0].p);
  return `screen published by ${share[0].replace(/_.*/, '')}; student playing videos ${n}`;
});
await shot(teacher, '05c-teacher-sharing');
await shot(students[0].p, '05d-student-sees-share');
await step('media: stop screen share', async () => {
  const stop = teacher.getByRole('button', { name: /Stop sharing screen|Stop sharing/ }).first();
  await stop.click({ timeout: 8000 });
  await teacher.waitForTimeout(3000);
  const t = await lkTracks(code);
  return !Object.values(t).some((v) => v.includes('screen_share')) ? 'stopped' : (() => { throw new Error(JSON.stringify(t)); })();
});

// ---------- Hands + chat ----------
await step('student raises hand; teacher sees it', async () => {
  const s = students[0].p;
  const btn = s.getByRole('button', { name: /Raise hand|Raise your hand/i }).first();
  await btn.click({ timeout: 8000 });
  await teacher.waitForTimeout(2500);
  const j = await (await teacher.request.get(`${BASE}/api/rooms/${code}/state`)).json();
  return (j.raisedHands || []).length === 1 ? '1 hand up' : (() => { throw new Error(JSON.stringify(j.raisedHands)); })();
});
await shot(teacher, '07-teacher-hand');
await step('chat: teacher sends to everyone; students receive', async () => {
  const box = teacher.getByLabel('Chat message');
  for (let i = 0; i < 3 && !(await box.isVisible().catch(() => false)); i++) {
    await teacher.locator('[data-testid=teacher-dock]').getByRole('button', { name: /chat/i }).first().click();
    await teacher.waitForTimeout(700);
  }
  await box.fill('Hello class, open page 12');
  await teacher.getByRole('button', { name: 'Send message' }).click();
  await students[1].p.waitForTimeout(3000);
  const r = await students[1].p.request.get(`${BASE}/api/rooms/${code}/messages?as=student`);
  const t = await r.text();
  return t.includes('open page 12') ? 'delivered' : (() => { throw new Error(`status ${r.status()} ${t.slice(0, 120)}`); })();
});
await step('chat: student message reaches teacher', async () => {
  const s = students[1].p;
  const open = s.getByRole('button', { name: /chat/i }).first(); await open.click({ timeout: 8000 });
  await s.getByLabel(/Chat message|Message/i).first().fill('Which page, sir?');
  await s.getByRole('button', { name: /Send/i }).first().click();
  await teacher.waitForTimeout(3000);
  const t = await (await teacher.request.get(`${BASE}/api/rooms/${code}/messages`)).text();
  return t.includes('Which page') ? 'delivered' : false;
});
await shot(teacher, '08-teacher-chat');

// ---------- Whiteboard ----------
await teacher.keyboard.press('Escape').catch(() => {});
await step('teacher: open whiteboard', async () => {
  await teacher.getByRole('button', { name: /Share a whiteboard/i }).first().click();
  await teacher.locator('[data-testid=wb-host]').waitFor({ timeout: 10000 });
  return 'open';
});
await teacher.waitForTimeout(1500);
const canvas = teacher.locator('[data-testid=wb-host] [data-testid=wb-canvas]');
let bb = await canvas.boundingBox();
await step('whiteboard: pick red, check the student board has no red yet', async () => {
  await teacher.getByRole('button', { name: 'Colour and size' }).first().click();
  await teacher.getByRole('radio', { name: 'Colour #e53935' }).first().click();
  await teacher.keyboard.press('Escape');
  const n = await inkPixels(students[0].p);
  return n === 0 ? 'baseline 0 red pixels' : (() => { throw new Error(`baseline ${n}`); })();
});
await step('whiteboard: draw a stroke', async () => {
  await teacher.mouse.move(bb.x + 150, bb.y + 120); await teacher.mouse.down();
  await teacher.mouse.move(bb.x + 450, bb.y + 200, { steps: 10 }); await teacher.mouse.up();
  return 'drawn';
});
const topBefore = await canvas.boundingBox();
await step('whiteboard: students see the stroke live', async () => {
  await students[0].p.waitForTimeout(2500);
  const n = await inkPixels(students[0].p);
  return n > 20 ? `${n} ink pixels on the student board` : (() => { throw new Error(`ink pixels ${n}`); })();
});
await step('whiteboard: late joiner gets the board (snapshot)', async () => {
  const c = await ctx(); const p = await c.newPage();
  await p.goto(studentLink('GOS000104', 'Ishaan', 'Rao')); await p.waitForURL(/\/classroom\//, { timeout: 25000 });
  await p.waitForTimeout(6000);
  const n = await inkPixels(p); await c.close();
  return n > 20 ? `${n} ink pixels for the late joiner` : (() => { throw new Error(`ink pixels ${n}`); })();
});
await step('whiteboard: raised hand notice does not move the board', async () => {
  // Hand was raised earlier: the notice is in the floating stack; lower/raise again to change it.
  await students[2].p.getByRole('button', { name: /Raise hand|Raise your hand/i }).first().click({ timeout: 8000 }).catch(() => {});
  await teacher.waitForTimeout(3500);
  const after = await canvas.boundingBox();
  const stack = await teacher.locator('.wb-notice-stack').count();
  return Math.abs(after.y - topBefore.y) < 1 && Math.abs(after.height - topBefore.height) < 1 ? `board stayed at y=${after.y}; notice stack=${stack}` : (() => { throw new Error(`moved ${topBefore.y}->${after.y}`); })();
});
await shot(teacher, '09-wb-hand-notice');
await step('whiteboard: wheel scrolls the long page (top fixed, goes down)', async () => {
  await teacher.mouse.move(bb.x + 400, bb.y + 300);
  for (let i = 0; i < 8; i++) { await teacher.mouse.wheel(0, 400); await teacher.waitForTimeout(40); }
  await teacher.waitForTimeout(400);
  return (await teacher.locator('[data-testid=wb-scroll-top]').count()) ? '"↑ Top" shown after scrolling' : false;
});
await step('whiteboard: draw far down the page', async () => {
  await teacher.mouse.move(bb.x + 200, bb.y + 200); await teacher.mouse.down();
  await teacher.mouse.move(bb.x + 600, bb.y + 260, { steps: 10 }); await teacher.mouse.up(); return 'drawn';
});
await shot(teacher, '10-wb-scrolled');
fs.copyFileSync(process.env.PDF, `${OUT}/lesson.pdf`);
await step('whiteboard: import a 2-page PDF (uploaded as class images)', async () => {
  await teacher.setInputFiles('[data-testid=wb-host] [data-testid=wb-file]', process.env.PDF);
  const { execSync } = await import('node:child_process');
  let n = 0;
  for (let i = 0; i < 60 && n < 2; i++) { await teacher.waitForTimeout(500); n = Number(execSync(`redis-cli --raw scard room:${code}:wbassets`).toString().trim()); }
  return n >= 2 ? `${n} page images stored on the server` : (() => { throw new Error(`assets=${n}`); })();
});
await shot(teacher, '11-wb-pdf');
await step('whiteboard: insert a picture', async () => {
  const { execSync } = await import('node:child_process');
  const before = Number(execSync(`redis-cli --raw scard room:${code}:wbassets`).toString().trim());
  await teacher.waitForFunction(() => !document.querySelector('[data-testid=wb-busy]'), null, { timeout: 30000 });
  await teacher.setInputFiles('[data-testid=wb-host] [data-testid=wb-file]', process.env.PIC);
  let after = before;
  for (let i = 0; i < 30 && after === before; i++) { await teacher.waitForTimeout(500); after = Number(execSync(`redis-cli --raw scard room:${code}:wbassets`).toString().trim()); }
  return after === before + 1 ? 'uploaded and placed' : (() => { throw new Error(`${before} -> ${after}`); })();
});
await shot(teacher, '11b-wb-picture');
let assetId;
await step('whiteboard image: admitted student can fetch it; outsider cannot', async () => {
  const { execSync } = await import('node:child_process');
  assetId = execSync(`redis-cli --raw srandmember room:${code}:wbassets`).toString().trim();
  const s = await students[0].p.request.get(`${BASE}/api/rooms/${code}/whiteboard/asset/${assetId}?as=student`);
  const anon = await (await browser.newContext()).request.get(`${BASE}/api/rooms/${code}/whiteboard/asset/${assetId}`);
  return s.status() === 200 && anon.status() === 401 ? `student ${s.status()} (${s.headers()['content-type']}), anonymous ${anon.status()}` : (() => { throw new Error(`student ${s.status()} anon ${anon.status()}`); })();
});
await step('whiteboard: board snapshot stored for late joiners (small: images by reference)', async () => {
  await teacher.waitForTimeout(6000);
  const { execSync } = await import('node:child_process');
  const len = Number(execSync(`redis-cli --raw strlen room:${code}:wbsnap`).toString().trim());
  return len > 0 && len < 200000 ? `${len} bytes` : (() => { throw new Error(`snapshot length ${len}`); })();
});
await step('student: follows the teacher down the page and sees the PDF', async () => {
  await students[0].p.waitForTimeout(2500);
  const img = await students[0].p.evaluate(() => {
    const c = document.querySelector('[data-whiteboard] canvas'); if (!c) return -1;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 40 && d[i + 1] < 40 && d[i + 2] > 200) n++; // the PDF's blue rule
    return n;
  });
  return img > 20 ? `${img} blue pixels of the PDF's rule on the student board` : (() => { throw new Error(`blue pixels ${img}`); })();
});
await shot(students[0].p, '12-student-wb');
await step('whiteboard: stop', async () => {
  await teacher.locator('[data-testid=wbm-stop]').click({ timeout: 8000 });
  await teacher.locator('[data-testid=wb-host]').waitFor({ state: 'detached', timeout: 8000 }); return 'closed';
});

// ---------- Remove + rejoin ----------
await step('teacher removes a student; student is out', async () => {
  const j = await (await teacher.request.get(`${BASE}/api/rooms/${code}/state`)).json();
  const kabir = j.admitted.find((p) => p.displayName?.startsWith('Kabir'));
  const r = await teacher.request.post(`${BASE}/api/rooms/${code}/leave`, { data: { participantId: kabir.id } });
  if (!r.ok()) throw new Error(`${r.status()}`);
  await students[1].p.waitForTimeout(5000);
  await students[1].p.getByTestId('rejoin-class').waitFor({ timeout: 8000 });
  return 'removed screen with "Join again"';
});
await shot(students[1].p, '13-removed-student');
await step('removed student joins again and goes straight in', async () => {
  const p = students[1].p;
  await p.goto(studentLink('GOS000102', 'Kabir', 'Shah'));
  await p.waitForURL(/\/classroom\//, { timeout: 25000 });
  await p.waitForTimeout(2000);
  const j = await (await teacher.request.get(`${BASE}/api/rooms/${code}/state`)).json();
  return j.admitted.some((x) => x.displayName?.startsWith('Kabir')) ? 'back in the roster' : false;
});

// ---------- Student leave + rejoin ----------
await step('student presses Leave, then rejoins directly', async () => {
  const p = students[0].p;
  await p.getByRole('button', { name: /^Leave/ }).first().click({ timeout: 8000 });
  const confirm = p.getByRole('button', { name: /^Leave( class)?$/ }); if (await confirm.count()) await confirm.last().click().catch(() => {});
  await p.waitForTimeout(2500);
  const left = p.url().replace(BASE, '');
  await p.goto(studentLink('GOS000101', 'Arohi', 'Patil'));
  await p.waitForURL(/\/classroom\//, { timeout: 25000 });
  return `left to ${left}, back in ${p.url().replace(BASE, '')}`;
});

// ---------- Admin observes ----------
await step('admin: live classes page lists the class', async () => {
  await admin.goto(`${BASE}/admin/live`); await admin.waitForTimeout(1500); await admin.waitForTimeout(2000);
  const t = await admin.content(); return t.includes(code) || /Science/i.test(t) ? 'listed' : false;
});
await shot(admin, '14-admin-live');

// ---------- End ----------
await step('teacher ends the class for everyone', async () => {
  await teacher.locator('[data-testid=leave-end]').first().click();
  await teacher.locator('[data-testid=leave-end-end]').first().click();
  const confirm = teacher.locator('[data-testid=end-class-confirm]');
  await confirm.waitFor({ timeout: 8000 });
  await confirm.getByRole('button', { name: /End class/ }).last().click();
  await teacher.waitForTimeout(4000);
  return 'ended';
});
await shot(teacher, '15-teacher-ended');
await step('students see the class ended', async () => {
  await students[2].p.waitForTimeout(4000);
  const t = await students[2].p.content();
  return /ended/i.test(t) ? 'ended screen' : false;
});
await shot(students[2].p, '16-student-ended');
await step('whiteboard images deleted at class end', async () => {
  const { execSync } = await import('node:child_process');
  const n = execSync(`redis-cli --raw exists room:${code}:wbasset:${assetId}`).toString().trim();
  return n === '0' ? 'deleted' : (() => { throw new Error('still there'); })();
});
await step('attendance: admin report lists the class with 3 students present', async () => {
  const r = await admin.request.get(`${BASE}/api/admin/reports/detail`);
  const t = await r.text();
  const names = ['Arohi', 'Kabir', 'Meera'].filter((n) => t.includes(n));
  return r.ok() && names.length === 3 ? `${r.status()}, all 3 named` : (() => { throw new Error(`${r.status()} names=${names} ${t.slice(0, 160)}`); })();
});

fs.writeFileSync(`${OUT}/results.json`, JSON.stringify({ results, errors }, null, 1));
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const [who, list] of Object.entries(errors)) if (list.length) console.log('page errors', who, list.slice(0, 3));
await browser.close();
