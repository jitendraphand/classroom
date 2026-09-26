/**
 * Public URL helpers for local + bare public-IP (no domain) deploys.
 *
 * Join links prefer the incoming request Host/Origin so operators who hit
 * http://PUBLIC_IP:3000 get shareable links on that IP even if APP_URL is stale.
 * LiveKit browser URL prefers NEXT_PUBLIC_LIVEKIT_URL when it is non-loopback;
 * otherwise it is derived from the request host (ws/wss://host:7880).
 */

function stripTrailingSlash(s: string) {
  return s.replace(/\/$/, '');
}

function hostnameOf(urlOrHost: string): string {
  try {
    if (urlOrHost.includes('://')) return new URL(urlOrHost).hostname;
  } catch {
    /* fall through */
  }
  return urlOrHost.split(':')[0] || urlOrHost;
}

export function isLoopbackHost(hostOrUrl: string): boolean {
  const h = hostnameOf(hostOrUrl).toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0';
}

/** Cookie Secure must be false on bare HTTP (including public IP). */
export function cookieSecureFlag(): boolean {
  if (process.env.COOKIE_SECURE === 'true') return true;
  if (process.env.COOKIE_SECURE === 'false') return false;
  const url = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || '';
  if (url.startsWith('https://')) return true;
  if (url.startsWith('http://')) return false;
  return false;
}

export function getConfiguredAppUrl(): string {
  const fromEnv = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || '';
  if (fromEnv) return stripTrailingSlash(fromEnv);
  return 'http://localhost:3000';
}

/**
 * Resolve the public app base URL for join/share links.
 * Prefer non-loopback Origin / Host from the request; else configured APP_URL.
 */
export function resolveAppUrl(req?: Request): string {
  if (req) {
    const origin = req.headers.get('origin');
    if (origin && !isLoopbackHost(origin)) {
      return stripTrailingSlash(origin);
    }
    const xfHost = req.headers.get('x-forwarded-host');
    const host = (xfHost || req.headers.get('host') || '').split(',')[0]?.trim();
    if (host && !isLoopbackHost(host)) {
      const xfProto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
      const configured = getConfiguredAppUrl();
      const proto =
        xfProto ||
        (configured.startsWith('https://') ? 'https' : 'http');
      return stripTrailingSlash(`${proto}://${host}`);
    }
  }
  return getConfiguredAppUrl();
}

/**
 * Browser-facing LiveKit WebSocket URL.
 * Prefer non-loopback NEXT_PUBLIC_LIVEKIT_URL; else derive from request host :7880.
 */
export function resolvePublicLiveKitUrl(req?: Request): string {
  const fromEnv = process.env.NEXT_PUBLIC_LIVEKIT_URL || '';
  if (fromEnv && !isLoopbackHost(fromEnv)) {
    return fromEnv;
  }

  if (req) {
    const app = resolveAppUrl(req);
    if (!isLoopbackHost(app)) {
      try {
        const u = new URL(app);
        const wsProto = u.protocol === 'https:' ? 'wss:' : 'ws:';
        const port = process.env.LIVEKIT_PUBLIC_PORT || '7880';
        return `${wsProto}//${u.hostname}:${port}`;
      } catch {
        /* fall through */
      }
    }
  }

  return fromEnv || 'ws://localhost:7880';
}
