import { JoinCodeForm } from '@/components/join/JoinCodeForm';
import { SchoolAppOnly } from '@/components/join/SchoolAppOnly';
import { manualStudentJoinAllowed } from '@/lib/schoolConfig';

// Reads ALLOW_MANUAL_STUDENT_JOIN at request time. (GET /join?t=… never
// reaches this page: middleware rewrites it to /api/student/join.)
export const dynamic = 'force-dynamic';

export default function JoinLandingPage() {
  return manualStudentJoinAllowed() ? <JoinCodeForm /> : <SchoolAppOnly />;
}
