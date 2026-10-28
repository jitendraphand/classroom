'use client';

import { AdminShell } from '@/components/admin/AdminShell';
import { LateClasses } from '@/components/admin/LateClasses';
import { OngoingClasses } from '@/components/admin/OngoingClasses';

export default function AdminOngoingClassesPage() {
  return (
    <AdminShell title="Live classes">
      <LateClasses />
      <OngoingClasses />
    </AdminShell>
  );
}
