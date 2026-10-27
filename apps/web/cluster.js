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
const DEFAULT_WEB_LIMIT_FRACTION = 0.85;
const HEAP_OF_RSS = 0.8;

/** Physical RAM, or the container's cgroup memory limit when lower (`limited`). */
function availableMem() {
  let mb = os.totalmem() / 1048576;
  let limited = false;
  for (const f of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const raw = fs.readFileSync(f, 'utf8').trim();
      const b = Number(raw);
      if (raw !== 'max' && Number.isFinite(b) && b > 0 && b / 1048576 < mb) {
        mb = b / 1048576;
        limited = true;
      }
    } catch {
      /* not in a cgroup / not readable */
    }
  }
  return { mb: Math.floor(mb), limited };
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

/** HTTP servers created in this process (Next's), for graceful shutdown. */
const servers = [];

/** Header carrying the TCP peer address to the app (lib/clientIp.ts). Never trusted from the client. */
const PEER_HEADER = 'x-classroom-peer';

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
    // Stamp the real TCP peer before Next sees the request (overwriting any
    // client-sent value): the app trusts X-Forwarded-For only when this peer
    // is a configured proxy (TRUSTED_PROXIES, default loopback = Caddy).
    server.prependListener('request', (req) => {
      req.headers[PEER_HEADER] = req.socket?.remoteAddress || '';
    });
    servers.push(server);
    return server;
  };
}

/**
 * Worker shutdown (SIGTERM from the primary, or Docker in single-process
 * mode): stop accepting connections, let in-flight requests finish, then
 * close what is left (chat SSE streams never finish on their own; clients
 * reconnect) and exit. Next's own handler waits for every connection to end,
 * which an SSE stream never does, so it is turned off (NEXT_MANUAL_SIG_HANDLE).
 */
function installWorkerShutdown() {
  const graceMs = positiveInt(process.env.WEB_SHUTDOWN_GRACE_MS, 10_000);
  let stopping = false;
  const stop = (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`[classroom] worker ${process.pid} ${sig}: draining (up to ${graceMs} ms)`);
    for (const s of servers) {
      try {
        s.close();
        s.closeIdleConnections?.();
      } catch {
        /* already closed */
      }
    }
    const hooks = globalThis.__classroomShutdownHooks || [];
    const done = Promise.allSettled(hooks.map((fn) => Promise.resolve().then(fn)));
    const timer = setTimeout(() => finish('grace elapsed'), graceMs);
    timer.unref();
    done.then(() => {
      // In-flight requests get the rest of the grace period.
      const waitIdle = setInterval(() => {
        if (servers.every((s) => !s.listening)) {
          clearInterval(waitIdle);
          finish('drained');
        }
      }, 250);
      waitIdle.unref();
    });
  };
  const finish = (why) => {
    for (const s of servers) {
      try {
        s.closeAllConnections?.();
      } catch {
        /* ignore */
      }
    }
    console.log(`[classroom] worker ${process.pid} exiting (${why})`);
    process.exit(0);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

function startWorker() {
  patchHttpTimeouts();
  process.env.NEXT_MANUAL_SIG_HANDLE = '1';
  installWorkerShutdown();
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

// Even one worker runs under the primary (a ~35 MB supervisor): the worker
// gets the heap cap and RSS recycling, and a crash restarts it in place
// instead of taking the container down. WEB_SINGLE_PROCESS=1 skips it.
if (cluster.isPrimary && (n > 1 || process.env.WEB_SINGLE_PROCESS !== '1')) {
  console.log(`[classroom] primary ${process.pid} starting ${n} web workers on :${port} (Prisma pool ${plan.pool} each)`);
  // Memory budget (mirrors workerMemoryPlan in src/lib/webWorkers.ts): web workers
  // together get WEB_MEM_FRACTION (default 0.5) of available RAM, 512–4096 MB
  // each; the V8 heap cap is 80% of that. Overrides: WEB_WORKER_MAX_RSS_MB, WEB_WORKER_HEAP_MB.
  // Inside a container memory limit (WEB_MEM_LIMIT) the workers own that
  // limit: WEB_MEM_LIMIT_FRACTION (0.85) of it, not WEB_MEM_FRACTION of the host.
  const mem = availableMem();
  const mf = Number.parseFloat(String((mem.limited ? process.env.WEB_MEM_LIMIT_FRACTION : process.env.WEB_MEM_FRACTION) ?? ''));
  const memFrac = Number.isFinite(mf) && mf > 0 && mf <= 0.95 ? mf : mem.limited ? DEFAULT_WEB_LIMIT_FRACTION : DEFAULT_WEB_MEM_FRACTION;
  const floor = mem.limited ? 256 : 512;
  const autoRss = Math.max(floor, Math.min(4096, Math.floor((mem.mb * memFrac) / n)));
  if (!process.env.WEB_WORKER_MAX_RSS_MB) process.env.WEB_WORKER_MAX_RSS_MB = String(autoRss);
  const rssForHeap = Number.parseInt(process.env.WEB_WORKER_MAX_RSS_MB, 10) > 0 ? Number.parseInt(process.env.WEB_WORKER_MAX_RSS_MB, 10) : autoRss;
  const heapMb = positiveInt(process.env.WEB_WORKER_HEAP_MB, Math.max(mem.limited ? 192 : 384, Math.floor(rssForHeap * HEAP_OF_RSS)));
  console.log(`[classroom] per-worker memory: recycle above ${process.env.WEB_WORKER_MAX_RSS_MB} MB RSS, heap cap ${heapMb} MB`);
  cluster.setupPrimary({ execArgv: [...process.execArgv, `--max-old-space-size=${heapMb}`] });
  for (let i = 0; i < n; i++) cluster.fork();
  let recycling = false;
  cluster.on('message', (worker, msg) => {
    if (!msg || msg.type !== 'classroom:recycle' || recycling) return;
    recycling = true;
    if (mem.limited && n === 1) {
      // One worker inside a container limit: there is no room for a second
      // process next to a bloated one. Stop it (SIGTERM drains), then start
      // a fresh one; clients retry for the few seconds in between.
      worker.once('exit', () => {
        cluster.fork();
        recycling = false;
      });
      worker.disconnect();
      setTimeout(() => worker.process.kill('SIGTERM'), 15_000).unref();
      return;
    }
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
  let shuttingDown = false;
  cluster.on('exit', (worker, code, signal) => {
    if (shuttingDown) {
      if (!Object.keys(cluster.workers || {}).length) {
        console.log('[classroom] all workers stopped');
        process.exit(0);
      }
      return;
    }
    if (worker.exitedAfterDisconnect) return;
    console.error(`[classroom] worker ${worker.process.pid} stopped (${signal || code}); restarting`);
    cluster.fork();
  });
  // Graceful stop: every worker drains (installWorkerShutdown) and exits; the
  // primary exits when the last one is gone, well inside Docker's
  // stop_grace_period. Nothing is restarted while shutting down.
  const shutdown = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const workers = Object.values(cluster.workers || {});
    console.log(`[classroom] primary ${sig}: stopping ${workers.length} worker(s)`);
    for (const w of workers) {
      try {
        w?.process.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    if (!workers.length) process.exit(0);
    const hardStop = positiveInt(process.env.WEB_SHUTDOWN_GRACE_MS, 10_000) + 5_000;
    setTimeout(() => {
      console.warn('[classroom] workers did not stop in time; exiting');
      process.exit(0);
    }, hardStop).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
} else {
  if (cluster.isPrimary) console.log(`[classroom] single web process ${process.pid} on :${port}`);
  startWorker();
}
