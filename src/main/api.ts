/**
 * Classroom HTTP client. Runs in the main process so the renderer never sees
 * the session cookie. No Origin and no Sec-Fetch-Site: the server's CSRF check
 * allows a non-browser client that sends neither. Bodies are JSON.
 * Logs method, path, and status only.
 */

import { DEFAULT_SERVER, isSafeApiPath, normalizeServer, teacherCookieFromSetCookie } from '../shared/apiModel';

export type ApiResult = { status: number; data: unknown };

export type StoredConfig = {
  server: string;
  email: string;
  cookie: string | null;
  toolbar: { x: number; y: number } | null;
  /** Annotation tool panel position (optional; older configs do not have it). */
  annotateTools?: { x: number; y: number } | null;
  annotateToolsOrient?: 'horizontal' | 'vertical';
  layout: 2 | 4 | 6;
  hotkeys: { mic: string; camera: string; stopShare: string };
  micId: string;
  camId: string;
};

const METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);

export class ClassroomApi {
  constructor(private readonly config: { current: StoredConfig; save: () => void }) {}

  server(): string {
    return this.config.current.server || DEFAULT_SERVER;
  }

  setServer(raw: string): string | null {
    const next = normalizeServer(raw);
    if (!next) return null;
    this.config.current.server = next;
    this.config.save();
    return next;
  }

  setCookie(value: string | null): void {
    this.config.current.cookie = value;
    this.config.save();
  }

  async call(method: string, path: string, body?: unknown): Promise<ApiResult> {
    const verb = method.toUpperCase();
    if (!METHODS.has(verb)) return { status: 400, data: { error: 'Method not allowed' } };
    if (!isSafeApiPath(path)) return { status: 400, data: { error: 'Path not allowed' } };
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const cookie = this.config.current.cookie;
    if (cookie) headers.Cookie = cookie;
    let res: Response;
    try {
      res = await fetch(`${this.server()}${path}`, {
        method: verb,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Network error';
      console.log(`[api] ${verb} ${path} network`);
      return { status: 0, data: { error: message } };
    }
    const lines = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const parsed = teacherCookieFromSetCookie(lines);
    if (parsed.present) this.setCookie(parsed.value);
    let data: unknown = null;
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        data = { error: 'Unexpected response' };
      }
    }
    console.log(`[api] ${verb} ${path} ${res.status}`);
    return { status: res.status, data };
  }
}

export function errorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === 'object' && 'error' in data && typeof (data as { error: unknown }).error === 'string') {
    const extra = data as { error: string; retryAfterSeconds?: unknown };
    if (typeof extra.retryAfterSeconds === 'number') {
      return `${extra.error} Try again in ${extra.retryAfterSeconds}s.`;
    }
    return extra.error;
  }
  return fallback;
}
