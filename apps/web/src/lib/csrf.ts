/**
 * Cross-site request forgery guard for state-changing API calls.
 *
 * Why this exists: the recommended deploy is `https://a-b-c-d.sslip.io`, and
 * sslip.io / nip.io are not on the Public Suffix List. Browsers treat every
 * `*.sslip.io` origin as the *same site*, so SameSite cookies alone do not stop
 * another sslip.io page from POSTing to this app with the teacher cookie.
 *
 * Every method, including GET: a browser request that says it comes from
 * another site (`Sec-Fetch-Site: cross-site` or `same-site`) is refused. Some
 * GET routes have side effects (the teacher's /token resets the stage and
 * presence), and SameSite=Strict cookies still travel on same-site requests
 * from sibling sslip.io pages. The school-app join link is the one
 * cross-site navigation allowed (CROSS_SITE_GET_PATHS; it checks for itself
 * that it is a top-level navigation).
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

/**
 * Server-to-server endpoints with their own authentication, not reachable
 * with a victim's cookies to any effect. The LiveKit webhook is verified by
 * the signed `Authorization` JWT (WebhookReceiver) and carries
 * `application/webhook+json` with no browser Origin.
 */
export const CSRF_EXEMPT_PATHS = new Set(['/api/livekit/webhook']);

export function isCsrfExempt(pathname: string): boolean {
  return CSRF_EXEMPT_PATHS.has(pathname.replace(/\/+$/, ''));
}

export const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** GET routes another site may navigate to (the school app's join link). */
export const CROSS_SITE_GET_PATHS = new Set(['/api/student/join']);

export function allowsCrossSiteGet(pathname: string): boolean {
  return CROSS_SITE_GET_PATHS.has(pathname.replace(/\/+$/, ''));
}

/**
 * Paths that also accept a native same-origin HTML form post
 * (application/x-www-form-urlencoded): the /login form's pre-hydration
 * fallback, so credentials go in a POST body, never a GET query. A browser
 * form post always carries Origin, which must then be present and allowed.
 */
export const FORM_POST_PATHS = new Set(['/api/auth/login']);

export function allowsFormPost(pathname: string): boolean {
  return FORM_POST_PATHS.has(pathname.replace(/\/+$/, ''));
}

function isFormContentType(value: string | null): boolean {
  if (!value) return false;
  return value.split(';')[0]!.trim().toLowerCase() === 'application/x-www-form-urlencoded';
}

export type CsrfInput = {
  /** Accept a same-origin urlencoded form post (see FORM_POST_PATHS). */
  allowForm?: boolean;
  /** Accept a cross-site GET (see CROSS_SITE_GET_PATHS). */
  allowCrossSiteGet?: boolean;
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
  if (!STATE_CHANGING_METHODS.has(method)) {
    const site = input.headers.get('sec-fetch-site');
    if (!input.allowCrossSiteGet && (site === 'cross-site' || site === 'same-site')) {
      return { ok: false, status: 403, reason: 'Cross-site request blocked' };
    }
    return { ok: true };
  }

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

  const ct = input.headers.get('content-type');
  if (input.allowForm && isFormContentType(ct)) {
    if (origin == null) return { ok: false, status: 403, reason: 'Cross-site request blocked' };
    return { ok: true };
  }
  if (hasBody(input.headers) && !isJsonContentType(ct)) {
    return { ok: false, status: 415, reason: 'Content-Type must be application/json' };
  }

  return { ok: true };
}
