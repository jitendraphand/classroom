'use client';

import { useParams } from 'next/navigation';
import { ClassroomRoom } from '@/components/classroom/ClassroomRoom';

export default function ClassroomPage() {
  const params = useParams();
  const code = String(params.code || '').toUpperCase();
  return <ClassroomRoom code={code} />;
}
