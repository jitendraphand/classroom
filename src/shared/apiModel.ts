/**
 * Cookie, schedule, chat, and password helpers shared by the main process
 * and the tests. No I/O.
 */

export const DEFAULT_SERVER = 'https://13-201-89-150.sslip.io';

export const DEFAULT_HOTKEYS = {
  mic: 'CommandOrControl+Shift+M',
  camera: 'CommandOrControl+Shift+V',
  stopShare: 'CommandOrControl+Shift+S',
} as const;

export type HotkeyName = keyof typeof DEFAULT_HOTKEYS;

/** Teacher session cookie pair from a Set-Cookie header list. */
export function teacherCookieFromSetCookie(lines: readonly string[]): { present: boolean; value: string | null } {
  for (const line of lines) {
    const first = line.split(';')[0] ?? '';
    const host = first.startsWith('__Host-classroom_teacher=');
    const plain = first.startsWith('classroom_teacher=');
    if (!host && !plain) continue;
    const value = first.slice(first.indexOf('=') + 1);
    return { present: true, value: value ? first : null };
  }
  return { present: false, value: null };
}

export function isSafeApiPath(path: string): boolean {
  if (!path.startsWith('/api/')) return false;
  if (path.includes('://') || path.includes('..') || path.includes('\\')) return false;
  return true;
}

export function normalizeServer(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  return `${url.protocol}//${url.host}`;
}

export const MIN_PASSWORD_LENGTH = 10;

export function passwordProblem(pw: string, opts: { email?: string; current?: string } = {}): string | null {
  if (pw.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (pw.length > 128) return 'Password is too long.';
  if (opts.current && pw === opts.current) return 'Choose a password different from the current one.';
  const local = opts.email?.split('@')[0] ?? '';
  if (local.length >= 4 && pw.toLowerCase().includes(local.toLowerCase())) {
    return 'Do not include your email name in the password.';
  }
  if (/^(.)\1+$/.test(pw) || /^(password|12345)/i.test(pw)) return 'That password is too easy to guess.';
  return null;
}

export type ChatMessage = {
  id: string;
  senderParticipantId: string;
  senderName: string;
  senderRole: string;
  body: string;
  scope: string;
  recipientParticipantId: string | null;
  recipientName: string | null;
  createdAt: string;
};

export function mergeMessages(existing: readonly ChatMessage[], incoming: readonly ChatMessage[]): ChatMessage[] {
  const map = new Map<string, ChatMessage>();
  for (const m of existing) map.set(m.id, m);
  for (const m of incoming) map.set(m.id, m);
  return [...map.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id.localeCompare(b.id)));
}

export function unreadCount(
  messages: readonly ChatMessage[],
  lastReadIso: string | null,
  myParticipantId: string | null
): number {
  return messages.filter((m) => {
    if (myParticipantId && m.senderParticipantId === myParticipantId) return false;
    if (!lastReadIso) return true;
    return m.createdAt > lastReadIso;
  }).length;
}

export type GradeChoice = {
  /** Campus code (the web dashboard picks campus first, then grade). */
  campus: string;
  grade: string;
  label: string;
  whole: boolean;
  divisions: { name: string; label: string }[];
};

export type ClassChoice = {
  key: string;
  date: string;
  subject: string;
  audience: string;
  timeLabel: string;
  canStart: boolean;
  live: boolean;
  mine: boolean;
  phase: string;
  note: string | null;
  startLabel: string;
  endLabel: string;
  opensAt: string | null;
  coveredBy: string | null;
  substituteFor: string | null;
  extra: boolean;
  sessionStarted: boolean;
  sessionEnded: boolean;
};

export type StatusTone = 'success' | 'neutral' | 'sky';

/** The status badge the web dashboard's ClassRow shows (same order and words). */
export function classStatus(c: ClassChoice, fmtTime: (iso: string | null) => string = (iso) => iso ?? ''): { text: string; tone: StatusTone; pulse: boolean } {
  if (!c.mine) return { text: `Covered by ${c.coveredBy ?? 'another teacher'}`, tone: 'neutral', pulse: false };
  if (c.live) return { text: 'Live', tone: 'success', pulse: true };
  if (c.sessionEnded && c.phase !== 'past') return { text: 'Ended · can reopen', tone: 'neutral', pulse: false };
  if (c.phase === 'open') return { text: 'Open now', tone: 'success', pulse: false };
  if (c.phase === 'upcoming') return { text: `Opens ${fmtTime(c.opensAt)}`, tone: 'sky', pulse: false };
  return { text: c.sessionStarted ? 'Held' : 'Not held', tone: 'neutral', pulse: false };
}

/** The web dashboard's start button label. */
export function classStartLabel(c: ClassChoice): string {
  if (c.live) return 'Re-enter';
  if (c.sessionStarted && !c.sessionEnded) return 'Re-enter';
  return 'Start class';
}

