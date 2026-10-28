/**
 * How many Next.js workers to run, sized from the core count.
 *
 * - Workers: WEB_WORKERS when set to a number. Auto: every CPU on small boxes
 *   (≤ 8 CPUs); on bigger boxes WEB_CPU_FRACTION of them (default 0.5, at
 *   least 8), so LiveKit keeps the other half. Trial 2026-10-24 (64 vCPU):
 *   64 workers + LiveKit pushed load average to 50-60 and /state to 503s.
 *   LiveKit also keeps priority through Docker cpu_shares / nice.
 * - Prisma pool per worker: DB_POOL_PER_WORKER when set, else the share of
 *   Postgres max_connections (minus headroom) each worker gets, between
 *   MIN_AUTO_POOL and DEFAULT_DB_POOL_PER_WORKER. A 64-vCPU box runs 32
 *   workers × 10 = 320 of 400; a 32-vCPU box 16 × 10 (scripts/configure-resources.sh
 *   writes POSTGRES_MAX_CONNECTIONS=400 for such "large" boxes; the compose
 *   default of 100 suits a small one).
 * - Only if even that does not fit (explicit pool, or the minimum pool) are
 *   auto-sized workers capped. An explicit WEB_WORKERS is honoured as-is:
 *   raise Postgres max_connections to match.
 */

export const DEFAULT_DB_POOL_PER_WORKER = 10;
export const MIN_AUTO_POOL = 3;
export const DEFAULT_DB_POOL_TIMEOUT = 10;
export const DEFAULT_POSTGRES_MAX_CONNECTIONS = 100;
/** Share of CPUs the web cluster takes on boxes with more than SMALL_BOX_CPUS. */
export const DEFAULT_WEB_CPU_FRACTION = 0.5;
export const SMALL_BOX_CPUS = 8;
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

/** Auto worker count: all CPUs on small boxes, else WEB_CPU_FRACTION of them (≥ SMALL_BOX_CPUS). */
export function autoWebWorkers(cpuCount: number, fractionRaw?: string): number {
  const cpus = Math.max(1, cpuCount | 0);
  if (cpus <= SMALL_BOX_CPUS) return cpus;
  const f = Number.parseFloat(String(fractionRaw ?? ''));
  const frac = Number.isFinite(f) && f > 0 && f <= 1 ? f : DEFAULT_WEB_CPU_FRACTION;
  return Math.max(SMALL_BOX_CPUS, Math.round(cpus * frac));
}

export function webWorkerCount(opts: {
  env?: Record<string, string | undefined>;
  cpuCount: number;
}): WorkerPlan {
  const env = opts.env ?? {};
  const cpuCount = Math.max(1, opts.cpuCount | 0);
  const maxConnections = parsePositiveInt(env.POSTGRES_MAX_CONNECTIONS, DEFAULT_POSTGRES_MAX_CONNECTIONS);
  const budget = Math.max(1, maxConnections - POSTGRES_HEADROOM);
  const explicitWorkers = isSet(env.WEB_WORKERS);
  let workers = explicitWorkers ? parsePositiveInt(env.WEB_WORKERS, cpuCount) : autoWebWorkers(cpuCount, env.WEB_CPU_FRACTION);
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

/**
 * Per-worker memory: WEB_MEM_FRACTION (default 0.5) of available RAM (cgroup
 * limit when lower than physical RAM) is split across the web workers. The
 * recycle threshold (WEB_WORKER_MAX_RSS_MB) is that share, 512–4096 MB; the V8
 * heap cap (--max-old-space-size, WEB_WORKER_HEAP_MB) is 80% of it, ≥ 384 MB.
 * Trial 2 (48 GB, 16 workers): 35% / 75% gave a 788 MB heap and 5 worker OOMs.
 * cluster.js mirrors this (tests/scaling.test.ts).
 */
export const DEFAULT_WEB_MEM_FRACTION = 0.5;
/** Share of the web container's OWN memory limit (cgroup) the workers may use together. */
export const DEFAULT_WEB_LIMIT_FRACTION = 0.85;
export const HEAP_OF_RSS = 0.8;
export function workerMemoryPlan(opts: {
  env?: Record<string, string | undefined>;
  availableMb: number;
  workers: number;
  /**
   * availableMb is the container's memory limit (WEB_MEM_LIMIT), not the
   * host's RAM: the web workers own all of it, so they take
   * WEB_MEM_LIMIT_FRACTION (0.85) of it instead of WEB_MEM_FRACTION of the host.
   */
  limited?: boolean;
}) {
  const env = opts.env ?? {};
  const raw = opts.limited ? env.WEB_MEM_LIMIT_FRACTION : env.WEB_MEM_FRACTION;
  const f = Number.parseFloat(String(raw ?? ''));
  const frac = Number.isFinite(f) && f > 0 && f <= 0.95 ? f : opts.limited ? DEFAULT_WEB_LIMIT_FRACTION : DEFAULT_WEB_MEM_FRACTION;
  const n = Math.max(1, opts.workers | 0);
  // Inside a container limit the floor is lower: a small box runs 1-2 workers in ~600 MB each.
  const floor = opts.limited ? 256 : 512;
  const autoRss = Math.max(floor, Math.min(4096, Math.floor((opts.availableMb * frac) / n)));
  const rssMb = env.WEB_WORKER_MAX_RSS_MB != null && String(env.WEB_WORKER_MAX_RSS_MB).trim() !== ''
    ? Number.parseInt(String(env.WEB_WORKER_MAX_RSS_MB), 10) || 0
    : autoRss;
  const heapMb = parsePositiveInt(env.WEB_WORKER_HEAP_MB, Math.max(opts.limited ? 192 : 384, Math.floor((rssMb > 0 ? rssMb : autoRss) * HEAP_OF_RSS)));
  return { rssMb, heapMb, frac };
}
