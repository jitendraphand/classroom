import type { BootInfo, DisplayInfo, SourceInfo, TeacherAction } from '../shared/actions';
import {
  adhocBody,
  campusesOf,
  classStartLabel,
  classStatus,
  gradeOptionLabel,
  parseSchedule,
  passwordProblem,
  type ClassChoice,
  type GradeChoice,
} from '../shared/apiModel';
import { dockGridStyle, isOfferedShareWindow } from '../shared/capture';
import { endedSessionCopy, isEndedReason } from '../shared/session';
import { isFocusAlert } from '../shared/session';
import type { SlotCount } from '../shared/classLogic';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { desktop } from './bridge';
import { ClassController, type ClassView } from './classSession';
import { ICONS, type IconName } from './icons';
import { ChatView, RosterView } from './teacherViews';

const app = document.getElementById('app')!;
const api = desktop();
let boot: BootInfo | null = null;
let controller: ClassController | null = null;
let unsubAction: (() => void) | null = null;
let dockEl: HTMLElement | null = null;

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


let activePane = 'pane-roster';

function clearController(): void {
  unsubAction?.();
  unsubAction = null;
  dockEl = null;
  controller?.destroy();
  controller = null;
  dropPanes();
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

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text) node.textContent = text;
  return node;
}

function fmtDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function fmtTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** A web-style card: title, subtitle, body. */
function card(title: string, subtitle: string): { root: HTMLElement; body: HTMLElement } {
  const root = el('section', 'dash-card');
  const head = el('header', 'dash-card-head');
  head.append(el('h2', '', title));
  if (subtitle) head.append(el('p', 'hint', subtitle));
  const body = el('div', 'dash-card-body');
  root.append(head, body);
  return { root, body };
}

/**
 * Home: the website's teacher dashboard (same sections, labels and badges):
 * Signed in as · Class live / Rejoin live class · Today · Coming up · Ad-hoc
 * class (campus → grade → division checkboxes).
 */
