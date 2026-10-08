import { getAdminSession, getTeacherSession } from '@/lib/auth';
import { handleGradeOptions } from '@/lib/gradeMasterApi';
import { loadMaster } from '@/lib/gradeMaster';
import { loadCampuses } from '@/lib/campusMaster';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Dropdown data (active campuses, grades + active divisions). Admin or teacher session. */
export async function GET() {
  return handleGradeOptions({
    authorised: async () => Boolean((await getAdminSession()) || (await getTeacherSession())),
    list: loadMaster,
    campuses: loadCampuses,
  });
}
