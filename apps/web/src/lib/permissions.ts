/**
 * Browser media permission pre-checks, browser-specific inline guidance,
 * separate camera/mic requests, and prompt-grace coordination so permission
 * dialogs on Android Chrome / Desktop / iOS Safari never trigger false
 * fullscreen-exit covers, teacher alerts, or disconnects.
 */

export type PermissionStateEx = 'granted' | 'denied' | 'prompt' | 'unknown';
export type MediaKind = 'camera' | 'microphone';
export type MediaErrorKind =
  | 'denied'
  | 'needs-gesture'
  | 'not-found'
  | 'in-use'
  | 'insecure'
  | 'unsupported'
  | 'unknown';

export type PermissionBrowserKind =
  | 'chrome-android'
  | 'ios-safari'
  | 'desktop-chromium'
  | 'firefox'
  | 'safari-mac'
  | 'other';

export type MediaAccessIssue = {
  media: MediaKind;
  kind: MediaErrorKind;
  title: string;
  message: string;
  hint: string;
  canRetry: boolean;
};

export function detectPermissionBrowser(ua: string, maxTouchPoints = 0): PermissionBrowserKind {
  const isIOS =
    /iPhone|iPad|iPod|CriOS|FxiOS/i.test(ua) || (/Macintosh/i.test(ua) && maxTouchPoints > 1);
  if (isIOS) return 'ios-safari';
  if (/Android/i.test(ua) && /Chrome|Chromium|EdgA|SamsungBrowser/i.test(ua)) return 'chrome-android';
  if (/Firefox|FxiOS/i.test(ua)) return 'firefox';
  if (/Safari/i.test(ua) && !/Chrome|Chromium|Edg|OPR|Android/i.test(ua)) return 'safari-mac';
  if (/Chrome|Chromium|Edg\//i.test(ua)) return 'desktop-chromium';
  return 'other';
}

export function permissionDeniedHint(media: MediaKind, browser: PermissionBrowserKind): string {
  const label = media === 'camera' ? 'Camera' : 'Microphone';
  // Two places can block it: the site setting in the browser, and the device's
  // own setting for the browser app (Nov 27: both are named, because a block in
  // the device settings never shows a popup either).
  switch (browser) {
    case 'chrome-android':
      return `Tap the tune/lock icon to the left of the address bar → Permissions → ${label} → Allow (or "Reset permissions"). If it is already allowed: Android Settings → Apps → Chrome → Permissions → ${label} → Allow. Then tap Try again.`;
    case 'ios-safari':
      return `Tap "aA" in the address bar → Website Settings → ${label} → Allow. Also check Settings → Safari → ${label} → Allow (or Settings → Chrome → ${label} for Chrome). Then tap Try again.`;
    case 'desktop-chromium':
      return `Click the tune/lock icon on the left of the address bar → ${label} → Allow (or "Reset permission"), then reload. Also check the computer's privacy settings (Windows: Settings → Privacy → ${label}; Mac: System Settings → Privacy & Security → ${label} → your browser).`;
    case 'firefox':
      return `Click the crossed-out ${label.toLowerCase()} icon in the address bar → remove the block, then click Try again. Also check the computer's privacy settings for ${label.toLowerCase()} access.`;
    case 'safari-mac':
      return `Safari → Settings for This Website → ${label} → Allow. Also check System Settings → Privacy & Security → ${label} → Safari. Then click Try again.`;
    default:
      return `Allow ${label.toLowerCase()} for this site in your browser's settings, and for the browser in your device's privacy settings, then tap Try again.`;
  }
}

export function classifyMediaError(
  err: unknown,
  opts?: { secureContext?: boolean; hasMediaDevices?: boolean; permState?: PermissionStateEx }
): MediaErrorKind {
  if (opts?.secureContext === false) return 'insecure';
  if (opts?.hasMediaDevices === false) return 'unsupported';
  const name =
    err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
  const msg =
    err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : String(err || '');

  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    // If the browser's permission state is NOT 'denied' (e.g. 'prompt' or Safari 'unknown')
    // and getUserMedia failed outside a tap gesture, a direct tap often succeeds.
    // Chrome: "Permission dismissed" (the popup was closed, or Chrome stopped
    // showing it after several closes): no popup comes on the next try either.
    if (/dismiss/i.test(msg)) return 'denied';
    if (opts?.permState === 'prompt') return 'needs-gesture';
    if (/gesture|user activation/i.test(msg)) return 'needs-gesture';
    return 'denied';
  }
  if (name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return 'not-found';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return 'in-use';
  }
  return 'unknown';
}