async function showHome(): Promise<void> {
  clearController();
  app.innerHTML = `
    <div class="home">
      <header class="home-top">
        <p class="brand">Classroom <span class="hint">Teacher dashboard</span></p>
        <div class="home-actions" id="home-actions"></div>
      </header>
      <div class="home-who">
        <p class="hint">Signed in as</p>
        <h1 id="home-name"></h1>
        <p class="hint" id="home-email"></p>
      </div>
      <p class="err" id="home-err" role="alert"></p>
      <div id="home-live"></div>
      <div id="home-today"></div>
      <div id="home-later"></div>
      <div id="home-adhoc"></div>
      <p class="hint" id="home-tz"></p>
    </div>`;
  const nameEl = document.getElementById('home-name');
  if (nameEl) nameEl.textContent = boot?.me?.name || boot?.email || 'Teacher';
  const emailEl = document.getElementById('home-email');
  if (emailEl) emailEl.textContent = boot?.me?.email || boot?.email || '';
  const actions = document.getElementById('home-actions')!;
  const pw = el('button', 'btn ghost sm', 'Change password');
  pw.type = 'button';
  pw.addEventListener('click', () => showPassword(''));
  const out = el('button', 'btn sm', 'Log out');
  out.type = 'button';
  out.addEventListener('click', async () => {
    await api.logout();
    if (boot) boot.me = null;
    showLogin('');
  });
  actions.append(pw, out);
  const homeErr = document.getElementById('home-err')!;
  const res = await api.api('GET', '/api/teacher/schedule');
  if (res.status === 401) {
    showLogin('Sign in again to continue.');
    return;
  }
  if (res.status !== 200) {
    homeErr.textContent = 'Could not load the timetable.';
    return;
  }
  const schedule = parseSchedule(res.data);
  const tz = document.getElementById('home-tz');
  if (tz && schedule.timezone) tz.textContent = `Times shown in your device’s time zone; the school timetable uses ${schedule.timezone}.`;
  if (schedule.activeCode) {
    const live = el('div', 'live-card');
    const copy = el('div');
    copy.append(el('span', 'badge-tone success pulse', 'Class live'), el('p', 'live-title', schedule.activeLabel || 'Class'));
    const side = el('div', 'live-side');
    const rejoin = el('button', 'btn primary', 'Rejoin live class');
    rejoin.type = 'button';
    rejoin.addEventListener('click', () => join(schedule.activeCode!));
    side.append(rejoin, el('p', 'hint', 'Open on another device? Rejoining moves the class here.'));
    live.append(copy, side);
    document.getElementById('home-live')?.append(live);
  }
  const today = schedule.classes.filter((c) => c.date === schedule.today);
  const later = schedule.classes.filter((c) => c.date !== schedule.today && c.mine);
  const todayCard = card(
    'Today',
    `${fmtDate(schedule.today)}${schedule.earlyMinutes != null ? ` · the waiting room opens ${schedule.earlyMinutes} min before each class` : ''}`
  );
  if (!today.length) todayCard.body.append(el('p', 'hint', 'No timetabled classes today. You can start an ad-hoc class below.'));
  else {
    const list = el('ul', 'class-list');
    for (const item of today) list.append(classRow(item, homeErr));
    todayCard.body.append(list);
  }
  document.getElementById('home-today')?.append(todayCard.root);
  if (later.length) {
    const byDate = new Map<string, ClassChoice[]>();
    for (const item of later) byDate.set(item.date, [...(byDate.get(item.date) ?? []), item]);
    const laterCard = card('Coming up', 'Next 6 days');
    for (const [date, items] of [...byDate.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const block = el('div', 'later-day');
      block.append(el('p', 'later-date', fmtDate(date)));
      const list = el('ul', 'later-list');
      for (const c of items) {
        const li = el('li');
        li.append(el('span', 'mono', `${c.startLabel}–${c.endLabel}`), el('strong', '', c.subject), el('span', '', c.audience));
        if (c.substituteFor) li.append(el('span', 'amber', `substituting for ${c.substituteFor}`));
        if (c.extra) li.append(el('span', 'green', 'extra class'));
        list.append(li);
      }
      block.append(list);
      laterCard.body.append(block);
    }
    document.getElementById('home-later')?.append(laterCard.root);
  }
  document.getElementById('home-adhoc')?.append(adHocForm(schedule.grades, schedule.gradesConfigured, homeErr));
}

function classRow(c: ClassChoice, err: HTMLElement): HTMLElement {
  const li = el('li', c.live ? 'class-row live' : 'class-row');
  const main = el('div', 'class-main');
  main.append(el('p', 'mono', `${c.startLabel}–${c.endLabel}`));
  const title = el('p', 'class-title', c.subject);
  if (c.audience) title.append(el('span', 'hint', ` · ${c.audience}`));
  main.append(title);
  const meta = el('div', 'class-meta');
  const status = classStatus(c, fmtTime);
  meta.append(el('span', `badge-tone ${status.tone}${status.pulse ? ' pulse' : ''}`, status.text));
  if (c.substituteFor) meta.append(el('span', 'amber', `Substituting for ${c.substituteFor}`));
  if (c.extra) meta.append(el('span', 'green', 'Extra class'));
  if (c.note) meta.append(el('span', '', c.note));
  main.append(meta);
  li.append(main);
  if (c.mine) {
    const btn = el('button', 'btn primary', classStartLabel(c));
    btn.type = 'button';
    btn.disabled = !c.canStart;
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = 'Opening…';
      void startScheduled(c.key, err).finally(() => {
        if (!btn.isConnected) return;
        btn.disabled = !c.canStart;
        btn.textContent = classStartLabel(c);
      });
    });
    li.append(btn);
  }
  return li;
}

