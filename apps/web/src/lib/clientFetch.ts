'use client';

/** Small same-origin JSON fetch helper for dashboard pages. */
export async function api<T = any>(
  path: string,
  opts: { method?: string; body?: unknown } = {}
): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  const init: RequestInit = { method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'), cache: 'no-store' };
  if (opts.body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(opts.body);
  }
  try {
    const res = await fetch(path, init);
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: 'Network error. Check your connection.' } as T & { error?: string } };
  }
}
