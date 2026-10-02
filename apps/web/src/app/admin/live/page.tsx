'use client';

import { AdminShell } from '@/components/admin/AdminShell';
import { OngoingClasses } from '@/components/admin/OngoingClasses';

export default function AdminOngoingClassesPage() {
  return (
    <AdminShell title="Ongoing classes">
      <OngoingClasses />
    </AdminShell>
  );
}
