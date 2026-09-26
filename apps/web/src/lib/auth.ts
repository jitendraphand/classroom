import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import bcrypt from 'bcryptjs';
import { prisma } from './db';
import { cookieSecureFlag } from './url';

const COOKIE = 'classroom_teacher';
const STUDENT_COOKIE = 'classroom_student';

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
  cookies().set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecureFlag(),
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  });
}

export async function clearTeacherCookie() {
  cookies().set(COOKIE, '', { httpOnly: true, sameSite: 'lax', secure: cookieSecureFlag(), path: '/', maxAge: 0 });
}

export async function getTeacherSession() {
  const token = cookies().get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    if (payload.role !== 'teacher' || typeof payload.sub !== 'string') return null;
    const teacher = await prisma.teacher.findUnique({ where: { id: payload.sub } });
    if (!teacher) return null;
    return { id: teacher.id, email: teacher.email, name: teacher.name };
  } catch {
    return null;
  }
}

export async function requireTeacher() {
  const session = await getTeacherSession();
  if (!session) throw new Error('UNAUTHORIZED');
  return session;
}

export function setStudentCookie(sessionToken: string) {
  cookies().set(STUDENT_COOKIE, sessionToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecureFlag(),
    path: '/',
    maxAge: 60 * 60 * 12,
  });
}

export function clearStudentCookie() {
  cookies().set(STUDENT_COOKIE, '', { httpOnly: true, sameSite: 'lax', secure: cookieSecureFlag(), path: '/', maxAge: 0 });
}

export function getStudentSessionToken() {
  return cookies().get(STUDENT_COOKIE)?.value ?? null;
}

export async function getStudentParticipant() {
  const token = getStudentSessionToken();
  if (!token) return null;
  return prisma.participant.findUnique({
    where: { sessionToken: token },
    include: { room: true },
  });
}

/** Prefer student identity when a teacher also has a session (join-as-student). */
const ACT_AS_COOKIE = 'classroom_act_as';

export function setActAsStudent() {
  cookies().set(ACT_AS_COOKIE, 'student', {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecureFlag(),
    path: '/',
    maxAge: 60 * 60 * 12,
  });
}

export function clearActAs() {
  cookies().set(ACT_AS_COOKIE, '', { httpOnly: true, sameSite: 'lax', secure: cookieSecureFlag(), path: '/', maxAge: 0 });
}

export function getActAs(): 'student' | null {
  const v = cookies().get(ACT_AS_COOKIE)?.value;
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
  const forceStudent = opts?.forceStudent || getActAs() === 'student';

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
