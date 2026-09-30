/**
 * Cross-site request forgery guard for state-changing API calls.
 *
 * Why this exists: the recommended deploy is `https://a-b-c-d.sslip.io`, and
 * sslip.io / nip.io are not on the Public Suffix List. Browsers treat every
 * `*.sslip.io` origin as the *same site*, so SameSite cookies alone do not stop
 * another sslip.io page from POSTing to this app with the teacher cookie.
 *
 * Rules for POST / PUT / PATCH / DELETE:
 *  1. If the browser sent `Origin`, its host must be this app's host (the
 *     request Host / X-Forwarded-Host, or APP_URL / NEXT_PUBLIC_APP_URL).
 *  2. Otherwise, if `Sec-Fetch-Site` is present it must be `same-origin` or
 *     `none`. Browsers always send one of the two on a cross-origin write.
 *  3. A request with neither header is not from a browser (curl, the Android
 *     app); CSRF needs a victim browser, so it is allowed.
 *  4. Any request that carries a body must be `application/json`. That forces a
 *     CORS preflight for cross-origin callers, which this app never answers,
 *     and stops `text/plain` "simple request" bodies being parsed as JSON.
 *
 * Kept free of Next.js imports so it runs in middleware and in unit tests.
 */

export const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export type CsrfInput = {
  method: string;
  headers: { get(name: string): string | null };
  /** Extra origins allowed besides the request host (APP_URL etc.). */
  configuredOrigins?: Array<string | undefined | null>;
};

export type CsrfResult = { ok: true } | { ok: false; status: 403 | 415; reason: string };

function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    if (value.includes('://')) return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
  return value.split(',')[0]!.trim().toLowerCase() || null;
}

/** Hosts this app answers on for the given request. */
export function allowedHosts(input: CsrfInput): Set<string> {
  const hosts = new Set<string>();
  const add = (v: string | null | undefined) => {
    const h = hostOf(v);
    if (h) hosts.add(h);
  };
  add(input.headers.get('host'));
  add(input.headers.get('x-forwarded-host'));
  for (const o of input.configuredOrigins ?? []) add(o ?? null);
  return hosts;
}

function hasBody(headers: CsrfInput['headers']): boolean {
  const len = headers.get('content-length');
  if (len != null && len.trim() !== '') {
    const n = Number(len);
    return Number.isFinite(n) ? n > 0 : true;
  }
  return !!headers.get('transfer-encoding');
}

export function isJsonContentType(value: string | null): boolean {
  if (!value) return false;
  const mime = value.split(';')[0]!.trim().toLowerCase();
  return mime === 'application/json' || (mime.startsWith('application/') && mime.endsWith('+json'));
}

export function checkCsrf(input: CsrfInput): CsrfResult {
  const method = input.method.toUpperCase();
  if (!STATE_CHANGING_METHODS.has(method)) return { ok: true };

  const origin = input.headers.get('origin');
  if (origin != null) {
    if (origin === 'null') return { ok: false, status: 403, reason: 'Cross-site request blocked' };
    const originHost = hostOf(origin);
    if (!originHost || !allowedHosts(input).has(originHost)) {
      return { ok: false, status: 403, reason: 'Cross-site request blocked' };
    }
  } else {
    const site = input.headers.get('sec-fetch-site');
    if (site != null && site !== 'same-origin' && site !== 'none') {
      return { ok: false, status: 403, reason: 'Cross-site request blocked' };
    }
  }

  if (hasBody(input.headers) && !isJsonContentType(input.headers.get('content-type'))) {
    return { ok: false, status: 415, reason: 'Content-Type must be application/json' };
  }

  return { ok: true };
}
