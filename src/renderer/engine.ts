import type { BootInfo, DisplayInfo, SourceInfo, TeacherAction } from '../shared/actions';
import { parseSchedule, passwordProblem, type ClassChoice, type GradeChoice } from '../shared/apiModel';
import { dockGridStyle, isOfferedShareWindow } from '../shared/capture';
import { endedSessionCopy, isEndedReason } from '../shared/session';
import { focusLabel, isFocusAlert } from '../shared/session';
import { replyTargetFor, stickyChatRecipient } from '../shared/chatReply';
import { sortRoster, type SlotCount } from '../shared/classLogic';
import { desktop } from './bridge';
import { ClassController, type ClassView } from './classSession';
import { ICONS, type IconName } from './icons';
import { avatarHue, initials, personChips, scopeBadge } from './people';

const app = document.getElementById('app')!;
const api = desktop();
let boot: BootInfo | null = null;
let controller: ClassController | null = null;
let unsubAction: (() => void) | null = null;
let dockEl: HTMLElement | null = null;
let chatBuilt = false;
let paintedMessages = -1;

window.addEventListener('freeze', (event) => event.stopImmediatePropagation(), true);

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

function sym(id: string, name: IconName, label: string, extra = ''): string {
  const cls = extra ? `sym ${extra}` : 'sym';
  return `<button class="${cls}" id="${id}" type="button" title="${esc(label)}" aria-label="${esc(label)}">${ICONS[name]}</button>`;
}

function symCount(id: string, name: IconName, label: string, badgeId: string): string {
  return `<button class="sym" id="${id}" type="button" title="${esc(label)}" aria-label="${esc(label)}">${ICONS[name]}<span class="count" id="${badgeId}" hidden></span></button>`;
}

function setBadge(id: string, n: number): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.hidden = n <= 0;
  el.textContent = n > 9 ? '9+' : String(n);
}

function setPressed(id: string, on: boolean): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle('on', on);
  el.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function setLabel(id: string, label: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  el.title = label;
  el.setAttribute('aria-label', label);
}

function setGlyph(id: string, name: IconName): void {
  const el = document.getElementById(id);
  if (!el) return;
  const badge = el.querySelector('.count');
  el.innerHTML = ICONS[name];
  if (badge) el.append(badge);
}

function applyDockSize(dock: HTMLElement, layout: SlotCount): void {
  const style = dockGridStyle(layout);
  dock.style.gridTemplateColumns = style.gridTemplateColumns;
  dock.style.gridTemplateRows = style.gridTemplateRows;
}

let dockResizeOn = false;
function watchDockSize(): void {
  if (dockResizeOn) return;
  dockResizeOn = true;
  window.addEventListener('resize', () => {
    const dock = document.getElementById('dock-grid');
    const layout = controller?.view().layout;
    if (!dock || !layout || dock.hidden) return;
    applyDockSize(dock, layout);
  });
}

function avatarEl(name: string, small = false): HTMLElement {
  const el = document.createElement('span');
  el.className = small ? 'avatar sm' : 'avatar';
  el.style.setProperty('--hue', String(avatarHue(name)));
  el.textContent = initials(name);
  el.setAttribute('aria-hidden', 'true');
  return el;
}

function chipEl(text: string, kind: string): HTMLElement {
  const el = document.createElement('span');
  el.className = kind ? `chip ${kind}` : 'chip';
  el.textContent = text;
  return el;
}

let activePane = 'pane-roster';

function clearController(): void {
  unsubAction?.();
  unsubAction = null;
  dockEl = null;
  controller?.destroy();
  controller = null;
  chatBuilt = false;
  paintedMessages = -1;
}

async function bootApp(): Promise<void> {
  app.innerHTML = '<div class="center"><p>Opening…</p></div>';
  boot = await api.getBoot();
  if (boot.me?.role === 'teacher' && boot.me.mustChangePassword) {
    showPassword('');
    return;
  }
  if (boot.me?.role === 'teacher') {
    await showHome();
    return;
  }
  const reason = isEndedReason(boot.reason) ? endedSessionCopy(boot.reason) : null;
  showLogin(reason ? `${reason.title}. ${reason.body}` : '');
}

function showLogin(message: string): void {
  clearController();
  const server = boot?.server ?? '';
  const email = boot?.email ?? '';
  app.innerHTML = `
    <div class="center">
      <form class="card" id="login">
        <p class="brand">Classroom</p>
        <h1>Classroom Teacher</h1>
        <p class="sub">Sign in with your teacher account. One device at a time.</p>
        <p class="err" id="err">${esc(message)}</p>
        <label for="server">Server</label>
        <input id="server" value="${esc(server)}" autocomplete="url" />
        <label for="email">Email</label>
        <input id="email" type="email" value="${esc(email)}" autocomplete="username" />
        <label for="password">Password</label>
        <input id="password" type="password" autocomplete="current-password" />
        <div class="row" style="margin-top:14px">
          <button class="btn primary" type="submit">Sign in</button>
        </div>
      </form>
    </div>`;
  const form = document.getElementById('login') as HTMLFormElement;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const err = document.getElementById('err')!;
    err.textContent = '';
    const server = (document.getElementById('server') as HTMLInputElement).value;
    const saved = await api.setServer(server);
    if (!saved.ok) {
      err.textContent = saved.error || 'Check the server address.';
      return;
    }
    if (boot) boot.server = saved.server || boot.server;
    const email = (document.getElementById('email') as HTMLInputElement).value;
    const password = (document.getElementById('password') as HTMLInputElement).value;
    const res = await api.login(email, password);
    if (!res.ok) {
      err.textContent = res.error || 'Could not sign in.';
      return;
    }
    if (boot) boot.email = res.email || email;
    if (res.mustChangePassword) showPassword('');
    else await showHome();
  });
}

