'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { PageLoading } from '@/components/ui/Skeleton';
import { claimTeacherTab } from '@/lib/classroomClient';

/**
 * Legacy teacher lobby URL. Teachers now go straight into the classroom
 * (admit / invite / end class live in the classroom roster and dock), so this
 * route only forwards:
 * - owning teacher → claim this tab as teacher, then /classroom/[code]
 * - class ended   → teacher dashboard (start it again from there)
 * - anyone else   → /login (same as the old lobby)
 */
export default function TeacherRoomRedirect() {
  const params = useParams();
  const router = useRouter();
  const code = String(params.code || '').toUpperCase();
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Clear any act-as-student cookie first so /state reports the teacher.
        await claimTeacherTab(code);
        const res = await fetch(`/api/rooms/${code}/state`, { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setError(data.error || 'Failed to load room');
          return;
        }
        if (data.status === 'ENDED' || data.ended) {
          router.replace('/teacher/dashboard');
          return;
        }
        if (!data.isTeacher) {
          router.replace('/login');
          return;
        }
        router.replace(`/classroom/${code}`);
      } catch {
        if (!cancelled) setError('Network error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, router]);

  return <PageLoading label={error || 'Opening classroom…'} />;
}
