import type { LiveClass } from './liveClassesLogic';
import { parseObserverMode } from './liveClassesLogic';
import { isObserverIdentityForAdmin } from './adminObservers';
import type { LiveRosterStudent } from './liveClasses';
import type { ObserverMode } from './livekit';

/**
 * Request handling for the admin "Ongoing classes" API, with every side effect
 * injected so the auth/role gate and the token policy are unit-tested
 * (tests/adminLive.test.ts). The route files only wire in the real deps.
 *
 * The guard runs first on every path: nothing is read from the DB or LiveKit,
 * and no token is minted, unless the caller holds a valid *admin* session
 * (teacher and student cookies never satisfy it) and the `monitorLive`
 * privilege (or SYSTEM).
 */

type Admin = { id: string; name: string; email: string };
export type AdminGuard = () => Promise<{ admin: Admin; res?: undefined } | { admin?: undefined; res: Response }>;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export async function handleListLive(deps: { guard: AdminGuard; list: () => Promise<LiveClass[]> }) {
  const g = await deps.guard();
  if (g.res) return g.res;
  return json({ classes: await deps.list() });
}

type LiveDetail = { liveClass: LiveClass; roomName: string; students: LiveRosterStudent[] };

export async function handleLiveDetail(
  code: string,
  deps: { guard: AdminGuard; get: (code: string) => Promise<LiveDetail | null> }
) {
  const g = await deps.guard();
  if (g.res) return g.res;
  const d = await deps.get(normalizeCode(code));
  if (!d) return json({ error: 'This class is not live.' }, 404);
  return json({ class: d.liveClass, students: d.students });
}

export async function handleObserverToken(
  code: string,
  body: unknown,
  deps: {
    guard: AdminGuard;
    get: (code: string) => Promise<LiveDetail | null>;
    mint: (o: {
      roomName: string;
      adminId: string;
      adminName: string;
      mode: ObserverMode;
    }) => Promise<{ token: string; identity: string }>;
    serverUrl: (roomName: string) => string | Promise<string>;
    onObserveStart?: (o: { code: string; identity: string; roomName: string }) => Promise<void> | void;
  }
) {
  const g = await deps.guard();
  if (g.res) return g.res;
  const mode = parseObserverMode((body as { mode?: unknown } | null)?.mode);
  if (!mode) return json({ error: 'mode must be "preview" or "observe"' }, 400);
  const norm = normalizeCode(code);
  const d = await deps.get(norm);
  if (!d) return json({ error: 'This class is not live.' }, 404);
  const { token, identity } = await deps.mint({
    roomName: d.roomName,
    adminId: g.admin.id,
    adminName: g.admin.name || g.admin.email,
    mode,
  });
  if (mode === 'observe' && deps.onObserveStart) {
    await deps.onObserveStart({ code: norm, identity, roomName: d.roomName });
  }
  return json({ token, identity, serverUrl: await deps.serverUrl(d.roomName), mode, class: d.liveClass });
}

export async function handleObserverHeartbeat(
  code: string,
  body: unknown,
  deps: {
    guard: AdminGuard;
    exists: (code: string) => Promise<boolean>;
    refresh: (code: string, identity: string) => Promise<{ activeCount: number }>;
    unregister: (code: string, identity: string) => Promise<{ activeCount: number }>;
  }
) {
  const g = await deps.guard();
  if (g.res) return g.res;
  const parsed = body as { identity?: unknown; active?: unknown } | null;
  const identity = String(parsed?.identity ?? '').trim();
  if (!isObserverIdentityForAdmin(identity, g.admin.id)) {
    return json({ error: 'Not your observer identity' }, 403);
  }
  if (typeof parsed?.active !== 'boolean') {
    return json({ error: 'active must be a boolean' }, 400);
  }
  const norm = normalizeCode(code);
  if (!parsed.active) {
    const res = await deps.unregister(norm, identity);
    return json({ ok: true, active: false, activeCount: res.activeCount });
  }
  if (!(await deps.exists(norm))) {
    return json({ error: 'This class is not live.' }, 404);
  }
  const res = await deps.refresh(norm, identity);
  return json({ ok: true, active: true, activeCount: res.activeCount });
}

function normalizeCode(code: string) {
  return String(code || '').trim().toUpperCase().slice(0, 32);
}