function showPassword(message: string): void {
  app.innerHTML = `
    <div class="center">
      <form class="card" id="pw">
        <p class="brand">Classroom</p>
        <h1>Change password</h1>
        <p class="sub">Choose a new password before starting class.</p>
        <p class="err" id="err">${esc(message)}</p>
        <label for="current">Current password</label>
        <input id="current" type="password" autocomplete="current-password" />
        <label for="next">New password</label>
        <input id="next" type="password" autocomplete="new-password" />
        <div class="row" style="margin-top:14px">
          <button class="btn primary" type="submit">Save password</button>
        </div>
      </form>
    </div>`;
  document.getElementById('pw')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const current = (document.getElementById('current') as HTMLInputElement).value;
    const next = (document.getElementById('next') as HTMLInputElement).value;
    const err = document.getElementById('err')!;
    const problem = passwordProblem(next, { email: boot?.email, current });
    if (problem) {
      err.textContent = problem;
      return;
    }
    const res = await api.changePassword(current, next);
    if (!res.ok) {
      err.textContent = res.error || 'Could not change the password.';
      return;
    }
    await showHome();
  });
}

async function showHome(): Promise<void> {
  clearController();
  app.innerHTML = `
    <div class="home">
      <header class="home-top">
        <div>
          <p class="brand">Classroom</p>
          <h1>Today</h1>
          <p class="hint" id="home-status">Loading the timetable…</p>
        </div>
        <div class="home-actions" id="home-actions"></div>
      </header>
      <div id="home-live"></div>
      <h2 class="section-label">Schedule</h2>
      <div id="home-days"></div>
      <div id="home-adhoc"></div>
    </div>`;
  const actions = document.getElementById('home-actions')!;
  const who = document.createElement('span');
  who.className = 'who-pill';
  who.textContent = boot?.email || '';
  who.title = boot?.email || '';
  const out = document.createElement('button');
  out.className = 'btn';
  out.type = 'button';
  out.textContent = 'Sign out';
  out.addEventListener('click', async () => {
    await api.logout();
    if (boot) boot.me = null;
    showLogin('');
  });
  actions.append(who, out);
  const res = await api.api('GET', '/api/teacher/schedule');
  const status = document.getElementById('home-status');
  if (res.status === 401) {
    showLogin('Sign in again to continue.');
    return;
  }
  if (res.status !== 200) {
    if (status) status.textContent = 'Could not load the timetable.';
    return;
  }
  const schedule = parseSchedule(res.data);
  if (status) status.textContent = schedule.timezone ? `Times shown in ${schedule.timezone}` : '';
  const liveHost = document.getElementById('home-live')!;
  if (schedule.activeCode) {
    const live = document.createElement('div');
    live.className = 'live-card';
    const copy = document.createElement('div');
    const title = document.createElement('h2');
    title.textContent = 'Class in progress';
    const detail = document.createElement('p');
    detail.textContent = schedule.activeLabel
      ? `${schedule.activeLabel}. Rejoin returns you to the same room.`
      : 'Rejoin returns you to the same room.';
    copy.append(title, detail);
    const rejoin = document.createElement('button');
    rejoin.className = 'btn primary';
    rejoin.type = 'button';
    rejoin.textContent = 'Rejoin';
    rejoin.addEventListener('click', () => join(schedule.activeCode!));
    live.append(copy, rejoin);
    liveHost.append(live);
  }
  const byDate = new Map<string, ClassChoice[]>();
  for (const item of schedule.classes) {
    const list = byDate.get(item.date) ?? [];
    list.push(item);
    byDate.set(item.date, list);
  }
  const dates = [...byDate.keys()].sort((a, b) => {
    if (a === schedule.today) return -1;
    if (b === schedule.today) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const days = document.getElementById('home-days')!;
  if (!dates.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const title = document.createElement('p');
    title.className = 'empty-title';
    title.textContent = 'Nothing on the timetable';
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = 'When a period is scheduled it will show up here. You can still start a class below.';
    empty.append(title, hint);
    days.append(empty);
  }
  for (const date of dates) {
    const block = document.createElement('section');
    block.className = 'day-block';
    const label = document.createElement('h3');
    label.className = 'day-label';
    label.textContent = date === schedule.today ? 'Today' : date;
    if (date === schedule.today && date) {
      const sub = document.createElement('span');
      sub.textContent = date;
      label.append(sub);
    }
    const list = document.createElement('div');
    list.className = 'schedule';
    for (const item of byDate.get(date) ?? []) list.append(classCard(item));
    block.append(label, list);
    days.append(block);
  }
  document.getElementById('home-adhoc')?.append(adHocForm(schedule.grades));
}

function classCard(item: ClassChoice): HTMLElement {
  const card = document.createElement('article');
  card.className = item.live ? 'class-card live' : 'class-card';
  const time = document.createElement('div');
  time.className = 'class-time';
  const parts = item.timeLabel.split('–');
  const start = document.createElement('span');
  start.className = 'clock-start';
  start.textContent = (parts[0] || item.timeLabel || '—').trim();
  const end = document.createElement('span');
  end.className = 'clock-end';
  end.textContent = (parts[1] || '').trim();
  time.append(start, end);
  const main = document.createElement('div');
  main.className = 'class-main';
  const title = document.createElement('strong');
  title.textContent = item.subject;
  const audience = document.createElement('div');
  audience.className = 'audience';
  audience.textContent = item.audience;
  main.append(title, audience);
  if (item.note) {
    const note = document.createElement('span');
    note.className = 'note hint';
    note.textContent = item.note;
    main.append(note);
  }
  const chips = document.createElement('div');
  chips.className = 'chips';
  if (item.live) chips.append(chipEl('Live', 'live'));
  else if (item.phase) chips.append(chipEl(item.phase, ''));
  if (!item.mine) chips.append(chipEl('Another teacher', ''));
  if (chips.childElementCount) main.append(chips);
  card.append(time, main);
  if (item.canStart) {
    const startBtn = document.createElement('button');
    startBtn.className = 'btn primary';
    startBtn.type = 'button';
    startBtn.textContent = item.live ? 'Open' : 'Start class';
    startBtn.addEventListener('click', () => void startScheduled(item.key));
    card.append(startBtn);
  }
  return card;
}

function adHocForm(grades: GradeChoice[]): HTMLElement {
  const wrap = document.createElement('form');
  wrap.className = 'adhoc-card';
  const title = document.createElement('h2');
  title.textContent = 'Start without a timetable slot';
  const blurb = document.createElement('p');
  blurb.className = 'hint';
  blurb.textContent = 'Pick who the class is for. Students join muted, and the waiting room stays on until you turn it off.';
  const grid = document.createElement('div');
  grid.className = 'adhoc-grid';
  const grade = document.createElement('select');
  grade.id = 'adhoc-grade';
  const division = document.createElement('select');
  division.id = 'adhoc-division';
  const subject = document.createElement('input');
  subject.id = 'adhoc-subject';
  subject.maxLength = 80;
  subject.placeholder = 'Optional';
  subject.setAttribute('aria-label', 'Subject');
  const fillDivisions = () => {
    division.replaceChildren();
    const g = grades.find((item) => item.grade === grade.value);
    if (g?.whole) {
      const opt = document.createElement('option');
      opt.value = '*';
      opt.textContent = 'All divisions';
      division.append(opt);
    }
    for (const div of g?.divisions ?? []) {
      const opt = document.createElement('option');
      opt.value = div.name;
      opt.textContent = div.label;
      division.append(opt);
    }
  };
  for (const g of grades) {
    const opt = document.createElement('option');
    opt.value = g.grade;
    opt.textContent = g.label;
    grade.append(opt);
  }
  grade.addEventListener('change', fillDivisions);
  fillDivisions();
  const go = document.createElement('button');
  go.className = 'btn primary';
  go.type = 'button';
  go.textContent = 'Start class';
  const err = document.createElement('p');
  err.className = 'err';
  go.addEventListener('click', () => void startAdHoc(grade.value, division.value, subject.value, err));
  const gField = field('Grade', 'adhoc-grade', grade);
  const dField = field('Division', 'adhoc-division', division);
  const sField = field('Subject', 'adhoc-subject', subject);
  grid.append(gField, dField, sField, go);
  wrap.append(title, blurb, grid, err);
  return wrap;
}

function field(label: string, id: string, control: HTMLElement): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const lab = document.createElement('label');
  lab.htmlFor = id;
  lab.textContent = label;
  wrap.append(lab, control);
  return wrap;
}

async function startScheduled(key: string): Promise<void> {
  const res = await api.api('POST', '/api/teacher/sessions/start', {
    kind: 'scheduled',
    key,
    maxVisibleVideos: boot ? boot.layout - 1 : 3,
  });
  const code = res.data && typeof res.data === 'object' && 'code' in res.data ? String((res.data as { code: unknown }).code) : '';
  if (res.status >= 400 || !code) {
    window.alert(textOf(res.data, 'Could not start that class.'));
    return;
  }
  join(code);
}

async function startAdHoc(grade: string, division: string, subject: string, err: HTMLElement): Promise<void> {
  if (!grade || !division) {
    err.textContent = 'Choose a grade and division.';
    return;
  }
  const body = {
    kind: 'adhoc' as const,
    grade,
    divisions: division === '*' ? [] : [division],
    allDivisions: division === '*',
    subject: subject.trim() || undefined,
    maxVisibleVideos: boot ? boot.layout - 1 : 3,
  };
  const res = await api.api('POST', '/api/teacher/sessions/start', body);
  const code = res.data && typeof res.data === 'object' && 'code' in res.data ? String((res.data as { code: unknown }).code) : '';
  if (res.status >= 400 || !code) {
    err.textContent = textOf(res.data, 'Could not start that class.');
    return;
  }
  join(code);
}

function textOf(data: unknown, fallback: string): string {
  if (data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string') {
    return (data as { error: string }).error;
  }
  return fallback;
}

function join(code: string): void {
  clearController();
  if (!boot) return;
  controller = new ClassController(
    { layout: boot.layout, micId: boot.micId, camId: boot.camId, plan: boot.capture },
    {
      onView: (view) => routeView(view),
      onLeft: () => {
        clearController();
        void showHome();
      },
      onLogin: (message) => showLogin(message),
    }
  );
  unsubAction = api.onAction((action) => {
    if (action.type === 'open-share') {
      void openShare();
      return;
    }
    if (boot && action.type === 'layout' && (action.slots === 2 || action.slots === 4 || action.slots === 6)) boot.layout = action.slots;
    if (boot && action.type === 'set-mic' && typeof action.deviceId === 'string') boot.micId = action.deviceId;
    if (boot && action.type === 'set-cam' && typeof action.deviceId === 'string') boot.camId = action.deviceId;
    controller?.handle(action);
  });
  routeView(controller.view());
  void controller.start(code);
}

function routeView(view: ClassView): void {
  if (!controller) return;
  if (view.phase === 'handoff' && view.handoff) {
    dockEl = null;
    controller.setDockHost(null);
    showHandoff(view);
    return;
  }
  if (view.phase === 'ended') {
    dockEl = null;
    controller.setDockHost(null);
    showEnded(view);
    return;
  }
  renderClass(view);
  const dock = document.getElementById('dock-grid');
  if (dock && dock !== dockEl) {
    dockEl = dock;
    controller.setDockHost(dock);
  }
}

function showHandoff(view: ClassView): void {
  const handoff = view.handoff;
  if (!handoff) return;
  app.innerHTML = `
    <div class="center">
      <div class="card">
        <p class="brand">Classroom</p>
        <h1>${esc(handoff.title)}</h1>
        <p>${esc(handoff.body)}</p>
        <button class="btn primary" id="take" type="button">Use this device instead</button>
      </div>
    </div>`;
  document.getElementById('take')?.addEventListener('click', () => void controller?.takeBack());
}

function showEnded(view: ClassView): void {
  app.innerHTML = `
    <div class="center">
      <div class="card">
        <p class="brand">Classroom</p>
        <h1>Class ended</h1>
        <p class="sub">${esc(view.label)}</p>
        <button class="btn primary" id="home" type="button">Back to timetable</button>
      </div>
    </div>`;
  document.getElementById('home')?.addEventListener('click', () => {
    clearController();
    void showHome();
  });
}

function renderClass(view: ClassView): void {
  if (!document.getElementById('class-screen')) buildClass();
  document.getElementById('class-screen')?.classList.toggle('sharing', view.sharing);
  const label = document.getElementById('class-label');
  if (label) label.textContent = view.label;
  const code = document.getElementById('class-code');
  if (code) code.textContent = view.code;
  const conn = document.getElementById('class-conn');
  if (conn) {
    conn.textContent = view.phase === 'connecting' ? 'Connecting…' : view.connection;
    conn.classList.toggle('live', view.connection === 'connected');
  }
  const notice = document.getElementById('notice');
  if (notice) notice.textContent = view.notice;
  const banner = document.getElementById('audio-banner');
  if (banner) banner.hidden = !view.audioBlocked;
  setPressed('btn-mic', view.micOn);
  setPressed('btn-cam', view.camOn);
  document.getElementById('btn-mic')?.classList.toggle('danger', !view.micOn);
  document.getElementById('btn-cam')?.classList.toggle('danger', !view.camOn);
  setGlyph('btn-mic', view.micOn ? 'mic' : 'micOff');
  setGlyph('btn-cam', view.camOn ? 'cam' : 'camOff');
  setLabel('btn-mic', view.micOn ? 'Mute microphone' : 'Unmute microphone');
  setLabel('btn-cam', view.camOn ? 'Turn camera off' : 'Turn camera on');
  setLabel('btn-videos', view.sharing ? (view.videosOn ? 'Close student videos' : 'Open student videos') : 'Student videos');
  setPressed('btn-pen', view.annotateOn);
  const pen = document.getElementById('btn-pen');
  if (pen) pen.toggleAttribute('disabled', !view.sharing);
  document.getElementById('btn-share')?.toggleAttribute('hidden', view.sharing);
  document.getElementById('btn-stop')?.toggleAttribute('hidden', !view.sharing);
  document.getElementById('btn-end')?.toggleAttribute('hidden', view.sharing);
  setPressed('btn-videos', view.sharing ? view.videosOn : true);
  for (const n of [2, 4, 6] as const) setPressed(`layout-${n}`, view.layout === n);
  const waiting = document.getElementById('btn-waiting');
  if (waiting) {
    const labelText = view.waitingRoomOn ? 'Waiting room on' : 'Waiting room off';
    waiting.textContent = labelText;
    waiting.title = view.waitingRoomOn ? 'Waiting room on. New students wait for you.' : 'Waiting room off. New students enter muted.';
    waiting.classList.toggle('on', view.waitingRoomOn);
    waiting.classList.toggle('warn', !view.waitingRoomOn);
    waiting.setAttribute('aria-pressed', view.waitingRoomOn ? 'true' : 'false');
  }
  const hands = view.roster.filter((p) => p.handRaised).length;
  const focusN = view.roster.filter((p) => isFocusAlert(p.focus)).length;
  const rosterN = hands + view.waiting.length + focusN;
  setBadge('badge-chat', view.unread);
  setBadge('badge-chat-tab', view.unread);
  setBadge('badge-roster', rosterN);
  setBadge('badge-roster-tab', view.waiting.length);
  document.getElementById('btn-open-chat')?.classList.toggle('on', activePane === 'pane-chat');
  document.getElementById('btn-open-roster')?.classList.toggle('on', activePane === 'pane-roster');
  paintRoster(view);
  paintChat(view);
  const dock = document.getElementById('dock-grid');
  if (dock) {
    dock.hidden = view.sharing;
    applyDockSize(dock, view.layout);
  }
}

function buildClass(): void {
  chatBuilt = false;
  paintedMessages = -1;
  activePane = 'pane-roster';
  const penTitle = 'Draw on the screen. Students see the marks. Classroom windows stay out of the picture.';
  app.innerHTML = `
    <div class="screen" id="class-screen">
      <header class="top">
        <div class="who">
          <strong id="class-label">Class</strong>
          <span class="code-pill" id="class-code"></span>
        </div>
        <span class="conn" id="class-conn"></span>
        <div class="row">
          <button class="btn" id="btn-leave" type="button">Leave</button>
          <button class="btn danger" id="btn-end" type="button">End class</button>
        </div>
      </header>
      <div class="class-body">
        <div class="film" id="film">
          <div id="dock-grid"></div>
        </div>
        <aside class="side">
          <div class="tabs" role="tablist">
            <button type="button" id="tab-roster" class="on" role="tab">${ICONS.people}<span>People</span> <span class="tab-count" id="badge-roster-tab" hidden></span></button>
            <button type="button" id="tab-chat" role="tab">${ICONS.chat}<span>Messages</span> <span class="tab-count" id="badge-chat-tab" hidden></span></button>
          </div>
          <div class="pane" id="pane-roster"></div>
          <div class="pane" id="pane-chat" hidden></div>
        </aside>
      </div>
      <div class="meet-wrap">
        <div class="meet-bar" id="controls">
          ${sym('btn-mic', 'mic', 'Mute microphone')}
          ${sym('btn-cam', 'cam', 'Turn camera off')}
          ${sym('btn-share', 'share', 'Share the screen')}
          ${sym('btn-stop', 'stop', 'Stop sharing', 'danger')}
          ${sym('btn-pen', 'pen', penTitle)}
          ${symCount('btn-open-chat', 'chat', 'Messages', 'badge-chat')}
          ${symCount('btn-open-roster', 'people', 'People', 'badge-roster')}
          ${sym('btn-videos', 'video', 'Student videos')}
          <span class="bar-div"></span>
          <div class="seg" role="group" aria-label="Videos on screen">
            <button class="sym texty" id="layout-2" type="button" title="Show 2 videos, including you" aria-label="Show 2 videos, including you">2</button>
            <button class="sym texty" id="layout-4" type="button" title="Show 4 videos, including you" aria-label="Show 4 videos, including you">4</button>
            <button class="sym texty" id="layout-6" type="button" title="Show 6 videos, including you" aria-label="Show 6 videos, including you">6</button>
          </div>
          <button class="sym texty" id="btn-waiting" type="button">Waiting room on</button>
          <button class="sym texty" id="btn-mute" type="button" title="Mute every student" aria-label="Mute every student">Mute all</button>
          <button class="sym texty" id="btn-allow" type="button" title="Allow unmute" aria-label="Allow unmute">Allow unmute</button>
        </div>
        <p class="err" id="notice"></p>
        <div class="banner" id="audio-banner" hidden>Click to hear students. <button class="btn" id="btn-hear" type="button">Hear</button></div>
      </div>
    </div>
    <dialog id="share-dialog"></dialog>`;
  document.getElementById('btn-stop')?.setAttribute('hidden', '');
  watchDockSize();
  const act = (type: TeacherAction['type']) => () => controller?.handle({ type } as TeacherAction);
  document.getElementById('btn-mic')?.addEventListener('click', act('toggle-mic'));
  document.getElementById('btn-cam')?.addEventListener('click', act('toggle-cam'));
  document.getElementById('btn-leave')?.addEventListener('click', act('leave'));
  document.getElementById('btn-end')?.addEventListener('click', act('end'));
  document.getElementById('btn-mute')?.addEventListener('click', () => controller?.handle({ type: 'mute-all', muted: true }));
  document.getElementById('btn-allow')?.addEventListener('click', () => controller?.handle({ type: 'mute-all', muted: false }));
  document.getElementById('btn-waiting')?.addEventListener('click', () => {
    const on = controller?.view().waitingRoomOn === false;
    controller?.handle({ type: 'waiting-room', on });
  });
  for (const n of [2, 4, 6] as const) {
    document.getElementById(`layout-${n}`)?.addEventListener('click', () => {
      if (boot) boot.layout = n;
      controller?.handle({ type: 'layout', slots: n });
    });
  }
  document.getElementById('btn-share')?.addEventListener('click', () => void openShare());
  document.getElementById('btn-stop')?.addEventListener('click', act('stop-share'));
  document.getElementById('btn-pen')?.addEventListener('click', act('toggle-annotate'));
  document.getElementById('btn-open-chat')?.addEventListener('click', () => showPane('pane-chat', 'tab-chat'));
  document.getElementById('btn-open-roster')?.addEventListener('click', () => showPane('pane-roster', 'tab-roster'));
  document.getElementById('btn-videos')?.addEventListener('click', () => {
    if (controller?.view().sharing) {
      controller.handle({ type: 'toggle-videos' });
      return;
    }
    document.getElementById('dock-grid')?.scrollIntoView({ block: 'nearest' });
  });
  document.getElementById('btn-hear')?.addEventListener('click', () => void controller?.hear());
  for (const [id, pane] of [
    ['tab-roster', 'pane-roster'],
    ['tab-chat', 'pane-chat'],
  ] as const) {
    document.getElementById(id)?.addEventListener('click', () => showPane(pane, id));
  }
}

function showPane(paneId: string, tabId: string): void {
  activePane = paneId;
  for (const id of ['pane-roster', 'pane-chat']) {
    const el = document.getElementById(id);
    if (el) el.hidden = id !== paneId;
  }
  for (const id of ['tab-roster', 'tab-chat']) {
    document.getElementById(id)?.classList.toggle('on', id === tabId);
  }
  document.getElementById('btn-open-chat')?.classList.toggle('on', paneId === 'pane-chat');
  document.getElementById('btn-open-roster')?.classList.toggle('on', paneId === 'pane-roster');
  if (paneId === 'pane-chat') controller?.handle({ type: 'mark-chat-read' });
}

function paintRoster(view: ClassView): void {
  const pane = document.getElementById('pane-roster');
  if (!pane) return;
  pane.replaceChildren();
  const head = document.createElement('div');
  head.className = 'pane-head';
  const copy = document.createElement('div');
  const title = document.createElement('h2');
  const inClass = view.roster.length;
  title.textContent = inClass ? `People · ${inClass}` : 'People';
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = view.waitingRoomOn
    ? 'Lobby is at the top. Admitted students follow, raised hands first.'
    : 'Waiting room is off. New students enter muted.';
  copy.append(title, hint);
  head.append(copy);
  if (view.waiting.length) {
    const all = document.createElement('button');
    all.className = 'btn ok';
    all.type = 'button';
    all.textContent = 'Admit all';
    all.addEventListener('click', () => controller?.handle({ type: 'admit-all' }));
    head.append(all);
  }
  pane.append(head);
  if (view.waiting.length) {
    const label = document.createElement('p');
    label.className = 'lobby-label';
    label.textContent = `Lobby · ${view.waiting.length}`;
    pane.append(label);
    for (const student of view.waiting) {
      const row = document.createElement('div');
      row.className = 'person wait';
      const main = document.createElement('div');
      main.className = 'person-main';
      const name = document.createElement('strong');
      name.textContent = student.displayName;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = 'Waiting to be admitted';
      main.append(name, meta);
      const admit = document.createElement('button');
      admit.className = 'btn primary';
      admit.type = 'button';
      admit.textContent = 'Admit';
      admit.setAttribute('aria-label', `Admit ${student.displayName}`);
      admit.addEventListener('click', () => controller?.handle({ type: 'admit', id: student.id }));
      row.append(avatarEl(student.displayName), main, admit);
      pane.append(row);
    }
  }
  if (!view.roster.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state compact';
    const emptyTitle = document.createElement('p');
    emptyTitle.className = 'empty-title';
    emptyTitle.textContent = 'No students in class yet';
    const emptyHint = document.createElement('p');
    emptyHint.className = 'hint';
    emptyHint.textContent = 'Admitted students appear under the lobby. Mute, pin, or lower a hand from each row.';
    empty.append(emptyTitle, emptyHint);
    pane.append(empty);
    return;
  }
  for (const person of view.roster) {
    const row = document.createElement('div');
    row.className = 'person';
    const main = document.createElement('div');
    main.className = 'person-main';
    const name = document.createElement('strong');
    name.textContent = person.displayName;
    main.append(name);
    const metaText = [person.rollNumber, person.gradeDivision].filter(Boolean).join(' · ');
    if (metaText) {
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = metaText;
      main.append(meta);
    }
    const chips = document.createElement('div');
    chips.className = 'chips';
    for (const chip of personChips(person)) chips.append(chipEl(chip.text, chip.kind));
    main.append(chips);
    const focus = focusLabel(person.focus);
    if (focus) {
      const line = document.createElement('div');
      line.className = isFocusAlert(person.focus) ? 'focus' : 'meta';
      line.textContent = focus;
      main.append(line);
    }
    const actions = document.createElement('div');
    actions.className = 'person-actions';
    const mute = document.createElement('button');
    mute.className = 'btn';
    mute.type = 'button';
    mute.textContent = person.mutedByTeacher ? 'Allow unmute' : 'Mute';
    mute.addEventListener('click', () => controller?.handle({ type: 'mute-one', id: person.id, muted: !person.mutedByTeacher }));
    const pin = document.createElement('button');
    pin.className = 'btn';
    pin.type = 'button';
    pin.textContent = person.pinned ? 'Unpin' : 'Pin';
    pin.setAttribute('aria-label', person.pinned ? `Unpin ${person.displayName}'s video` : `Pin ${person.displayName}'s video`);
    pin.addEventListener('click', () => controller?.handle({ type: 'pin', id: person.id, pinned: !person.pinned }));
    actions.append(mute, pin);
    if (person.handRaised) {
      const lower = document.createElement('button');
      lower.className = 'btn';
      lower.type = 'button';
      lower.textContent = 'Lower hand';
      lower.addEventListener('click', () => controller?.handle({ type: 'lower-hand', id: person.id }));
      actions.append(lower);
    }
    main.append(actions);
    row.append(avatarEl(person.displayName), main);
    pane.append(row);
  }
}

function paintChat(view: ClassView): void {
  const pane = document.getElementById('pane-chat');
  if (!pane) return;
  let log = pane.querySelector('.log') as HTMLElement | null;
  let select = pane.querySelector('select') as HTMLSelectElement | null;
  if (!chatBuilt || !log || !select) {
    chatBuilt = true;
    pane.replaceChildren();
    const wrap = document.createElement('div');
    wrap.className = 'chat-wrap';
    const top = document.createElement('div');
    top.className = 'chat-top';
    const toLabel = document.createElement('label');
    toLabel.className = 'hint';
    toLabel.htmlFor = 'chat-to';
    toLabel.textContent = 'To';
    select = document.createElement('select');
    select.id = 'chat-to';
    top.append(toLabel, select);
    const hands = document.createElement('div');
    hands.className = 'hands';
    hands.setAttribute('aria-label', 'Raised hands');
    log = document.createElement('div');
    log.className = 'log';
    const form = document.createElement('form');
    form.className = 'chat-form';
    const input = document.createElement('input');
    input.maxLength = 2000;
    input.placeholder = 'Write a message…';
    input.setAttribute('aria-label', 'Message');
    const go = document.createElement('button');
    go.className = 'btn primary';
    go.type = 'submit';
    go.textContent = 'Send';
    go.setAttribute('aria-label', 'Send message');
    form.append(input, go);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text || !select) return;
      controller?.handle({ type: 'send-chat', text, to: select.value });
      input.value = '';
    });
    select.addEventListener('change', () => {
      if (select) controller?.handle({ type: 'chat-to', to: select.value });
    });
    wrap.append(top, hands, log, form);
    pane.append(wrap);
  }
  const hands = pane.querySelector('.hands');
  if (hands) {
    hands.replaceChildren();
    const raised = sortRoster(view.roster.filter((p) => p.role === 'STUDENT' && p.handRaised));
    for (const person of raised) {
      const pair = document.createElement('span');
      pair.className = 'hand-pair';
      const name = document.createElement('button');
      name.className = 'btn';
      name.type = 'button';
      name.textContent = `✋ ${person.displayName}`;
      name.addEventListener('click', () => {
        controller?.handle({ type: 'chat-to', to: person.id });
        (pane.querySelector('input') as HTMLInputElement | null)?.focus();
      });
      const lower = document.createElement('button');
      lower.className = 'btn';
      lower.type = 'button';
      lower.textContent = 'Lower';
      lower.setAttribute('aria-label', `Lower ${person.displayName}'s hand`);
      lower.addEventListener('click', () => controller?.handle({ type: 'lower-hand', id: person.id }));
      pair.append(name, lower);
      hands.append(pair);
    }
  }
  const previous = stickyChatRecipient(view.chatTo, select.value);
  select.replaceChildren();
  const everyone = document.createElement('option');
  everyone.value = 'all';
  everyone.textContent = 'Everyone';
  select.append(everyone);
  for (const person of view.roster) {
    const opt = document.createElement('option');
    opt.value = person.id;
    opt.textContent = person.displayName;
    select.append(opt);
  }
  select.value = [...select.options].some((o) => o.value === previous) ? previous : 'all';
  const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 80 || view.messages.length !== paintedMessages;
  paintedMessages = view.messages.length;
  log.replaceChildren();
  for (const message of view.messages) {
    const mine = !!view.meId && message.senderParticipantId === view.meId;
    const row = document.createElement('div');
    row.className = 'msg' + (mine ? ' mine' : '') + (message.scope === 'DIRECT' ? ' direct' : '');
    const top = document.createElement('div');
    top.className = 'msg-top';
    const who = document.createElement('strong');
    who.textContent = message.senderName;
    const badge = scopeBadge(message.scope);
    top.append(avatarEl(message.senderName, true), who, chipEl(badge.text, badge.kind));
    row.append(top);
    if (message.scope === 'DIRECT' && message.recipientName) {
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = `to ${message.recipientName}`;
      row.append(meta);
    }
    const body = document.createElement('p');
    body.className = 'bubble';
    body.textContent = message.body;
    row.append(body);
    const replyTo = replyTargetFor(message, view.meId);
    if (replyTo) {
      const reply = document.createElement('button');
      reply.className = 'btn';
      reply.type = 'button';
      reply.textContent = 'Reply';
      const name = message.senderRole === 'STUDENT' ? message.senderName : message.recipientName || 'student';
      reply.setAttribute('aria-label', `Reply to ${name}`);
      reply.addEventListener('click', () => {
        controller?.handle({ type: 'chat-to', to: replyTo });
        (pane.querySelector('input') as HTMLInputElement | null)?.focus();
      });
      row.append(reply);
    }
    log.append(row);
  }
  if (!view.messages.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const emptyTitle = document.createElement('p');
    emptyTitle.className = 'empty-title';
    emptyTitle.textContent = 'No messages yet';
    const emptyHint = document.createElement('p');
    emptyHint.className = 'hint';
    emptyHint.textContent = 'Broadcast to everyone, or choose a student for a direct message.';
    empty.append(emptyTitle, emptyHint);
    log.append(empty);
  }
  if (stick) log.scrollTop = log.scrollHeight;
}

