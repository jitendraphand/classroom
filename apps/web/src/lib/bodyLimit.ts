/**
 * Request-body size caps, checked in middleware from Content-Length before a
 * route handler buffers and parses the body (SEC-05). Route handlers call
 * `req.json()` with no limit of their own, so without this one oversized
 * POST (even unauthenticated) is read fully into a web worker's memory.
 *
 * Kept free of Next.js imports so it runs in middleware and unit tests.
 */
export const DEFAULT_BODY_LIMIT = 1024 * 1024; // 1 MiB: chat, draw points, settings
export const LARGE_BODY_LIMIT = 8 * 1024 * 1024; // whiteboard snapshots, roster CSV

/** Routes whose bodies may legitimately be large (see the zod caps in each). */
const LARGE_BODY_PATHS: RegExp[] = [
  /^\/api\/rooms\/[^/]+\/whiteboard\/?$/, // WB_SNAP_MAX_PACKETS × WB_SNAP_MAX_B64 ≈ 6 MB
  /^\/api\/rooms\/[^/]+\/whiteboard\/asset\/?$/, // one image ≤ ASSET_MAX_BYTES (2 MB), also capped while reading
  /^\/api\/admin\/live\/[^/]+\/whiteboard\/?$/,
  /^\/api\/admin\/students\/import\/?$/, // csv ≤ 2,000,000 chars
];

export function bodyLimitFor(pathname: string): number {
  return LARGE_BODY_PATHS.some((re) => re.test(pathname)) ? LARGE_BODY_LIMIT : DEFAULT_BODY_LIMIT;
}

/** True when the declared Content-Length is over the route's cap. Missing / unparsable: not judged here. */
export function bodyTooLarge(pathname: string, contentLength: string | null): boolean {
  if (contentLength == null || contentLength.trim() === '') return false;
  const n = Number(contentLength);
  if (!Number.isFinite(n)) return false;
  return n > bodyLimitFor(pathname);
}
