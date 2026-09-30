import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import bcrypt from 'bcryptjs';
import { prisma } from './db';
import { cookieSecureFlag } from './url';

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

function secret() {
  const s = process.env.NEXTAUTH_SECRET;
  if (!s) throw new Error('NEXTAUTH_SECRET is not set');
  return new TextEncoder().encode(s);
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export async function createTeacherToken(teacher: { id: string; email: string; name: string }) {
  return new SignJWT({ sub: teacher.id, email: teacher.email, name: teacher.name, role: 'teacher' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(secret());
}

export async function setTeacherCookie(token: string) {
  (await cookies()).set(teacherCookieName(), token, cookieOptions(60 * 60 * 24 * 7));
}

export async function clearTeacherCookie() {
  (await cookies()).set(teacherCookieName(), '', cookieOptions(0));
}

export async function getTeacherSession() {
  const token = (await cookies()).get(teacherCookieName())?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    if (payload.role !== 'teacher' || typeof payload.sub !== 'string') return null;
    const teacher = await prisma.teacher.findUnique({ where: { id: payload.sub } });
    if (!teacher) return null;
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
