/**
 * The classroom server's teacher API, as a non-browser client (like the
 * Android app): JSON bodies, no Origin header, a cookie jar for the session.
 * Only teacher routes; nothing here reaches admin endpoints.
 */

export type ChatMessage = {
  id: string;
  senderParticipantId: string;
  senderName: string;
  senderRole: string;
  body: string;
  /** BROADCAST (everyone), TEACHER (a student to the teacher), DIRECT (teacher to one student). */
  scope: string;
  recipientParticipantId: string | null;
  recipientName: string | null;
  createdAt: string;
};

export type Person = {
  id: string;
  displayName: string;
  role: string;
  livekitIdentity: string;
  mutedByTeacher: boolean;
  handRaised: boolean;
  handRaisedAt?: string | null;
  drawing?: boolean;
  micWaiting?: boolean;
};

export type RoomState = {
  code: string;
  name: string;
  status: string;
  waitingRoomOn: boolean;
  me: { id: string; livekitIdentity: string } | null;
  waiting: { id: string; displayName: string; sid?: string | null }[];
  admitted: Person[];
  admittedStudentCount: number;
  /** Participant ids, oldest raise first. */
  raisedHands: string[];
  whiteboard: boolean;
  spotlight: { participantId: string; name: string } | null;
  micLimit: number;
  micQueue: unknown[];
  classInfo?: { subject?: string | null; audience?: string | null; scheduledStart?: string | null; scheduledEnd?: string | null };
};

export type TokenInfo = { url: string; token: string; identity: string; roomName: string; teacherPresent: boolean; mediaProfile?: string };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export class ClassroomApi {
  private cookies = new Map<string, string>();

  constructor(readonly base: string) {
    this.base = base.replace(/\/+$/, '');
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(this.base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv!.indexOf('=');
      if (i <= 0) continue;
      const k = kv!.slice(0, i).trim();
      const v = kv!.slice(i + 1).trim();
      if (v === '' || /max-age=0/i.test(c)) this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    let data: unknown = null;
    try {
      data = await r.json();
    } catch {
      /* empty body */
    }
    if (!r.ok) {
      const msg = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : `HTTP ${r.status}`;
      throw new ApiError(r.status, msg);
    }
    return data as T;
  }

  /** Sign in as the AI teacher's account (a TEACHER created by an admin). */
  async login(email: string, password: string): Promise<{ name: string }> {
    const res = await this.call<{ role?: string; name?: string; mustChangePassword?: boolean }>('POST', '/api/auth/login', { email, password });
    const me = await this.call<{ role?: string; name?: string; mustChangePassword?: boolean } & Record<string, unknown>>('GET', '/api/auth/me');
    if (me.mustChangePassword || res.mustChangePassword) {
      throw new ApiError(403, 'This account must change its password first: sign in once in a browser and set a new one.');
    }
    if (me.role !== 'teacher') throw new ApiError(403, `Signed in as ${me.role ?? 'nobody'}, not a teacher.`);
    return { name: String(me.name ?? res.name ?? 'Teacher') };
  }

  /** Keeps the sliding 24 h session alive (call every ~30 min). */
  renew(): Promise<unknown> {
    return this.call('GET', '/api/auth/me');
  }

  home(): Promise<Record<string, unknown>> {
    return this.call('GET', '/api/teacher/home');
  }

  startScheduled(key: string): Promise<{ code: string; name: string }> {
    return this.call('POST', '/api/teacher/sessions/start', { kind: 'scheduled', key });
  }

  startAdhoc(opts: { campus: string; grade: string; divisions: string[]; subject?: string }): Promise<{ code: string; name: string }> {
    return this.call('POST', '/api/teacher/sessions/start', { kind: 'adhoc', ...opts });
  }

  /** LiveKit token for the teacher's own connection (resets stage and presence). */
  token(code: string): Promise<TokenInfo> {
    return this.call('GET', `/api/rooms/${encodeURIComponent(code)}/token`);
  }

  state(code: string): Promise<RoomState> {
    return this.call('GET', `/api/rooms/${encodeURIComponent(code)}/state`);
  }

  messages(code: string, since?: string): Promise<{ messages: ChatMessage[]; ended: boolean }> {
    const q = since ? `?since=${encodeURIComponent(since)}` : '';
    return this.call('GET', `/api/rooms/${encodeURIComponent(code)}/messages${q}`);
  }

  /** `to`: 'all' (everyone) or a student's participant id (a private reply). */
  sendMessage(code: string, text: string, to: string = 'all'): Promise<unknown> {
    return this.call('POST', `/api/rooms/${encodeURIComponent(code)}/messages`, { text, to });
  }

  admit(code: string, opts: { ids?: string[]; all?: boolean }): Promise<{ count?: number }> {
    return this.call('POST', `/api/rooms/${encodeURIComponent(code)}/admit`, opts.all ? { all: true } : { participantIds: opts.ids ?? [] });
  }

  muteOne(code: string, participantId: string, muted: boolean): Promise<unknown> {
    return this.call('POST', `/api/rooms/${encodeURIComponent(code)}/mute`, { participantId, muted });
  }

  muteAll(code: string, muted: boolean): Promise<unknown> {
    return this.call('POST', `/api/rooms/${encodeURIComponent(code)}/mute`, { all: true, muted });
  }

  lowerHand(code: string, participantId: string): Promise<unknown> {
    return this.call('POST', `/api/rooms/${encodeURIComponent(code)}/hand`, { participantId, raised: false });
  }

  /** null clears the spotlight. */
  spotlight(code: string, participantId: string | null): Promise<unknown> {
    return this.call('POST', `/api/rooms/${encodeURIComponent(code)}/spotlight`, { participantId });
  }

  draw(code: string, action: 'allow' | 'revoke' | 'clear', participantId?: string): Promise<unknown> {
    return this.call('POST', `/api/rooms/${encodeURIComponent(code)}/draw`, { action, ...(participantId ? { participantId } : {}) });
  }

  whiteboard(code: string, body: { action: 'on' | 'off' } | { action: 'snap'; packets: string[] }): Promise<unknown> {
    return this.call('POST', `/api/rooms/${encodeURIComponent(code)}/whiteboard`, body);
  }

  settings(code: string, body: { waitingRoomOn?: boolean; name?: string }): Promise<unknown> {
    return this.call('PATCH', `/api/rooms/${encodeURIComponent(code)}/settings`, body);
  }

  end(code: string): Promise<unknown> {
    return this.call('POST', `/api/rooms/${encodeURIComponent(code)}/end`, {});
  }
}
