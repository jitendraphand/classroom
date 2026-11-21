// TEMPORARY "Join the class" form (see lib/joinClassForm.ts). Delete with the feature.
import { JoinClassForm } from '@/components/joinClass/JoinClassForm';
import { loadCampuses } from '@/lib/campusMaster';
import { loadMaster } from '@/lib/gradeMaster';
import { resolveFixedClass, type FixedClass } from '@/lib/joinClassForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Join the class' };

export default async function JoinClassPage() {
  let cls: FixedClass | null = null;
  try {
    cls = resolveFixedClass(await loadMaster(), await loadCampuses());
  } catch (e) {
    console.error('join-class: master lists unavailable', e instanceof Error ? e.message : e);
  }
  return <JoinClassForm fixed={cls} />;
}
