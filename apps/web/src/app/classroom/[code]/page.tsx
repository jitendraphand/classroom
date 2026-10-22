'use client';

import { useParams } from 'next/navigation';
import { ClassroomRoom } from '@/components/classroom/ClassroomRoom';
import { ClassroomGuard } from '@/components/classroom/ClassroomGuard';

export default function ClassroomPage() {
  const params = useParams();
  const code = String(params.code || '').toUpperCase();
  return (
    <ClassroomGuard code={code}>
      <ClassroomRoom code={code} />
    </ClassroomGuard>
  );
}