async function openShare(): Promise<void> {
  const dialog = document.getElementById('share-dialog') as HTMLDialogElement | null;
  if (!dialog || !controller) return;
  const [sources, displays] = await Promise.all([api.listSources(), api.displays()]);
  dialog.replaceChildren();
  const title = document.createElement('h2');
  title.textContent = 'Share';
  const screens = document.createElement('div');
  screens.className = 'source-grid';
  const windows = document.createElement('div');
  windows.className = 'source-grid';
  const screenSources = sources.filter((s) => s.kind === 'screen');
  const windowSources = sources.filter((s) => s.kind === 'window' && isOfferedShareWindow(s.name));
  let matched = false;
  for (const display of displays) {
    const source = screenSources.find((s) => s.displayId === String(display.id));
    if (!source) continue;
    matched = true;
    screens.append(screenButtons(source, display));
  }
  if (!matched) {
    for (const source of screenSources) screens.append(sourceButton(source, null));
  }
  for (const source of windowSources) windows.append(sourceButton(source, null));
  const consent = document.createElement('p');
  consent.textContent =
    'Students will see the whole monitor. The control panel, roster, messages, videos, and the main window stay out of the picture. Drawings stay in. Nothing is shared until you press Share.';
  const audioLabel = document.createElement('label');
  const audio = document.createElement('input');
  audio.type = 'checkbox';
  audio.id = 'share-audio';
  audioLabel.append(audio, document.createTextNode(' Include system audio. The extra video from that request is discarded.'));
  const close = document.createElement('button');
  close.className = 'btn';
  close.type = 'button';
  close.textContent = 'Close';
  close.addEventListener('click', () => dialog.close());
  const hScreens = document.createElement('h2');
  hScreens.textContent = 'Screens';
  const hWindows = document.createElement('h2');
  hWindows.textContent = 'Windows';
  const windowNote = document.createElement('p');
  windowNote.className = 'hint';
  windowNote.textContent =
    'Choosing a window shares that window’s whole monitor, so drawings on it are included. Classroom windows are still left out by Windows.';
  dialog.append(title, consent, audioLabel, hScreens, screens, hWindows, windowNote, windows, close);
  dialog.showModal();
}