/** Ad-hoc form: campuses (first seen order), then that campus's grades. */
export function campusesOf(grades: readonly GradeChoice[]): string[] {
  return [...new Set(grades.map((g) => g.campus))];
}

export function gradeOptionLabel(g: GradeChoice): string {
  return g.label !== g.grade ? `${g.label} (${g.grade})` : g.grade;
}

/**
 * The web dashboard's ad-hoc request body. Free-text extra divisions only
 * count before Grades & divisions is set up. Returns an error string when no
 * division is picked.
 */
export function adhocBody(input: {
  campus: string;
  grade: string;
  divisions: readonly string[];
  all: boolean;
  extra: string;
  subject: string;
  freeTextExtra: boolean;
}): { error: string } | { body: { kind: 'adhoc'; campus: string; grade: string; divisions: string[]; allDivisions: boolean; subject?: string } } {
  const extra = (input.freeTextExtra ? input.extra : '')
    .split(/[,\s]+/)
    .map((d) => d.trim())
    .filter(Boolean);
  const divisions = [...input.divisions.filter((d) => d !== '*'), ...extra];
  if (!input.grade) return { error: 'Choose a grade.' };
  if (!input.all && !divisions.length) return { error: 'Tick at least one division (or "All divisions") to start the class.' };
  const subject = input.subject.trim();
  return {
    body: {
      kind: 'adhoc',
      campus: input.campus,
      grade: input.grade,
      divisions,
      allDivisions: input.all,
      ...(subject ? { subject } : {}),
    },
  };
}

export type ParsedSchedule = {
  today: string;
  timezone: string;
  activeCode: string | null;
  activeLabel: string | null;
  classes: ClassChoice[];
  grades: GradeChoice[];
  /** False before the admin set up Grades & divisions (free-text extra divisions allowed then). */
  gradesConfigured: boolean;
  earlyMinutes: number | null;
};

type RawDiv = { name?: string; label?: string } | string;

export function parseSchedule(data: unknown): ParsedSchedule {
  const d = (data ?? {}) as Record<string, unknown>;
  const today = typeof d.today === 'string' ? d.today : '';
  const timezone = typeof d.timezone === 'string' ? d.timezone : '';
  const classesRaw = Array.isArray(d.classes) ? d.classes : [];
  const classes: ClassChoice[] = [];
  for (const item of classesRaw) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    const session = c.session && typeof c.session === 'object' ? (c.session as Record<string, unknown>) : null;
    const covered = typeof c.coveredBy === 'string' ? c.coveredBy : null;
    const sub = typeof c.substituteFor === 'string' ? c.substituteFor : null;
    classes.push({
      key: String(c.key ?? ''),
      date: String(c.date ?? ''),
      subject: String(c.subject ?? 'Class'),
      audience: String(c.audience ?? ''),
      timeLabel: `${String(c.startLabel ?? '')}–${String(c.endLabel ?? '')}`,
      canStart: c.canStart === true,
      live: session?.live === true,
      mine: c.mine !== false,
      phase: String(c.phase ?? ''),
      note: typeof c.note === 'string' ? c.note : null,
      startLabel: String(c.startLabel ?? ''),
      endLabel: String(c.endLabel ?? ''),
      opensAt: typeof c.opensAt === 'string' ? c.opensAt : null,
      coveredBy: covered,
      substituteFor: sub,
      extra: c.extra === true,
      sessionStarted: !!session?.startedAt,
      sessionEnded: !!session?.endedAt,
    });
  }
  const gradesRaw = Array.isArray(d.gradeChoices) ? d.gradeChoices : [];
  const grades: GradeChoice[] = [];
  for (const item of gradesRaw) {
    if (!item || typeof item !== 'object') continue;
    const g = item as Record<string, unknown>;
    const name = String(g.grade ?? g.name ?? '');
    if (!name) continue;
    const divs = Array.isArray(g.divisions) ? (g.divisions as RawDiv[]) : [];
    const divisions = divs
      .map((div) => {
        if (typeof div === 'string') return { name: div, label: div };
        if (div && typeof div === 'object') {
          const n = String(div.name ?? '');
          if (!n) return null;
          return { name: n, label: String(div.label ?? n) };
        }
        return null;
      })
      .filter((x): x is { name: string; label: string } => !!x);
    grades.push({
      campus: String(g.campus ?? ''),
      grade: name,
      label: String(g.label ?? name),
      whole: g.whole === true || g.allDivisions === true,
      divisions,
    });
  }
  const active = d.active && typeof d.active === 'object' ? (d.active as Record<string, unknown>) : null;
  const activeCode = active && typeof active.code === 'string' && active.code ? active.code : null;
  const activeLabel = active
    ? [active.subject, active.audience]
        .map((s) => (typeof s === 'string' ? s : ''))
        .filter(Boolean)
        .join(' · ')
    : null;
  return {
    today,
    timezone,
    activeCode,
    activeLabel: activeLabel || null,
    classes,
    grades,
    gradesConfigured: d.gradesConfigured !== false,
    earlyMinutes: typeof d.earlyMinutes === 'number' ? d.earlyMinutes : null,
  };
}

