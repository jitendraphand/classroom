/**
 * What the teacher apps (Windows, Android) should know about their own
 * updates, set by the operator when a new build is published (neither has an
 * auto-updater; the Android APK is installed outside the Play Store). Each app
 * compares its version with these on start and every few hours: below
 * `minimum` it shows a blocking-style notice, below `latest` a quiet one, both
 * with `url` as the download link.
 */
export type DesktopAppInfo = { latest: string | null; minimum: string | null; url: string | null };

const VERSION = /^\d+\.\d+\.\d+$/;

function version(v: string | undefined): string | null {
  const t = v?.trim();
  return t && VERSION.test(t) ? t : null;
}

function httpsUrl(v: string | undefined): string | null {
  const t = v?.trim();
  if (!t) return null;
  try {
    const u = new URL(t);
    return u.protocol === 'https:' && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

export function windowsAppInfo(env: Record<string, string | undefined>): DesktopAppInfo {
  return {
    latest: version(env.WINDOWS_APP_LATEST),
    minimum: version(env.WINDOWS_APP_MINIMUM),
    url: httpsUrl(env.WINDOWS_APP_URL),
  };
}

export function androidAppInfo(env: Record<string, string | undefined>): DesktopAppInfo {
  return {
    latest: version(env.ANDROID_APP_LATEST),
    minimum: version(env.ANDROID_APP_MINIMUM),
    url: httpsUrl(env.ANDROID_APP_URL),
  };
}
