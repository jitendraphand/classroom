import { prisma } from '@/lib/db';
import { endedSessionReason, getAdminSession, getTeacherSession, getStudentParticipant, refreshStaffCookies } from '@/lib/auth';
import { jsonOk } from '@/lib/response';

export const dynamic = 'force-dynamic';

export async function GET() {
  // Sliding teacher/admin session (lib/sessionTokens): keep an active one alive.
  await refreshStaffCookies().catch(() => undefined);
  const admin = await getAdminSession({ allowPendingPasswordChange: true });
  if (admin) return jsonOk({ role: 'admin', ...admin });

  const teacher = await getTeacherSession({ allowPendingPasswordChange: true });
  if (teacher) {
    const link = await prisma.admin.findUnique({ where: { teacherId: teacher.id }, select: { id: true } }).catch(() => null);
    return jsonOk({ role: 'teacher', ...teacher, adminAvailable: !!link });
  }

  const student = await getStudentParticipant();
  if (student && student.status !== 'LEFT') {
    return jsonOk({
      role: 'student',
      id: student.id,
      displayName: student.displayName,
      status: student.status,
      roomCode: student.room.code,
      roomName: student.room.name,
      viaSchoolApp: !!student.studentId,
    });
  }

  return jsonOk({ role: null, reason: (await endedSessionReason()) ?? null });
}