function screenButtons(source: SourceInfo, display: DisplayInfo): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'stack';
  wrap.append(thumb(source));
  const share = document.createElement('button');
  share.className = 'btn primary';
  share.type = 'button';
  share.textContent = source.name || 'Whole screen';
  share.addEventListener('click', () => {
    closeShare();
    void controller?.beginShare({
      kind: 'screen',
      source: { id: source.id, displayId: source.displayId, name: source.name, kind: 'screen' },
      display: { x: display.x, y: display.y, w: display.w, h: display.h },
      region: null,
      systemAudio: (document.getElementById('share-audio') as HTMLInputElement | null)?.checked === true,
    });
  });
  const region = document.createElement('button');
  region.className = 'btn';
  region.type = 'button';
  region.textContent = 'Region';
  region.addEventListener('click', () => {
    closeShare();
    const systemAudio = (document.getElementById('share-audio') as HTMLInputElement | null)?.checked === true;
    void controller?.shareRegion(display, { id: source.id, displayId: source.displayId, name: source.name, kind: 'screen' }, systemAudio);
  });
  wrap.append(share, region);
  return wrap;
}

function sourceButton(source: SourceInfo, display: DisplayInfo | null): HTMLElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.append(thumb(source));
  const label = document.createElement('span');
  label.textContent = source.name || (source.kind === 'screen' ? 'Screen' : 'Window');
  button.append(label);
  button.addEventListener('click', () => {
    closeShare();
    void controller?.beginShare({
      kind: source.kind,
      source: { id: source.id, displayId: source.displayId, name: source.name, kind: source.kind },
      display: display ? { x: display.x, y: display.y, w: display.w, h: display.h } : null,
      region: null,
      systemAudio: (document.getElementById('share-audio') as HTMLInputElement | null)?.checked === true,
    });
  });
  return button;
}

function thumb(source: SourceInfo): HTMLElement {
  if (!source.thumbnail) {
    const empty = document.createElement('div');
    empty.className = 'hint';
    empty.textContent = source.name;
    return empty;
  }
  const img = document.createElement('img');
  img.alt = '';
  img.src = source.thumbnail;
  return img;
}

function closeShare(): void {
  (document.getElementById('share-dialog') as HTMLDialogElement | null)?.close();
}

void bootApp();
