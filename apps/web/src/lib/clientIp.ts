/**
 * The client's IP for rate limits. Pure (Edge- and test-safe).
 *
 * cluster.js stamps every request with the TCP peer address
 * (`x-classroom-peer`, overwriting anything a client sends). X-Forwarded-For
 * is only believed when that peer is a trusted proxy (TRUSTED_PROXIES:
 * comma-separated IPs or IPv4 CIDRs; default loopback, i.e. Caddy on the same
 * host). Then the right-most address that is not itself a trusted proxy is the
 * client. On a bare-IP deploy (browsers connect straight to Node) the peer is
 * the client and a forged X-Forwarded-For is ignored.
 */
export const PEER_HEADER = 'x-classroom-peer';

const LOOPBACK = ['127.0.0.0/8', '::1'];

function stripV4Mapped(ip: string): string {
  const s = ip.trim().toLowerCase();
  return s.startsWith('::ffff:') && s.includes('.') ? s.slice(7) : s;
}

function v4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

export function ipMatches(ip: string, rule: string): boolean {
  const a = stripV4Mapped(ip);
  const r = rule.trim().toLowerCase();
  if (!r) return false;
  if (!r.includes('/')) return a === stripV4Mapped(r);
  const [base, bitsRaw] = r.split('/') as [string, string];
  const bits = Number(bitsRaw);
  const ai = v4ToInt(a);
  const bi = v4ToInt(stripV4Mapped(base));
  if (ai == null || bi == null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~0 << (32 - bits)) >>> 0;
  return ((ai & mask) >>> 0) === ((bi & mask) >>> 0);
}

export function trustedProxies(env: Record<string, string | undefined> = process.env): string[] {
  const extra = (env.TRUSTED_PROXIES ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  return [...LOOPBACK, ...extra];
}

function isTrusted(ip: string, rules: string[]) {
  return rules.some((r) => ipMatches(ip, r));
}

export function clientIpFrom(
  headers: { get(name: string): string | null },
  env: Record<string, string | undefined> = process.env
): string {
  const rules = trustedProxies(env);
  const peer = headers.get(PEER_HEADER)?.trim() || '';
  const xff = (headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  // `next dev` (no cluster.js): no peer stamp; dev only, take the proxy header.
  if (!peer) return xff.at(-1) || headers.get('x-real-ip')?.trim() || 'unknown';
  if (!isTrusted(peer, rules)) return stripV4Mapped(peer);
  for (let i = xff.length - 1; i >= 0; i--) {
    if (!isTrusted(xff[i]!, rules)) return stripV4Mapped(xff[i]!);
  }
  return stripV4Mapped(xff[0] || peer);
}
