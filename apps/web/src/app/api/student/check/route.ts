import { getPupil, refreshPupilCookie } from '@/lib/auth';
import { handleStudentCheck } from '@/lib/studentCheck';
import { routeSignature } from '@/lib/studentRouting';
import { decideStudentRoute } from '@/lib/studentService';

export const dynamic = 'force-dynamic';

/** Signed-in school-app student only: has their routing changed? (see lib/studentCheck.ts) */
export async function GET() {
  return handleStudentCheck({
    getPupil,
    signatureFor: async (student) => {
      const { decision } = await decideStudentRoute(student);
      return { sig: routeSignature(decision), kind: decision.kind };
    },
    refreshSession: refreshPupilCookie,
  });
}
