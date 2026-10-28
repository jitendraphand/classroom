/**
 * "A newer Classroom Teacher is available / required", from the school
 * server's GET /api/desktop/windows (WINDOWS_APP_LATEST / _MINIMUM / _URL).
 * The app is not code-signed and has no auto-updater, so the operator sets
 * these when a build is published and the teacher downloads it from `url`.
 * Older servers answer 404: no notice.
 */
export type UpdateLevel = 'none' | 'available' | 'required';
export type UpdateNotice = { level: UpdateLevel; current: string; latest: string | null; url: string | null };

function parts(v: string): number[] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1, 0 or 1; null when either is not x.y.z. */
export function compareVersions(a: string, b: string): number | null {
  const x = parts(a);
  const y = parts(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return 0;
}

function httpsUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

export function updateNotice(data: unknown, current: string): UpdateNotice {
  const d = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const latest = typeof d.latest === 'string' && parts(d.latest) ? d.latest : null;
  const minimum = typeof d.minimum === 'string' && parts(d.minimum) ? d.minimum : null;
  const url = httpsUrl(d.url);
  let level: UpdateLevel = 'none';
  if (minimum && compareVersions(current, minimum) === -1) level = 'required';
  else if (latest && compareVersions(current, latest) === -1) level = 'available';
  return { level, current, latest: latest ?? minimum, url };
}

export function updateText(n: UpdateNotice): string {
  if (n.level === 'required') {
    return `This version (${n.current}) is no longer supported by your school's server. Install Classroom Teacher ${n.latest ?? 'the new version'} to keep teaching.`;
  }
  if (n.level === 'available') return `Classroom Teacher ${n.latest} is available (you have ${n.current}).`;
  return '';
}