export type AdmittedPerson = {
  id: string;
  displayName: string;
  role: string;
  livekitIdentity: string;
  mutedByTeacher: boolean;
  handRaised: boolean;
  handRaisedAt: number | null;
  pinned: boolean;
  pinnedAt: number | null;
  focus: string | null;
  rollNumber: string | null;
  gradeDivision: string | null;
  late: boolean;
  onTimetable: boolean;
  /** School student id (search matches it, like the web roster). */
  sid: string | null;
  /** Asks to draw on the shared screen. */
  drawRequested: boolean;
  drawRequestedAt: number | null;
  /** Allowed to draw now. */
  drawing: boolean;
  /** Server presence: dropped off LiveKit and may come back (web roster 'Reconnecting'). */
  reconnecting?: boolean;
};

export type WaitingPerson = { id: string; displayName: string; createdAt: string | null; gradeDivision: string | null; late: boolean };

export type SpotlightInfo = { participantId: string; identity: string; name: string };
export type MicQueueEntry = { id: string; name: string; position: number };

export type DrawHolderInfo = { participantId: string; identity: string; name: string; until: number };

export type RoomSnapshot = {
  code: string;
  name: string;
  status: string;
  ended: boolean;
  waitingRoomOn: boolean;
  maxVisibleVideos: number;
  stageMode: 'idle' | 'screen';
  teacherName: string;
  meId: string | null;
  visibleIdentities: string[];
  waiting: WaitingPerson[];
  admitted: AdmittedPerson[];
  classLabel: string;
  drawHolder: DrawHolderInfo | null;
  /** Every student drawing now (the server allows several at once). */
  drawHolders: DrawHolderInfo[];
  drawRequestCount: number;
  desktopInk: boolean;
  /** One student whose camera the class sees (null = none). */
  spotlight: SpotlightInfo | null;
  /** Students waiting for an open mic slot (only when a mic limit is set). */
  micQueue: MicQueueEntry[];
  micLimit: number;
};

export function parseRoomState(data: unknown): RoomSnapshot | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.public === true && d.isTeacher !== true) return null;
  const admittedRaw = Array.isArray(d.admitted) ? d.admitted : [];
  const waitingRaw = Array.isArray(d.waiting) ? d.waiting : [];
  const admitted: AdmittedPerson[] = admittedRaw.map((item) => {
    const p = item as Record<string, unknown>;
    return {
      id: String(p.id ?? ''),
      displayName: String(p.displayName ?? 'Student'),
      role: String(p.role ?? 'STUDENT'),
      livekitIdentity: String(p.livekitIdentity ?? ''),
      mutedByTeacher: p.mutedByTeacher === true,
      handRaised: p.handRaised === true,
      handRaisedAt: typeof p.handRaisedAt === 'number' ? p.handRaisedAt : null,
      pinned: p.pinned === true,
      pinnedAt: typeof p.pinnedAt === 'number' ? p.pinnedAt : null,
      focus: typeof p.focus === 'string' ? p.focus : null,
      rollNumber: typeof p.rollNumber === 'string' ? p.rollNumber : null,
      gradeDivision: typeof p.gradeDivision === 'string' ? p.gradeDivision : null,
      late: p.late === true,
      onTimetable: p.onTimetable === true,
      sid: typeof p.sid === 'string' && p.sid ? p.sid : null,
      drawRequested: p.drawRequested === true,
      drawRequestedAt: typeof p.drawRequestedAt === 'number' ? p.drawRequestedAt : null,
      drawing: p.drawing === true,
      reconnecting: p.reconnecting === true,
    };
  });
  const waiting: WaitingPerson[] = waitingRaw.map((item) => {
    const p = item as Record<string, unknown>;
    return {
      id: String(p.id ?? ''),
      displayName: String(p.displayName ?? 'Student'),
      createdAt: typeof p.createdAt === 'string' ? p.createdAt : null,
      gradeDivision: typeof p.gradeDivision === 'string' ? p.gradeDivision : null,
      late: p.late === true,
    };
  });
  const cs = d.classSession && typeof d.classSession === 'object' ? (d.classSession as Record<string, unknown>) : null;
  const classLabel = cs
    ? [cs.subject, cs.audience].map((s) => (typeof s === 'string' ? s : '')).filter(Boolean).join(' · ')
    : String(d.name ?? '');
  const me = d.me && typeof d.me === 'object' ? (d.me as Record<string, unknown>) : null;
  return {
    code: String(d.code ?? ''),
    name: String(d.name ?? ''),
    status: String(d.status ?? ''),
    ended: d.ended === true || d.status === 'ENDED',
    waitingRoomOn: d.waitingRoomOn !== false,
    maxVisibleVideos: typeof d.maxVisibleVideos === 'number' ? d.maxVisibleVideos : 6,
    stageMode: d.stageMode === 'screen' ? 'screen' : 'idle',
    teacherName: String(d.teacherName ?? ''),
    meId: me && typeof me.id === 'string' ? me.id : null,
    visibleIdentities: Array.isArray(d.visibleIdentities) ? d.visibleIdentities.map((x) => String(x)) : [],
    waiting,
    admitted,
    classLabel,
    drawHolder: parseHolder(d.drawHolder),
    drawHolders: Array.isArray(d.drawHolders)
      ? d.drawHolders.map(parseHolder).filter((h): h is DrawHolderInfo => !!h)
      : parseHolder(d.drawHolder)
        ? [parseHolder(d.drawHolder)!]
        : [],
    drawRequestCount: typeof d.drawRequestCount === 'number' ? d.drawRequestCount : admitted.filter((p) => p.drawRequested).length,
    desktopInk: d.desktopInk === true,
    spotlight: parseSpotlight(d.spotlight),
    micQueue: Array.isArray(d.micQueue) ? d.micQueue.map(parseMicQueueEntry).filter((q): q is MicQueueEntry => !!q) : [],
    micLimit: typeof d.micLimit === 'number' && Number.isFinite(d.micLimit) ? d.micLimit : 0,
  };
}

