import { DEFAULT_DB_POOL_PER_WORKER, DEFAULT_DB_POOL_TIMEOUT, parsePositiveInt } from './webWorkers';

/**
 * Append Prisma pool params to DATABASE_URL when the operator has not set them.
 * String-append (not `new URL`) so passwords with encoded `@` / `:` stay intact.
 *
 * Total connections ≈ WEB_WORKERS × DB_POOL_PER_WORKER, which must stay below
 * Postgres max_connections (see docs/CAPACITY.md).
 */
export function withPoolParams(
  raw: string,
  opts?: { connectionLimit?: number; poolTimeout?: number; env?: Record<string, string | undefined> }
): string {
  if (!raw) return raw;
  const env = opts?.env ?? process.env;
  const limit = opts?.connectionLimit ?? parsePositiveInt(env.DB_POOL_PER_WORKER, DEFAULT_DB_POOL_PER_WORKER);
  const timeout = opts?.poolTimeout ?? parsePositiveInt(env.DB_POOL_TIMEOUT, DEFAULT_DB_POOL_TIMEOUT);
  const hasLimit = /(?:^|[?&])connection_limit=/.test(raw);
  const hasTimeout = /(?:^|[?&])pool_timeout=/.test(raw);
  if (hasLimit && hasTimeout) return raw;
  let out = raw;
  let sep = raw.includes('?') ? '&' : '?';
  if (!hasLimit) {
    out += `${sep}connection_limit=${limit}`;
    sep = '&';
  }
  if (!hasTimeout) out += `${sep}pool_timeout=${timeout}`;
  return out;
}