export function buildMediaIssue(opts: {
  media: MediaKind;
  err?: unknown;
  permState?: PermissionStateEx;
  ua?: string;
  maxTouchPoints?: number;
  secureContext?: boolean;
  hasMediaDevices?: boolean;
  /** True when the teacher unmuted a student and mic capture hit a non-denied block. */
  unmutedPrompt?: boolean;
  /**
   * The request came straight from the user's tap and still failed: the
   * browser is not going to show a popup, so explain how to unblock it
   * instead of "tap Allow when your browser asks" again (Nov 27).
   */
  afterTap?: boolean;
}): MediaAccessIssue {
  const label = opts.media === 'camera' ? 'Camera' : 'Microphone';
  const lower = label.toLowerCase();
  const ua = opts.ua ?? (typeof navigator !== 'undefined' ? navigator.userAgent || '' : '');
  const touch = opts.maxTouchPoints ?? (typeof navigator !== 'undefined' ? navigator.maxTouchPoints || 0 : 0);
  const browser = detectPermissionBrowser(ua, touch);

  let kind: MediaErrorKind;
  if (opts.permState === 'denied' && !opts.err) {
    kind = 'denied';
  } else {
    kind = classifyMediaError(opts.err, {
      secureContext: opts.secureContext,
      hasMediaDevices: opts.hasMediaDevices,
      permState: opts.permState,
    });
  }

  if (opts.afterTap && (kind === 'needs-gesture' || kind === 'denied')) {
    return {
      media: opts.media,
      kind: 'denied',
      title: `${label} is blocked`,
      message: `Your browser did not show the permission popup: the ${lower} is blocked for this site or for the browser. You stay in the class either way.`,
      hint: permissionDeniedHint(opts.media, browser),
      canRetry: true,
    };
  }

  if (kind === 'needs-gesture' || (opts.unmutedPrompt && kind === 'denied' && opts.permState !== 'denied')) {
    return {
      media: opts.media,
      kind: 'needs-gesture',
      title: opts.media === 'microphone' && opts.unmutedPrompt ? 'Tap to turn on your microphone' : `${label} permission needed`,
      message:
        opts.media === 'microphone' && opts.unmutedPrompt
          ? 'Your teacher unmuted you. Tap below to allow your microphone without leaving class.'
          : `Tap below to allow ${lower} access. You stay in the class either way.`,
      hint:
        kind === 'denied' || browser === 'ios-safari'
          ? permissionDeniedHint(opts.media, browser)
          : `Tap Allow when your browser asks for ${lower} access.`,
      canRetry: true,
    };
  }

  if (kind === 'denied') {
    return {
      media: opts.media,
      kind,
      title: `${label} is blocked`,
      message: `You can stay in class (listen & watch). Allow ${lower} whenever you are ready.`,
      hint: permissionDeniedHint(opts.media, browser),
      canRetry: true,
    };
  }
  if (kind === 'not-found') {
    return {
      media: opts.media,
      kind,
      title: `No ${lower} found`,
      message: `No working ${lower} was detected on this device. You can stay in class and retry if you plug one in.`,
      hint: `Connect a ${lower} or check device settings, then tap Try again.`,
      canRetry: true,
    };
  }
  if (kind === 'in-use') {
    return {
      media: opts.media,
      kind,
      title: `${label} is busy`,
      message: `Another app is using your ${lower}, or it stopped after switching apps.`,
      hint: `Close other apps using the ${lower} and tap Try again.`,
      canRetry: true,
    };
  }
  if (kind === 'insecure') {
    return {
      media: opts.media,
      kind,
      title: `${label} needs HTTPS`,
      message: `${label} access requires a secure https:// connection.`,
      hint: 'Reopen this class using the https:// link.',
      canRetry: false,
    };
  }
  if (kind === 'unsupported') {
    return {
      media: opts.media,
      kind,
      title: `${label} unavailable`,
      message: `This browser cannot open a ${lower} here.`,
      hint: 'Use a current version of Chrome, Edge, Firefox, or Safari over https.',
      canRetry: false,
    };
  }
  return {
    media: opts.media,
    kind: 'unknown',
    title: `${label} could not start`,
    message: `Could not start the ${lower}, but your class connection is unaffected.`,
    hint: 'Tap Try again to retry.',
    canRetry: true,
  };
}

export type QueriedPermission = {
  state: PermissionStateEx;
  status: PermissionStatus | null;
};

/** Pre-check camera or microphone permission without triggering a prompt. */
export async function queryMediaPermission(media: MediaKind): Promise<QueriedPermission> {
  if (typeof navigator === 'undefined' || !navigator.permissions?.query) {
    return { state: 'unknown', status: null };
  }
  try {
    const status = await navigator.permissions.query({ name: media as PermissionName });
    const s = status?.state;
    const state: PermissionStateEx =
      s === 'granted' || s === 'denied' || s === 'prompt' ? s : 'unknown';
    return { state, status };
  } catch {
    // Safari < 16 / Firefox throw TypeError for 'camera' / 'microphone'.
    return { state: 'unknown', status: null };
  }
}

export const PERMISSION_SETTLE_GRACE_MS = 3_000;
export const PERMISSION_MAX_INFLIGHT_MS = 20_000;

