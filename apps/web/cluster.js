'use strict';
/**
 * Production entry: fork WEB_WORKERS Node processes (default = CPU count)
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

const DEFAULT_POOL = 8;
const DEFAULT_MAX_CONN = 280;
const HEADROOM = 24;
const MAX_WORKERS = 64;

function positiveInt(raw, fallback) {
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function workerCount() {
  const cpus = Math.max(1, os.cpus().length);
  const pool = Math.min(64, positiveInt(process.env.DB_POOL_PER_WORKER, DEFAULT_POOL));
  const maxConn = positiveInt(process.env.POSTGRES_MAX_CONNECTIONS, DEFAULT_MAX_CONN);
  const fit = Math.max(1, Math.floor((maxConn - HEADROOM) / pool));
  const explicit = process.env.WEB_WORKERS != null && String(process.env.WEB_WORKERS).trim() !== '';
  let n = explicit ? positiveInt(process.env.WEB_WORKERS, cpus) : cpus;
  n = Math.max(1, Math.min(MAX_WORKERS, n));
  if (!explicit && n > fit) {
    console.warn(
      `[classroom] capping WEB_WORKERS ${n} → ${fit} so ${fit}×${pool} Prisma pools fit max_connections=${maxConn}`
    );
    n = fit;
  }
  return n;
}

function patchHttpTimeouts() {
  // Keepalive must outlive Caddy's (default 60s) or Caddy reuses a closing socket
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
}

const n = workerCount();
const port = process.env.PORT || '3000';

if (cluster.isPrimary && n > 1) {
  console.log(`[classroom] primary ${process.pid} starting ${n} web workers on :${port}`);
  for (let i = 0; i < n; i++) cluster.fork();
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
