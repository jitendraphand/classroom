'use strict';
/**
 * Production entry: fork WEB_WORKERS Node processes (default: all CPUs on
 * ≤ 8-CPU boxes, else WEB_CPU_FRACTION (0.5) of them; see src/lib/webWorkers.ts)
 * sharing PORT (default 3000). Each worker loads Next.js standalone server.js.
 *
 * Local `next dev` does not use this file — it already serves :3000 as a
 * single process. Cluster sharing :3000 is the multi-core path; Caddy still
 * reverse_proxies 127.0.0.1:3000. Sticky sessions are not required because
 * room state lives in Redis / LiveKit.
 *
 * When WEB_WORKERS is unset, the count is capped so workers × DB_POOL_PER_WORKER
 * fit POSTGRES_MAX_CONNECTIONS (see src/lib/webWorkers.ts).
 */
const cluster = require('cluster');
const os = require('os');
const http = require('http');
const path = require('path');
const fs = require('fs');

// Mirrors src/lib/webWorkers.ts (tests/scaling.test.ts checks both agree).
const DEFAULT_POOL = 10;
const MIN_AUTO_POOL = 3;
const DEFAULT_MAX_CONN = 400;
const DEFAULT_WEB_CPU_FRACTION = 0.5;
const SMALL_BOX_CPUS = 8;
const HEADROOM = 24;
const MAX_WORKERS = 128;
const DEFAULT_WEB_MEM_FRACTION = 0.5;
const HEAP_OF_RSS = 0.8;

/** Physical RAM, or the container's cgroup memory limit when lower. */
function availableMemMb() {
  let mb = os.totalmem() / 1048576;
  for (const f of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const raw = fs.readFileSync(f, 'utf8').trim();
      const b = Number(raw);
      if (raw !== 'max' && Number.isFinite(b) && b > 0 && b / 1048576 < mb) mb = b / 1048576;
    } catch {
      /* not in a cgroup / not readable */
    }
  }
  return Math.floor(mb);
}