export type PermissionGraceTracker = {
  beginPrompt: () => () => void;
  extendGrace: (ms?: number) => void;
  isActive: () => boolean;
  remainingMs: () => number;
  subscribe: (fn: () => void) => () => void;
};

export function createPermissionGraceTracker(opts?: {
  now?: () => number;
  settleGraceMs?: number;
  maxInFlightMs?: number;
}): PermissionGraceTracker {
  const now = opts?.now ?? (() => Date.now());
  const settleGraceMs = opts?.settleGraceMs ?? PERMISSION_SETTLE_GRACE_MS;
  const maxInFlightMs = opts?.maxInFlightMs ?? PERMISSION_MAX_INFLIGHT_MS;
  let inFlight = 0;
  let inFlightSince = 0;
  let graceUntil = 0;
  const listeners = new Set<() => void>();

  const emit = () => {
    listeners.forEach((fn) => {
      try {
        fn();
      } catch {
        /* ignore */
      }
    });
  };

  const remainingMs = (): number => {
    const t = now();
    let rem = Math.max(0, graceUntil - t);
    if (inFlight > 0) {
      const flightRem = Math.max(0, inFlightSince + maxInFlightMs - t);
      rem = Math.max(rem, flightRem);
    }
    return rem;
  };

  const isActive = (): boolean => remainingMs() > 0;

  const beginPrompt = (): (() => void) => {
    if (inFlight === 0) inFlightSince = now();
    inFlight += 1;
    emit();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      inFlight = Math.max(0, inFlight - 1);
      graceUntil = Math.max(graceUntil, now() + settleGraceMs);
      emit();
    };
  };

  const extendGrace = (ms = settleGraceMs): void => {
    graceUntil = Math.max(graceUntil, now() + Math.max(0, ms));
    emit();
  };

  const subscribe = (fn: () => void): (() => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };

  return { beginPrompt, extendGrace, isActive, remainingMs, subscribe };
}

export const permissionGrace = createPermissionGraceTracker();

export async function withPermissionPrompt<T>(fn: () => Promise<T>): Promise<T> {
  const end = permissionGrace.beginPrompt();
  try {
    return await fn();
  } finally {
    end();
  }
}

/**
 * Retry button (Nov 27): ask for ONE permission straight from the tap.
 * getUserMedia is called before anything is awaited, so the browser still
 * sees the tap (Safari and a quiet Chrome refuse without one, showing no
 * popup). If it fails anyway, the issue says how to unblock it.
 */
export function requestPermissionFromTap(media: MediaKind): Promise<{ ok: true } | { ok: false; issue: MediaAccessIssue }> {
  const secure = typeof window === 'undefined' ? true : window.isSecureContext !== false;
  const hasDevices = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  if (!secure || !hasDevices) {
    return Promise.resolve({ ok: false, issue: buildMediaIssue({ media, secureContext: secure, hasMediaDevices: hasDevices }) });
  }
  const end = permissionGrace.beginPrompt();
  let request: Promise<MediaStream>;
  try {
    request = navigator.mediaDevices.getUserMedia(media === 'camera' ? { video: true, audio: false } : { audio: true, video: false });
  } catch (err) {
    request = Promise.reject(err);
  }
  return request.then(
    (stream) => {
      end();
      stream.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          /* ignore */
        }
      });
      return { ok: true as const };
    },
    async (err) => {
      end();
      const post = await queryMediaPermission(media);
      return { ok: false as const, issue: buildMediaIssue({ media, err, permState: post.state, afterTap: true }) };
    }
  );
}

/**
 * Request ONE media permission inside a user gesture and release the probe
 * track immediately. Never combines audio and video so denying one never
 * blocks the other.
 */
export async function requestSeparatePermission(
  media: MediaKind
): Promise<{ ok: true } | { ok: false; issue: MediaAccessIssue }> {
  const secure = typeof window === 'undefined' ? true : window.isSecureContext !== false;
  const hasDevices = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  const pre = await queryMediaPermission(media);
  if (!secure || !hasDevices) {
    return {
      ok: false,
      issue: buildMediaIssue({ media, permState: pre.state, secureContext: secure, hasMediaDevices: hasDevices }),
    };
  }
  if (pre.state === 'denied') {
    return { ok: false, issue: buildMediaIssue({ media, permState: 'denied' }) };
  }
  try {
    const stream = await withPermissionPrompt(() =>
      navigator.mediaDevices.getUserMedia(
        media === 'camera' ? { video: true, audio: false } : { audio: true, video: false }
      )
    );
    stream.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    });
    return { ok: true };
  } catch (err) {
    const post = await queryMediaPermission(media);
    return {
      ok: false,
      issue: buildMediaIssue({
        media,
        err,
        permState: post.state === 'unknown' ? pre.state : post.state,
        secureContext: secure,
        hasMediaDevices: hasDevices,
      }),
    };
  }
}
