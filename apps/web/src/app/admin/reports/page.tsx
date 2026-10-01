'use client';

import { useEffect, useState } from 'react';
import { AdminShell } from '@/components/admin/AdminShell';
import { ReportView } from '@/components/reports/ReportView';
import { api } from '@/lib/clientFetch';

export default function AdminReportsPage() {
  const [teachers, setTeachers] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    api<{ teachers: { id: string; name: string }[] }>('/api/admin/teachers').then(({ ok, data }) => {
      if (ok) setTeachers(data.teachers);
    });
  }, []);
  return (
    <AdminShell title="Attendance reports">
      <ReportView base="/api/admin/reports" teachers={teachers} showTeacherFilter />
    </AdminShell>
  );
}
