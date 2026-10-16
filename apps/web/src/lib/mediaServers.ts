/**
 * Multi-server media (LiveKit) registry.
 *
 * One web/DB/Redis server, N LiveKit media nodes. Each class's LiveKit room is
 * assigned to ONE media node for the whole session (sticky in Redis), chosen as
 * the least-loaded node by student count relative to its capacity. Tokens are
 * signed with that node's key and the browser gets that node's URL.
 *
 * Configuration (env, read at start):
 *   LIVEKIT_SERVERS='[{"id":"m1","url":"wss://m1.example.com","httpUrl":"https://m1.example.com",
 *                      "apiKey":"...","apiSecret":"...","capacity":200}, ...]'
 * When LIVEKIT_SERVERS is unset (the default) there is exactly one node built
 * from LIVEKIT_API_KEY / LIVEKIT_API_SECRET / LIVEKIT_INTERNAL_URL and the
 * public URL logic in lib/url, and no Redis lookup happens at all, so a
 * single-server deploy behaves exactly as before.
 *
 * Admin override: a JSON list stored in Redis under `media:servers:disabled`
 * (set via /api/admin/media-servers) drains nodes: no NEW rooms go there.
 */
import { ensureRedis } from './redis';

export type MediaServer = {
  id: string;
  /** Browser WebSocket URL; undefined = derive from the request (single-node default). */
  url?: string;
  /** Server API URL (http/https) used by RoomServiceClient. */
  httpUrl: string;
  apiKey: string;
  apiSecret: string;
  /** Students this node carries with good quality (~200 per 200 Mbps-egress node). */
  capacity: number;
};

export const DEFAULT_CAPACITY = 200;
const ASSIGN_TTL_S = 12 * 60 * 60;
const LOAD_TTL_S = 12 * 60 * 60;

export const mediaKeys = {
  assign: (roomName: string) => `media:room:${roomName}`,
  load: (serverId: string) => `media:load:${serverId}`,
  disabled: 'media:servers:disabled',
};

function defaultServer(env: NodeJS.ProcessEnv): MediaServer {
  return {
    id: 'default',
    url: undefined,
    httpUrl: env.LIVEKIT_INTERNAL_URL || env.LIVEKIT_URL?.replace(/^ws/, 'http') || 'http://localhost:7880',
    apiKey: env.LIVEKIT_API_KEY || '',
    apiSecret: env.LIVEKIT_API_SECRET || '',
    capacity: Number(env.LIVEKIT_CAPACITY) || DEFAULT_CAPACITY,
  };
}

/** Pure: parse the registry from env. Bad entries are skipped; empty → the default node. */
export function parseMediaServers(env: NodeJS.ProcessEnv = process.env): MediaServer[] {
  const raw = (env.LIVEKIT_SERVERS || '').trim();
  if (!raw) return [defaultServer(env)];
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    console.warn('LIVEKIT_SERVERS is not valid JSON; using the single default media server');
    return [defaultServer(env)];
  }
  if (!Array.isArray(list)) return [defaultServer(env)];
  const out: MediaServer[] = [];
  const seen = new Set<string>();
  for (const e of list as Record<string, unknown>[]) {
    const id = String(e?.id ?? '').trim();
    const httpUrl = String(e?.httpUrl ?? '').trim() || String(e?.url ?? '').replace(/^ws/, 'http');
    const apiKey = String(e?.apiKey ?? env.LIVEKIT_API_KEY ?? '');
    const apiSecret = String(e?.apiSecret ?? env.LIVEKIT_API_SECRET ?? '');
    if (!id || seen.has(id) || !httpUrl || !apiKey || !apiSecret) continue;
    seen.add(id);
    out.push({
      id,
      url: e?.url ? String(e.url) : undefined,
      httpUrl,
      apiKey,
      apiSecret,
      capacity: Math.max(1, Number(e?.capacity) || DEFAULT_CAPACITY),
    });
  }
  return out.length ? out : [defaultServer(env)];
}

let cached: MediaServer[] | null = null;
export function mediaServers(): MediaServer[] {
  cached ??= parseMediaServers();
  return cached;
}
/** Tests only. */
export function resetMediaServersCache() {
  cached = null;
  assignCache.clear();
}

export function serverById(id: string | null | undefined): MediaServer | undefined {
  return mediaServers().find((s) => s.id === id);
}

/**
 * Pure: least-loaded node by load/capacity (ties → fewer students, then
 * registry order). Disabled (draining) nodes are skipped unless all are.
 */
