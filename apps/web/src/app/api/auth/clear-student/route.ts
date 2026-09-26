import { clearStudentCookie } from '@/lib/auth';
import { jsonOk } from '@/lib/response';

/** Drop the student session cookie so another display name can join this browser. */
export async function POST() {
  clearStudentCookie();
  return jsonOk({ cleared: true });
}
