import { cookies } from 'next/headers';
import bcrypt from 'bcryptjs';
import { prisma } from './db';
import { cookieSecureFlag } from './url';
import { signSession, verifySession, sessionStillValid } from './sessionTokens';

/**
 * Cookie names. Over HTTPS the `__Host-` prefix is used: the browser then only
 * accepts the cookie from this exact host (Secure, Path=/, no Domain). That
 * matters on sslip.io, where any sibling `*.sslip.io` page could otherwise plant
 * a `Domain=sslip.io` cookie (session fixation). Plain HTTP deploys cannot use
 * the prefix, so they keep the bare names.
 */
function cookieName(base: string) {
  return cookieSecureFlag() ? `__Host-${base}` : base;
}
const teacherCookieName = () => cookieName('classroom_teacher');
const studentCookieName = () => cookieName('classroom_student');
const actAsCookieName = () => cookieName('classroom_act_as');
const adminCookieName = () => cookieName('classroom_admin');
/** Identity of a student who arrived through the signed school-app link. */
const pupilCookieName = () => cookieName('classroom_pupil');

/**
 * SameSite=Strict: every page is a client component that authenticates through
 * same-origin fetches, so Strict never hides the session from the app itself.
 * It does not stop same-site (sibling sslip.io) requests; `middleware.ts`
 * handles those with an Origin check.
 */
function cookieOptions(maxAge: number) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: cookieSecureFlag(),
    path: '/',
    maxAge,
  };
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export async function createTeacherToken(teacher: {
  id: string;
  email: string;
  name: string;
  sessionVersion?: number;
}) {
  return signSession('teacher', teacher.id, teacher.sessionVersion ?? 0, {
    email: teacher.email,
    name: teacher.name,
  });
}

export async function setTeacherCookie(token: string) {
  (await cookies()).set(teacherCookieName(), token, cookieOptions(60 * 60 * 24 * 7));
}

export async function clearTeacherCookie() {
  (await cookies()).set(teacherCookieName(), '', cookieOptions(0));
}

export type TeacherSession = {
  id: string;
  email: string;
  name: string;
  permanentCode: string;
  mustChangePassword: boolean;
};

/**
 * The signed-in teacher, or null. A disabled teacher, a stale session version
 * (password reset / disable) or a pending forced password change all yield
 * null, so every existing teacher API refuses them without per-route checks.
 * Only the change-password flow and /api/auth/me pass
 * `allowPendingPasswordChange` to see a teacher who still has to change it.
 */
export async function getTeacherSession(
  opts: { allowPendingPasswordChange?: boolean } = {}
): Promise<TeacherSession | null> {
  const token = (await cookies()).get(teacherCookieName())?.value;
  const claims = await verifySession(token, 'teacher').catch(() => null);
  if (!claims) return null;
  try {
    const teacher = await prisma.teacher.findUnique({ where: { id: claims.sub } });
    if (!teacher || !sessionStillValid(claims, teacher)) return null;
    if (teacher.mustChangePassword && !opts.allowPendingPasswordChange) return null;
    let permanentCode = teacher.permanentCode;
    if (!permanentCode) {
      // Lazy backfill if migration row somehow lacks a code
      const { ensureTeacherPermanentCode } = await import('./teacherRoom');
      permanentCode = await ensureTeacherPermanentCode(teacher.id);
    }
    return {
      id: teacher.id,
      email: teacher.email,
      name: teacher.name,
      permanentCode,
      mustChangePassword: teacher.mustChangePassword,
    };
  } catch {
    return null;
  }
}

export async function requireTeacher() {
  const session = await getTeacherSession();
  if (!session) throw new Error('UNAUTHORIZED');
  return session;
}

// ---------------------------------------------------------------- admin

export async function createAdminToken(admin: { id: string; sessionVersion: number }) {
  return signSession('admin', admin.id, admin.sessionVersion);
}

export async function setAdminCookie(token: string) {
  (await cookies()).set(adminCookieName(), token, cookieOptions(60 * 60 * 12));
}

