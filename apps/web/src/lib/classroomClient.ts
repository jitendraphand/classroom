/**
 * Tab-local student identity for same-browser teacher+student E2E.
 * sessionStorage survives act-as cookie clears from other tabs.
 */

const roleKey = (code: string) => `classroom_role_${code.toUpperCase()}`;

export function rememberClassroomRole(code: string, role: 'student' | 'teacher') {
  try {
    sessionStorage.setItem(roleKey(code), role);
  } catch {
    /* ignore */
  }
}

export function getClassroomRole(code: string): 'student' | 'teacher' | null {
  try {
    const v = sessionStorage.getItem(roleKey(code));
    if (v === 'student' || v === 'teacher') return v;
  } catch {
    /* ignore */
  }
  return null;
}

export function studentAsHeaders(code: string): HeadersInit {
  if (getClassroomRole(code) === 'student') {
    return { 'x-classroom-as': 'student' };
  }
  return {};
}

export function roomApiUrl(code: string, path: string): string {
  const base = `/api/rooms/${code.toUpperCase()}${path.startsWith('/') ? path : `/${path}`}`;
  if (getClassroomRole(code) === 'student') {
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}as=student`;
  }
  return base;
}

/** fetch() for room APIs with student act-as when this tab is a student session */
export async function roomFetch(code: string, path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  const asHeaders = studentAsHeaders(code);
  for (const [k, v] of Object.entries(asHeaders)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return fetch(roomApiUrl(code, path), { ...init, headers });
}
