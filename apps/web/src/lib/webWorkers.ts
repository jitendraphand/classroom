/**
 * How many Next.js workers to run. Default is the CPU count, overridable with
 * WEB_WORKERS. When WEB_WORKERS is unset, the count is capped so
 * workers × DB_POOL_PER_WORKER stays under POSTGRES_MAX_CONNECTIONS (with
 * headroom for superuser / maintenance). An explicit WEB_WORKERS is honoured
 * as-is: raise Postgres max_connections to match.
 */

export const DEFAULT_DB_POOL_PER_WORKER = 8;
export const DEFAULT_DB_POOL_TIMEOUT = 10;
export const DEFAULT_POSTGRES_MAX_CONNECTIONS = 280;
/** Connections left for superuser, migrate, and ad-hoc psql. */
export const POSTGRES_HEADROOM = 24;
export const MAX_WEB_WORKERS = 64;

export function parsePositiveInt(raw: string | undefined | null, fallback: number): number {
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export type WorkerPlan = {
  workers: number;
  capped: boolean;
  cpuCount: number;
  poolPerWorker: number;
  maxConnections: number;
  reason?: string;
};

export function webWorkerCount(opts: {
  env?: Record<string, string | undefined>;
  cpuCount: number;
}): WorkerPlan {
  const env = opts.env ?? {};
  const cpuCount = Math.max(1, opts.cpuCount | 0);
  const poolPerWorker = Math.min(
    64,
    parsePositiveInt(env.DB_POOL_PER_WORKER, DEFAULT_DB_POOL_PER_WORKER)
  );
  const maxConnections = parsePositiveInt(env.POSTGRES_MAX_CONNECTIONS, DEFAULT_POSTGRES_MAX_CONNECTIONS);
  const fit = Math.max(1, Math.floor((maxConnections - POSTGRES_HEADROOM) / poolPerWorker));
  const explicit = env.WEB_WORKERS != null && String(env.WEB_WORKERS).trim() !== '';
  let workers = explicit ? parsePositiveInt(env.WEB_WORKERS, cpuCount) : cpuCount;
  workers = Math.max(1, Math.min(MAX_WEB_WORKERS, workers));
  if (!explicit && workers > fit) {
    return {
      workers: fit,
      capped: true,
      cpuCount,
      poolPerWorker,
      maxConnections,
      reason: `auto-capped to ${fit} so ${fit}×${poolPerWorker} Prisma pools fit max_connections=${maxConnections}`,
    };
  }
  return { workers, capped: false, cpuCount, poolPerWorker, maxConnections };
}