function adHocForm(grades: GradeChoice[], gradesConfigured: boolean, err: HTMLElement): HTMLElement {
  const box = card(
    'Ad-hoc class',
    'Outside the timetable, for your assigned grades and divisions only. Students of those divisions are routed here from the school app.'
  );
  if (!grades.length) {
    box.body.append(el('p', 'hint', 'No grades are assigned to you yet. Ask the school administrator.'));
    return box.root;
  }
  const state = { campus: '', grade: '', divisions: [] as string[], all: false, extra: '' };
  const form = el('form', 'adhoc-form');
  const grid = el('div', 'adhoc-grid');
  const campus = el('select');
  campus.id = 'adhoc-campus';
  campus.setAttribute('aria-label', 'Campus');
  const grade = el('select');
  grade.id = 'adhoc-grade';
  const subject = el('input');
  subject.id = 'adhoc-subject';
  subject.maxLength = 80;
  subject.placeholder = 'e.g. Revision';
  grid.append(field('Campus', 'adhoc-campus', campus), field('Grade', 'adhoc-grade', grade), field('Subject / title', 'adhoc-subject', subject));
  const fs = el('fieldset', 'adhoc-divs');
  fs.append(el('legend', '', 'Divisions'));
  const divRow = el('div', 'div-checks');
  const extra = el('input', 'adhoc-extra');
  extra.placeholder = 'Divisions, e.g. A, C';
  extra.setAttribute('aria-label', 'Divisions');
  extra.addEventListener('input', () => (state.extra = extra.value));
  fs.append(divRow, extra);
  const max = el('input');
  max.id = 'adhoc-max';
  max.type = 'number';
  max.min = '1';
  max.max = '6';
  max.value = String(Math.min(6, Math.max(1, boot ? boot.layout - 1 : 3)));
  const maxField = field('Max visible student videos', 'adhoc-max', max);
  maxField.classList.add('narrow');
  maxField.append(el('p', 'hint', 'Only this many student camera streams reach you. Others stay local-only on their devices.'));
  const go = el('button', 'btn primary', 'Start ad-hoc class');
  go.type = 'submit';
  const campuses = campusesOf(grades);
  for (const c of campuses) {
    const opt = el('option', '', c || '—');
    opt.value = c;
    campus.append(opt);
  }
  const choice = () => grades.find((g) => g.campus === state.campus && g.grade === state.grade);
  // Tick the first division by default (Start used to do nothing visible with every box unticked).
  const defaultDivisions = () => {
    const first = choice()?.divisions?.[0]?.name;
    return first ? [first] : [];
  };
  // Validation / start errors right next to the Start button, not only at the page top.
  const formErr = el('p', 'err form-error');
  formErr.setAttribute('role', 'alert');
  formErr.hidden = true;
  const showErr = (msg: string) => {
    formErr.textContent = msg;
    formErr.hidden = !msg;
  };
  const paintDivs = () => {
    const g = choice();
    divRow.replaceChildren();
    for (const d of g?.divisions ?? []) {
      const lab = el('label', 'check');
      const box = el('input');
      box.type = 'checkbox';
      box.disabled = state.all;
      box.checked = state.divisions.includes(d.name);
      box.addEventListener('change', () => {
        showErr('');
        state.divisions = box.checked ? [...state.divisions, d.name] : state.divisions.filter((x) => x !== d.name);
      });
      lab.append(box, document.createTextNode(`${state.grade}-${d.label}`));
      divRow.append(lab);
    }
    if (g?.whole) {
      const lab = el('label', 'check');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = state.all;
      box.addEventListener('change', () => {
        state.all = box.checked;
        paintDivs();
      });
      lab.append(box, document.createTextNode(`All divisions of grade ${state.grade}`));
      divRow.append(lab);
    }
    extra.hidden = !(g?.whole && !gradesConfigured && !state.all);
  };
  const fillGrades = () => {
    grade.replaceChildren();
    const list = grades.filter((g) => g.campus === state.campus);
    for (const g of list) {
      const opt = el('option', '', gradeOptionLabel(g));
      opt.value = g.grade;
      grade.append(opt);
    }
    state.grade = list[0]?.grade ?? '';
    grade.value = state.grade;
    state.divisions = defaultDivisions();
    state.all = false;
    state.extra = '';
    extra.value = '';
    paintDivs();
  };
  state.campus = campuses[0] ?? '';
  campus.value = state.campus;
  campus.addEventListener('change', () => {
    state.campus = campus.value;
    fillGrades();
  });
  grade.addEventListener('change', () => {
    state.grade = grade.value;
    state.divisions = defaultDivisions();
    state.all = false;
    state.extra = '';
    extra.value = '';
    paintDivs();
  });
  fillGrades();
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    err.textContent = '';
    const g = choice();
    const built = adhocBody({
      ...state,
      subject: subject.value,
      freeTextExtra: !!g?.whole && !gradesConfigured,
    });
    if ('error' in built) {
      showErr(built.error);
      return;
    }
    showErr('');
    const maxVisible = Math.min(6, Math.max(1, Math.round(Number(max.value)) || 3));
    go.disabled = true;
    go.textContent = 'Starting…';
    void startClass({ ...built.body, maxVisibleVideos: maxVisible }, err).finally(() => {
      if (!go.isConnected) return;
      if (err.textContent) showErr(err.textContent);
      go.disabled = false;
      go.textContent = 'Start ad-hoc class';
    });
  });
  form.append(grid, fs, maxField, formErr, go);
  box.body.append(form);
  return box.root;
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