function positiveInt(raw, fallback) {
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isSet(v) {
  return v != null && String(v).trim() !== '' && String(v).trim().toLowerCase() !== 'auto';
}

/** All CPUs on small boxes, else WEB_CPU_FRACTION of them (≥ 8): LiveKit keeps the rest. */
function autoWorkers(cpus) {
  if (cpus <= SMALL_BOX_CPUS) return cpus;
  const f = Number.parseFloat(String(process.env.WEB_CPU_FRACTION ?? ''));
  const frac = Number.isFinite(f) && f > 0 && f <= 1 ? f : DEFAULT_WEB_CPU_FRACTION;
  return Math.max(SMALL_BOX_CPUS, Math.round(cpus * frac));
}

/** { workers, pool }: one worker per core; the Prisma pool shrinks to fit Postgres. */
function workerPlan() {
  const cpus = Math.max(1, (typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length) || 1);
  const maxConn = positiveInt(process.env.POSTGRES_MAX_CONNECTIONS, DEFAULT_MAX_CONN);
  const budget = Math.max(1, maxConn - HEADROOM);
  const explicit = isSet(process.env.WEB_WORKERS);
  let n = explicit ? positiveInt(process.env.WEB_WORKERS, cpus) : autoWorkers(cpus);
  n = Math.max(1, Math.min(MAX_WORKERS, n));
  const pool = isSet(process.env.DB_POOL_PER_WORKER)
    ? Math.min(64, positiveInt(process.env.DB_POOL_PER_WORKER, DEFAULT_POOL))
    : Math.max(MIN_AUTO_POOL, Math.min(DEFAULT_POOL, Math.floor(budget / n)));
  const fit = Math.max(1, Math.floor(budget / pool));
  if (!explicit && n > fit) {
    console.warn(`[classroom] capping WEB_WORKERS ${n} → ${fit} so ${fit}×${pool} Prisma pools fit max_connections=${maxConn}`);
    n = fit;
  }
  return { workers: n, pool };
}

function patchHttpTimeouts() {
  // Keepalive must outlive Caddy's upstream keepalive (infra/Caddyfile: 55s) or Caddy reuses a closing socket
  // and the client sees a 502. headersTimeout must be > keepAliveTimeout.
  const keepAlive = positiveInt(process.env.NODE_KEEPALIVE_MS, 65_000);
  const headersTimeout = positiveInt(process.env.NODE_HEADERS_TIMEOUT_MS, 66_000);
  const maxHeaders = positiveInt(process.env.NODE_MAX_HEADERS, 200);
  const orig = http.createServer;
  http.createServer = function patchedCreateServer(...args) {
    const server = orig.apply(this, args);
    server.keepAliveTimeout = keepAlive;
    server.headersTimeout = headersTimeout;
    server.maxHeadersCount = maxHeaders;
    // Node 18+ kills any request after requestTimeout (default 300 s), which
    // cut the chat SSE stream every 5 minutes ("incomplete response" in
    // Caddy). Long-lived streams are bounded by keepalive pings instead.
    server.requestTimeout = 0;
    server.timeout = 0;
    return server;
  };
}

function startWorker() {
  patchHttpTimeouts();
  const standalone = path.join(__dirname, 'server.js');
  if (!fs.existsSync(standalone)) {
    console.error('[classroom] server.js missing. Build with `next build` (output: standalone) or start via Docker.');
    process.exit(1);
  }
  require(standalone);
  watchMemory();
}

// A worker whose RSS passes WEB_WORKER_MAX_RSS_MB (default: WEB_MEM_FRACTION of RAM / workers, 512–4096; 0 = off)
// asks the primary to replace it: a fresh worker starts first, then the old
// one stops taking connections and drains. One recycle at a time, so a slow
// leak never takes capacity down. The heap cap (WEB_WORKER_HEAP_MB) is the
// hard stop if a leak outruns this check.
function watchMemory() {
  const limitMb = Number.parseInt(process.env.WEB_WORKER_MAX_RSS_MB || '1536', 10);
  if (!cluster.isWorker || !(limitMb > 0) || typeof process.send !== 'function') return;
  let asked = false;
  const t = setInterval(() => {
    const rssMb = process.memoryUsage.rss() / 1048576;
    if (!asked && rssMb > limitMb) {
      asked = true;
      console.warn(`[classroom] worker ${process.pid} rss ${Math.round(rssMb)} MB > ${limitMb} MB; asking to recycle`);
      process.send({ type: 'classroom:recycle' });
    }
  }, 30_000 + Math.floor(Math.random() * 10_000));
  t.unref();
}

const plan = workerPlan();
const n = plan.workers;
const port = process.env.PORT || '3000';
// Workers read DB_POOL_PER_WORKER (src/lib/dbUrl.ts): hand them the computed size.
process.env.DB_POOL_PER_WORKER = String(plan.pool);

if (cluster.isPrimary && n > 1) {
  console.log(`[classroom] primary ${process.pid} starting ${n} web workers on :${port} (Prisma pool ${plan.pool} each)`);
  // Memory budget (mirrors workerMemoryPlan in src/lib/webWorkers.ts): web workers
  // together get WEB_MEM_FRACTION (default 0.5) of available RAM, 512–4096 MB
  // each; the V8 heap cap is 80% of that. Overrides: WEB_WORKER_MAX_RSS_MB, WEB_WORKER_HEAP_MB.
  const mf = Number.parseFloat(String(process.env.WEB_MEM_FRACTION ?? ''));
  const memFrac = Number.isFinite(mf) && mf > 0 && mf <= 0.9 ? mf : DEFAULT_WEB_MEM_FRACTION;
  const autoRss = Math.max(512, Math.min(4096, Math.floor((availableMemMb() * memFrac) / n)));
  if (!process.env.WEB_WORKER_MAX_RSS_MB) process.env.WEB_WORKER_MAX_RSS_MB = String(autoRss);
  const rssForHeap = Number.parseInt(process.env.WEB_WORKER_MAX_RSS_MB, 10) > 0 ? Number.parseInt(process.env.WEB_WORKER_MAX_RSS_MB, 10) : autoRss;
  const heapMb = positiveInt(process.env.WEB_WORKER_HEAP_MB, Math.max(384, Math.floor(rssForHeap * HEAP_OF_RSS)));
  console.log(`[classroom] per-worker memory: recycle above ${process.env.WEB_WORKER_MAX_RSS_MB} MB RSS, heap cap ${heapMb} MB`);
  cluster.setupPrimary({ execArgv: [...process.execArgv, `--max-old-space-size=${heapMb}`] });
  for (let i = 0; i < n; i++) cluster.fork();
  let recycling = false;
  cluster.on('message', (worker, msg) => {
    if (!msg || msg.type !== 'classroom:recycle' || recycling) return;
    recycling = true;
    const fresh = cluster.fork();
    fresh.once('listening', () => {
      worker.disconnect();
      const kill = setTimeout(() => worker.process.kill('SIGTERM'), 60_000);
      worker.once('exit', () => {
        clearTimeout(kill);
        recycling = false;
      });
    });
    fresh.once('exit', () => {
      recycling = false;
    });
  });
  cluster.on('exit', (worker, code, signal) => {
    if (worker.exitedAfterDisconnect) return;
    console.error(`[classroom] worker ${worker.process.pid} stopped (${signal || code}); restarting`);
    cluster.fork();
  });
  const shutdown = () => {
    for (const id of Object.keys(cluster.workers || {})) {
      try {
        cluster.workers[id]?.process.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} else {
  if (n === 1) console.log(`[classroom] single web process ${process.pid} on :${port}`);
  startWorker();
}
