import { getTeacherSession, getStudentParticipant } from '@/lib/auth';
import { jsonOk } from '@/lib/response';

export const dynamic = 'force-dynamic';

export async function GET() {
  const teacher = await getTeacherSession();
  if (teacher) return jsonOk({ role: 'teacher', ...teacher });

  const student = await getStudentParticipant();
  if (student && student.status !== 'LEFT') {
    return jsonOk({
      role: 'student',
      id: student.id,
      displayName: student.displayName,
      status: student.status,
      roomCode: student.room.code,
      roomName: student.room.name,
    });
  }

  return jsonOk({ role: null });
}