async function startScheduled(key: string, err: HTMLElement): Promise<void> {
  await startClass({ kind: 'scheduled', key, maxVisibleVideos: boot ? Math.min(6, Math.max(1, boot.layout - 1)) : 3 }, err);
}

async function startClass(body: Record<string, unknown>, err: HTMLElement): Promise<void> {
  err.textContent = '';
  const res = await api.api('POST', '/api/teacher/sessions/start', body);
  const code = res.data && typeof res.data === 'object' && 'code' in res.data ? String((res.data as { code: unknown }).code) : '';
  if (res.status >= 400 || !code) {
    err.textContent = textOf(res.data, 'Could not start the class');
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
  dropPanes();
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
  dropPanes();
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
  document.getElementById('btn-restart-share')?.toggleAttribute('hidden', !view.shareStopped || view.sharing);
  const banner = document.getElementById('audio-banner');
  if (banner) banner.hidden = !view.audioBlocked;
  const hands = view.roster.filter((p) => p.handRaised).length;
  setPressed('btn-mic', view.micOn);
  setPressed('btn-cam', view.camOn);
  document.getElementById('btn-mic')?.classList.toggle('danger', !view.micOn);
  document.getElementById('btn-cam')?.classList.toggle('danger', !view.camOn);
  setGlyph('btn-mic', view.micOn ? 'mic' : 'micOff');
  setGlyph('btn-cam', view.camOn ? 'cam' : 'camOff');
  setLabel('btn-mic', view.micOn ? 'Mute microphone' : 'Unmute microphone');
  setLabel('btn-cam', view.camOn ? 'Turn camera off' : 'Turn camera on');
  setLabel('btn-open-chat', activePane === 'pane-chat' ? 'Chat (open)' : 'Open chat');
  setLabel('btn-open-roster', hands > 0 ? `Open roster (${hands} raised ${hands === 1 ? 'hand' : 'hands'})` : 'Open roster');
  // Home bar: the board button starts / stops whiteboard sharing.
  setPressed('btn-board', !!view.whiteboardOn);
  setLabel('btn-board', view.whiteboardOn ? 'Stop whiteboard sharing' : 'Share a whiteboard (students see it live)');
  document.getElementById('btn-share')?.toggleAttribute('hidden', view.sharing);
  document.getElementById('btn-stop')?.toggleAttribute('hidden', !view.sharing);
  document.getElementById('btn-end')?.toggleAttribute('hidden', view.sharing);
  for (const n of [2, 4, 6] as const) setPressed(`layout-${n}`, view.layout === n);
  const focusN = view.roster.filter((p) => isFocusAlert(p.focus)).length;
  const rosterN = hands + view.waiting.length + focusN;
  setBadge('badge-chat', view.unread);
  setBadge('badge-chat-tab', view.unread);
  setBadge('badge-roster', rosterN);
  setBadge('badge-roster-tab', view.waiting.length);
  document.getElementById('btn-open-chat')?.classList.toggle('on', activePane === 'pane-chat');
  document.getElementById('btn-open-roster')?.classList.toggle('on', activePane === 'pane-roster');
  paintPanes();
  if (activePane === 'pane-chat' && view.unread > 0 && document.hasFocus()) controller?.handle({ type: 'mark-chat-read' });
  const dock = document.getElementById('dock-grid');
  if (dock) {
    dock.hidden = view.sharing;
    applyDockSize(dock, view.layout);
  }
}

function buildClass(): void {
  dropPanes();
  activePane = 'pane-roster';
  app.innerHTML = `
    <div class="screen" id="class-screen">
      <header class="top">
        <div class="who">
          <strong id="class-label">Class</strong>
          <span class="code-pill" id="class-code"></span>
        </div>
        <span class="conn" id="class-conn"></span>
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
          ${sym('btn-share', 'share', 'Share screen')}
          ${sym('btn-stop', 'stop', 'Stop sharing screen', 'danger')}
          ${sym('btn-board', 'board', 'Share a whiteboard (students see it live)')}
          ${symCount('btn-open-chat', 'chat', 'Open chat', 'badge-chat')}
          ${symCount('btn-open-roster', 'people', 'Open roster', 'badge-roster')}
          <span class="bar-div"></span>
          <div class="seg" role="group" aria-label="Videos on screen">
            <button class="sym texty" id="layout-2" type="button" title="Show 2 videos, including you" aria-label="Show 2 videos, including you">2</button>
            <button class="sym texty" id="layout-4" type="button" title="Show 4 videos, including you" aria-label="Show 4 videos, including you">4</button>
            <button class="sym texty" id="layout-6" type="button" title="Show 6 videos, including you" aria-label="Show 6 videos, including you">6</button>
          </div>
          <button class="btn sm warn" id="btn-mute" type="button">Mute all</button>
          <button class="btn sm" id="btn-allow" type="button">Unmute all</button>
          ${sym('btn-leave', 'leave', 'Leave class', 'danger')}
          <button class="btn sm danger" id="btn-end" type="button">End class</button>
        </div>
        <p class="err" id="notice"></p>
        <button type="button" class="btn primary share-stopped" id="btn-restart-share" hidden>Share stopped — click to restart</button>
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
  for (const n of [2, 4, 6] as const) {
    document.getElementById(`layout-${n}`)?.addEventListener('click', () => {
      if (boot) boot.layout = n;
      controller?.handle({ type: 'layout', slots: n });
    });
  }
  document.getElementById('btn-share')?.addEventListener('click', () => void openShare());
  document.getElementById('btn-restart-share')?.addEventListener('click', () => void controller?.restartShare());
  document.getElementById('btn-stop')?.addEventListener('click', act('stop-share'));
  document.getElementById('btn-board')?.addEventListener('click', act('toggle-whiteboard'));
  document.getElementById('btn-open-chat')?.addEventListener('click', () => showPane('pane-chat', 'tab-chat'));
  document.getElementById('btn-open-roster')?.addEventListener('click', () => showPane('pane-roster', 'tab-roster'));
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
  paintPanes();
}

/*
 * Roster and chat panes: the same React views as the floating People /
 * Messages windows (teacherViews.tsx), so the class window, the panels and
 * the website all look alike. Only the visible pane re-renders, and React
 * diffs instead of rebuilding the DOM on every class update.
 */
let paneRoots: { host: HTMLElement; root: Root }[] = [];

function paneRoot(id: string): Root | null {
  const host = document.getElementById(id);
  if (!host) return null;
  const hit = paneRoots.find((r) => r.host === host);
  if (hit) return hit.root;
  const root = createRoot(host);
  paneRoots.push({ host, root });
  return root;
}

function dropPanes(): void {
  const old = paneRoots;
  paneRoots = [];
  for (const r of old) {
    try {
      r.root.unmount();
    } catch {
      /* already detached */
    }
  }
}

function paintPanes(): void {
  if (!controller) return;
  const snap = controller.panelSnapshot();
  const send = (action: TeacherAction) => controller?.handle(action);
  if (activePane === 'pane-roster') paneRoot('pane-roster')?.render(createElement(RosterView, { snap, send }));
  else paneRoot('pane-chat')?.render(createElement(ChatView, { snap, send }));
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
  audioLabel.className = 'check';
  audioLabel.append(audio, document.createTextNode(' Share audio (sound from your computer, for playing a video). Video mode turns it on too.'));
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
