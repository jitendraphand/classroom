import { z } from 'zod';
import { prisma } from '@/lib/db';
import {
  clearAdminCookie,
  clearTeacherCookie,
  setAdminCookie,
  setTeacherCookie,
  startAdminSession,
  startTeacherSession,
  verifyPassword,
} from '@/lib/auth';
import { jsonError, jsonOk } from '@/lib/response';
import { kickReplacedAdmin, kickReplacedTeacher } from '@/lib/sessionKick';
import { clearLoginFailures, clientIp, loginBlockedFor, recordLoginFailure } from '@/lib/rateLimit';

const schema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
});

/** Constant-ish work for unknown emails so response time does not reveal accounts. */
const DUMMY_HASH = '$2a$12$9ch9jf0ccnDYc4FooYI0XeG5B5bsHNgFt4jhfGjE2fFQmQa.RtAzO';

/**
 * Single login for the school admin and teachers (one page, /login).
 * The admin table is checked first; emails are unique across both (the admin
 * API refuses a teacher with the admin's email). Failed attempts are throttled
 * per account and per IP in Redis.
 */
export async function POST(req: Request) {
  const ct = req.headers.get('content-type') || '';
  if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
    return formPost(req);
  }
  return handleLogin(req, await req.json().catch(() => ({})));
}

/**
 * No-JS / pre-hydration fallback: the /login form posts here natively
 * (method=post, so credentials are only ever in the request body). Answer with
 * a 303 redirect, never echoing the credentials into a URL.
 */
async function formPost(req: Request) {
  const fd = await req.formData().catch(() => null);
  const res = await handleLogin(req, {
    email: String(fd?.get('email') ?? ''),
    password: String(fd?.get('password') ?? ''),
  });
  const data = (await res.clone().json().catch(() => ({}))) as {
    role?: string;
    mustChangePassword?: boolean;
  };
  let to = '/login?error=1';
  if (res.ok) {
    to = data.mustChangePassword ? '/account/password' : data.role === 'admin' ? '/admin' : '/teacher/dashboard';
  }
  const out = new Response(null, { status: 303, headers: { Location: to } });
  // Carry the session cookies set by handleLogin onto the redirect.
  res.headers.forEach((v, k) => {
    if (k.toLowerCase() === 'set-cookie') out.headers.append('set-cookie', v);
  });
  return out;
}

async function handleLogin(req: Request, raw: unknown) {
  try {
    const body = schema.parse(raw);
    const email = body.email.trim().toLowerCase();
    const ip = clientIp(req);

    const wait = await loginBlockedFor(email, ip);
    if (wait > 0) {
      return jsonError(
        `Too many failed sign-in attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`,
        429,
        { retryAfterSeconds: wait }
      );
    }

    const admin = await prisma.admin.findUnique({ where: { email } });
    if (admin) {
      if (!(await verifyPassword(body.password, admin.passwordHash))) {
        await recordLoginFailure(email, ip);
        return jsonError('Invalid email or password', 401);
      }
      await clearLoginFailures(email);
      await clearTeacherCookie();
      await setAdminCookie(await startAdminSession(admin.id));
      // The previous device's open class viewers stop now, not at their next poll.
      await kickReplacedAdmin(admin.id);
      return jsonOk({
        role: 'admin',
        id: admin.id,
        email: admin.email,
        name: admin.name,
        mustChangePassword: admin.mustChangePassword,
      });
    }

    const teacher = await prisma.teacher.findUnique({ where: { email } });
    if (!teacher) {
      await verifyPassword(body.password, DUMMY_HASH).catch(() => false);
      await recordLoginFailure(email, ip);
      return jsonError('Invalid email or password', 401);
    }
    if (!(await verifyPassword(body.password, teacher.passwordHash))) {
      await recordLoginFailure(email, ip);
      return jsonError('Invalid email or password', 401);
    }
    if (teacher.disabled) {
      return jsonError('This account is disabled. Contact the school administrator.', 403);
    }
    await clearLoginFailures(email);
    await clearAdminCookie();
    await setTeacherCookie(await startTeacherSession(teacher.id));
    // A previous device still in class is disconnected now, not at its next poll.
    await kickReplacedTeacher(teacher.id);
    return jsonOk({
      role: 'teacher',
      id: teacher.id,
      email: teacher.email,
      name: teacher.name,
      permanentCode: teacher.permanentCode,
      mustChangePassword: teacher.mustChangePassword,
    });
  } catch (e) {
    if (e instanceof z.ZodError) return jsonError(e.errors[0]?.message || 'Invalid input');
    console.error(e);
    return jsonError('Login failed', 500);
  }
}
