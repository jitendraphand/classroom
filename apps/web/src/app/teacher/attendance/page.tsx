'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AppHeader, BackLink } from '@/components/layout/AppHeader';
import { ReportView } from '@/components/reports/ReportView';
import { PageLoading } from '@/components/ui/Skeleton';
import { api } from '@/lib/clientFetch';

export default function TeacherAttendancePage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    api<{ role: string; mustChangePassword?: boolean }>('/api/auth/me').then(({ data }) => {
      if (data.role !== 'teacher') router.replace('/login');
      else if (data.mustChangePassword) router.replace('/account/password');
      else setReady(true);
    });
  }, [router]);
  if (!ready) return <PageLoading label="Loading…" />;
  return (
    <main className="page-shell">
      <AppHeader compact subtitle="Teacher · attendance" />
      <BackLink href="/teacher/dashboard">Dashboard</BackLink>
      <h1 className="mb-5 font-display text-2xl font-semibold tracking-tight">Attendance for my classes</h1>
      <ReportView base="/api/teacher/attendance" />
    </main>
  );
}
