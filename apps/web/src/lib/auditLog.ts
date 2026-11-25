/**
 * Lightweight audit trail. There is no audit table in the database, so events
 * are written as a structured log line and kept in a Redis list (90 days,
 * newest 2,000). Used when an admin ends a live class.
 */
import { ensureRedis, keys } from './redis';

export const AUDIT_TTL_S = 90 * 24 * 60 * 60;
export const AUDIT_MAX_EVENTS = 2_000;
/** How long /state can still say who ended a finished class. */
export const ENDED_BY_TTL_S = 7 * 24 * 60 * 60;

export type AuditEvent = {
  at: string;
  action: 'end_class';
  actorKind: 'admin';
  actorId: string;
  actorName: string;
  actorEmail?: string;
  roomCode: string;
  roomId?: string;
  classSessionId?: string | null;
  sessionId?: string;
};

/** Pure: one-line form used in tests and in the process log. */
export function formatAuditLine(e: AuditEvent): string {
  const who = e.actorEmail ? `${e.actorName} <${e.actorEmail}>` : e.actorName;
  const session = e.classSessionId ? ` session=${e.classSessionId}` : '';
  return `[audit] ${e.at} ${e.action} by ${e.actorKind} ${e.actorId} (${who}) room=${e.roomCode}${session}`;
}

export async function recordAudit(event: AuditEvent): Promise<void> {
  const line = formatAuditLine(event);
  console.info(line);
  try {
    const r = await ensureRedis();
    const key = keys.auditEvents();
    await r.lpush(key, JSON.stringify(event));
    await r.ltrim(key, 0, AUDIT_MAX_EVENTS - 1);
    await r.expire(key, AUDIT_TTL_S);
  } catch (err) {
    console.warn('audit redis', err instanceof Error ? err.message : err);
  }
}

export async function rememberClassEndedBy(code: string, sessionId: string, by: 'admin' | 'teacher'): Promise<void> {
  if (!code || !sessionId) return;
  const r = await ensureRedis();
  await r.set(keys.endedBy(code.toUpperCase(), sessionId), by, 'EX', ENDED_BY_TTL_S);
}

export async function readClassEndedBy(code: string, sessionId: string): Promise<'admin' | 'teacher' | null> {
  if (!code || !sessionId) return null;
  try {
    const raw = await (await ensureRedis()).get(keys.endedBy(code.toUpperCase(), sessionId));
    return raw === 'admin' || raw === 'teacher' ? raw : null;
  } catch {
    return null;
  }
}
