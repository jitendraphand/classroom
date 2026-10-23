/**
 * How many Next.js workers to run, sized from the core count.
 *
 * - Workers: WEB_WORKERS when set to a number, else one per CPU (all cores).
 *   LiveKit keeps priority on a shared box through Docker cpu_shares / nice
 *   (docker-compose.yml), not by leaving cores idle.
 * - Prisma pool per worker: DB_POOL_PER_WORKER when set, else the share of
 *   Postgres max_connections (minus headroom) each worker gets, between
 *   MIN_AUTO_POOL and DEFAULT_DB_POOL_PER_WORKER. A 32-core box gets 8 each
 *   (256 of 280); a 64-core box gets 4 each instead of losing workers.
 * - Only if even that does not fit (explicit pool, or the minimum pool) are
 *   auto-sized workers capped. An explicit WEB_WORKERS is honoured as-is:
 *   raise Postgres max_connections to match.
 */

export const DEFAULT_DB_POOL_PER_WORKER = 8;
export const MIN_AUTO_POOL = 3;
export const DEFAULT_DB_POOL_TIMEOUT = 10;
export const DEFAULT_POSTGRES_MAX_CONNECTIONS = 280;
/** Connections left for superuser, migrate, and ad-hoc psql. */
export const POSTGRES_HEADROOM = 24;
export const MAX_WEB_WORKERS = 128;

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

const isSet = (v: string | undefined) => v != null && String(v).trim() !== '' && String(v).trim().toLowerCase() !== 'auto';

export function webWorkerCount(opts: {
  env?: Record<string, string | undefined>;
  cpuCount: number;
}): WorkerPlan {
  const env = opts.env ?? {};
  const cpuCount = Math.max(1, opts.cpuCount | 0);
  const maxConnections = parsePositiveInt(env.POSTGRES_MAX_CONNECTIONS, DEFAULT_POSTGRES_MAX_CONNECTIONS);
  const budget = Math.max(1, maxConnections - POSTGRES_HEADROOM);
  const explicitWorkers = isSet(env.WEB_WORKERS);
  let workers = explicitWorkers ? parsePositiveInt(env.WEB_WORKERS, cpuCount) : cpuCount;
  workers = Math.max(1, Math.min(MAX_WEB_WORKERS, workers));
  const explicitPool = isSet(env.DB_POOL_PER_WORKER);
  const poolPerWorker = explicitPool
    ? Math.min(64, parsePositiveInt(env.DB_POOL_PER_WORKER, DEFAULT_DB_POOL_PER_WORKER))
    : Math.max(MIN_AUTO_POOL, Math.min(DEFAULT_DB_POOL_PER_WORKER, Math.floor(budget / workers)));
  const fit = Math.max(1, Math.floor(budget / poolPerWorker));
  if (!explicitWorkers && workers > fit) {
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