function parseSpotlight(raw: unknown): SpotlightInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.participantId !== 'string' || !s.participantId) return null;
  return { participantId: s.participantId, identity: typeof s.identity === 'string' ? s.identity : '', name: typeof s.name === 'string' ? s.name : 'Student' };
}

function parseMicQueueEntry(raw: unknown): MicQueueEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const q = raw as Record<string, unknown>;
  if (typeof q.id !== 'string' || !q.id) return null;
  return { id: q.id, name: typeof q.name === 'string' ? q.name : 'Student', position: typeof q.position === 'number' ? q.position : 0 };
}

/** Admit answered 409: the class hit its seat limit (web CLASS_FULL_MESSAGE). */
export function admitFailureNotice(status: number, data: unknown): string | null {
  if (status !== 409) return null;
  const err = data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string' ? (data as { error: string }).error : '';
  return `${err || 'This class is full.'} Remove a student or raise the class size limit to admit more.`;
}

function parseHolder(raw: unknown): DrawHolderInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const h = raw as Record<string, unknown>;
  if (typeof h.participantId !== 'string' || typeof h.identity !== 'string') return null;
  return {
    participantId: h.participantId,
    identity: h.identity,
    name: typeof h.name === 'string' ? h.name : 'Student',
    until: typeof h.until === 'number' ? h.until : 0,
  };
}

/** Poll intervals: the web app's own policy (src/shared/web/pollPolicy.ts), teacher role. */
export { STATE_TOPIC, chatPollMs, statePollMs } from './web/pollPolicy';

/** Crop rectangle in the captured frame, from a DIP region on one display. */
export function regionFrameRect(
  region: { x: number; y: number; w: number; h: number },
  display: { x: number; y: number; w: number; h: number },
  frame: { width: number; height: number }
): { sx: number; sy: number; sw: number; sh: number } | null {
  if (!display.w || !display.h || !frame.width || !frame.height) return null;
  if (region.w < 16 || region.h < 16) return null;
  const sx = ((region.x - display.x) / display.w) * frame.width;
  const sy = ((region.y - display.y) / display.h) * frame.height;
  const sw = (region.w / display.w) * frame.width;
  const sh = (region.h / display.h) * frame.height;
  const x0 = Math.max(0, Math.min(frame.width - 2, Math.floor(sx)));
  const y0 = Math.max(0, Math.min(frame.height - 2, Math.floor(sy)));
  const x1 = Math.max(x0 + 2, Math.min(frame.width, Math.ceil(sx + sw)));
  const y1 = Math.max(y0 + 2, Math.min(frame.height, Math.ceil(sy + sh)));
  return { sx: x0, sy: y0, sw: x1 - x0, sh: y1 - y0 };
}

/** `/messages` after the first load asks only for newer rows (`?since`, web chatThread); the server overlaps a little and we merge by id. */
export function chatPollSuffix(messages: { createdAt: string }[]): string {
  let newest = '';
  for (const m of messages) if (m.createdAt > newest && Number.isFinite(Date.parse(m.createdAt))) newest = m.createdAt;
  return newest ? `/messages?since=${encodeURIComponent(newest)}` : '/messages';
}