export async function clearAdminCookie() {
  (await cookies()).set(adminCookieName(), '', cookieOptions(0));
}

export type AdminSession = { id: string; email: string; name: string; mustChangePassword: boolean };

/** The signed-in admin, or null (same rules as getTeacherSession). */
export async function getAdminSession(
  opts: { allowPendingPasswordChange?: boolean } = {}
): Promise<AdminSession | null> {
  const token = (await cookies()).get(adminCookieName())?.value;
  const claims = await verifySession(token, 'admin').catch(() => null);
  if (!claims) return null;
  try {
    const admin = await prisma.admin.findUnique({ where: { id: claims.sub } });
    if (!admin || !sessionStillValid(claims, admin)) return null;
    if (admin.mustChangePassword && !opts.allowPendingPasswordChange) return null;
    return {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      mustChangePassword: admin.mustChangePassword,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- pupil

export async function setPupilCookie(student: { id: string }) {
  const token = await signSession('pupil', student.id, 0);
  (await cookies()).set(pupilCookieName(), token, cookieOptions(60 * 60 * 12));
}

export async function clearPupilCookie() {
  (await cookies()).set(pupilCookieName(), '', cookieOptions(0));
}

/** The school-app student signed in on this browser (from the signed join link), or null. */
export async function getPupil() {
  const token = (await cookies()).get(pupilCookieName())?.value;
  const claims = await verifySession(token, 'pupil').catch(() => null);
  if (!claims) return null;
  return prisma.student.findUnique({ where: { id: claims.sub } }).catch(() => null);
}

export async function setStudentCookie(sessionToken: string) {
  (await cookies()).set(studentCookieName(), sessionToken, cookieOptions(60 * 60 * 12));
}

export async function clearStudentCookie() {
  (await cookies()).set(studentCookieName(), '', cookieOptions(0));
}

export async function getStudentSessionToken() {
  return (await cookies()).get(studentCookieName())?.value ?? null;
}

export async function getStudentParticipant() {
  const token = await getStudentSessionToken();
  if (!token) return null;
  return prisma.participant.findUnique({
    where: { sessionToken: token },
    include: { room: true },
  });
}

/** Prefer student identity when a teacher also has a session (join-as-student). */
export async function setActAsStudent() {
  (await cookies()).set(actAsCookieName(), 'student', cookieOptions(60 * 60 * 12));
}

export async function clearActAs() {
  (await cookies()).set(actAsCookieName(), '', cookieOptions(0));
}

export async function getActAs(): Promise<'student' | null> {
  const v = (await cookies()).get(actAsCookieName())?.value;
  return v === 'student' ? 'student' : null;
}

/**
 * Resolve whether this request should act as teacher or student for a room.
 * `forceStudent` (query/header) or act-as cookie wins over teacher session.
 */
export async function resolveRoomAccess(
  room: { id: string; teacherId: string },
  opts?: { forceStudent?: boolean }
) {
  const teacher = await getTeacherSession();
  const student = await getStudentParticipant();
  const forceStudent = opts?.forceStudent || (await getActAs()) === 'student';

  const teacherOwns = !!teacher && teacher.id === room.teacherId;
  const studentInRoom =
    !!student && student.roomId === room.id && student.status !== 'LEFT';

  // Explicit student intent (join link / act-as cookie): never treat as teacher,
  // even if a teacher session cookie exists on this browser.
  if (forceStudent) {
    if (studentInRoom) {
      return {
        mode: 'student' as const,
        isTeacher: false,
        teacher,
        student,
        teacherOwns,
      };
    }
    return {
      mode: null as null,
      isTeacher: false,
      teacher,
      student,
      teacherOwns,
    };
  }

  if (teacherOwns) {
    return {
      mode: 'teacher' as const,
      isTeacher: true,
      teacher,
      student,
      teacherOwns,
    };
  }

  if (studentInRoom) {
    return {
      mode: 'student' as const,
      isTeacher: false,
      teacher,
      student,
      teacherOwns,
    };
  }

  return {
    mode: null as null,
    isTeacher: false,
    teacher,
    student,
    teacherOwns,
  };
}