export function pickLeastLoaded(
  servers: MediaServer[],
  load: Record<string, number>,
  disabled: ReadonlySet<string> = new Set()
): MediaServer {
  const usable = servers.filter((s) => !disabled.has(s.id));
  const pool = usable.length ? usable : servers;
  let best = pool[0]!;
  let bestScore = Infinity;
  for (const s of pool) {
    const n = load[s.id] ?? 0;
    const score = n / s.capacity;
    if (score < bestScore - 1e-9 || (Math.abs(score - bestScore) < 1e-9 && n < (load[best.id] ?? 0))) {
      best = s;
      bestScore = score;
    }
  }
  return best;
}

/** In-process cache of room → node (sticky anyway; saves a Redis hop per API call). */
const assignCache = new Map<string, { id: string; at: number }>();
const ASSIGN_CACHE_MS = 60_000;

async function currentLoads(servers: MediaServer[]): Promise<Record<string, number>> {
  const r = await ensureRedis();
  const out: Record<string, number> = {};
  const m = r.multi();
  for (const s of servers) m.hvals(mediaKeys.load(s.id));
  const res = (await m.exec()) ?? [];
  servers.forEach((s, i) => {
    const vals = (res[i]?.[1] as string[] | undefined) ?? [];
    out[s.id] = vals.reduce((a, v) => a + (Number(v) || 0), 0);
  });
  return out;
}

/**
 * The media node for a LiveKit room. Assigns one (least loaded) the first
 * time and keeps it for the session. N=1: returns the only node, no I/O.
 */
export async function serverForRoom(roomName: string): Promise<MediaServer> {
  const servers = mediaServers();
  if (servers.length === 1) return servers[0]!;
  const hit = assignCache.get(roomName);
  if (hit && Date.now() - hit.at < ASSIGN_CACHE_MS) {
    const s = serverById(hit.id);
    if (s) return s;
  }
  try {
    const r = await ensureRedis();
    const existing = await r.get(mediaKeys.assign(roomName));
    let s = serverById(existing);
    if (!s) {
      const disabled = new Set<string>(JSON.parse((await r.get(mediaKeys.disabled)) || '[]'));
      const pick = pickLeastLoaded(servers, await currentLoads(servers), disabled);
      // NX: two concurrent first joins agree on one node.
      const ok = await r.set(mediaKeys.assign(roomName), pick.id, 'EX', ASSIGN_TTL_S, 'NX');
      s = ok ? pick : serverById(await r.get(mediaKeys.assign(roomName))) ?? pick;
      await r.hset(mediaKeys.load(s.id), roomName, '0').then(() => r.expire(mediaKeys.load(s!.id), LOAD_TTL_S));
    }
    assignCache.set(roomName, { id: s.id, at: Date.now() });
    return s;
  } catch (e) {
    console.warn('media server assignment failed; using the first node', e instanceof Error ? e.message : e);
    return servers[0]!;
  }
}

/** Record a room's student count (token issuance) so new rooms avoid busy nodes. N=1: no-op. */
export async function noteRoomLoad(roomName: string, students: number): Promise<void> {
  if (mediaServers().length === 1) return;
  try {
    const s = await serverForRoom(roomName);
    const r = await ensureRedis();
    await r.multi().hset(mediaKeys.load(s.id), roomName, String(Math.max(0, students))).expire(mediaKeys.load(s.id), LOAD_TTL_S).exec();
  } catch {
    /* best effort */
  }
}

/** Class ended: free the node's share. N=1: no-op. */
export async function releaseRoom(roomName: string): Promise<void> {
  assignCache.delete(roomName);
  if (mediaServers().length === 1) return;
  try {
    const r = await ensureRedis();
    const id = await r.get(mediaKeys.assign(roomName));
    const m = r.multi().del(mediaKeys.assign(roomName));
    if (id) m.hdel(mediaKeys.load(id), roomName);
    await m.exec();
  } catch {
    /* best effort */
  }
}

/** Admin view: every node with its current student load and rooms. */
export async function mediaServerStatus() {
  const servers = mediaServers();
  const disabled = new Set<string>();
  let loads: Record<string, number> = {};
  if (servers.length > 1) {
    try {
      const r = await ensureRedis();
      for (const id of JSON.parse((await r.get(mediaKeys.disabled)) || '[]')) disabled.add(String(id));
      loads = await currentLoads(servers);
    } catch {
      /* ignore */
    }
  }
  return servers.map((s) => ({
    id: s.id,
    url: s.url ?? '(request host)',
    capacity: s.capacity,
    students: loads[s.id] ?? null,
    draining: disabled.has(s.id),
  }));
}

export async function setDrainingServers(ids: string[]): Promise<void> {
  const r = await ensureRedis();
  const known = new Set(mediaServers().map((s) => s.id));
  await r.set(mediaKeys.disabled, JSON.stringify(ids.filter((id) => known.has(id))));
}
