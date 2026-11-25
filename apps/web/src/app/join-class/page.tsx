// TEMPORARY "Join the class" form (see lib/joinClassForm.ts). Delete with the feature.
import { JoinClassForm } from '@/components/joinClass/JoinClassForm';
import { loadCampuses } from '@/lib/campusMaster';
import { loadMaster } from '@/lib/gradeMaster';
import { joinFormModel } from '@/lib/joinClassForm';
import { ensureJoinAudience } from '@/lib/joinClassSeed';
import { readUnsignedFields } from '@/lib/joinParams';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Join the class' };

export default async function JoinClassPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  let options = null;
  let prefill = null;
  try {
    await ensureJoinAudience();
    const sp = await searchParams;
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) {
      const val = Array.isArray(v) ? v[0] : v;
      if (val) params.set(k, val);
    }
    const model = joinFormModel(await loadMaster(), await loadCampuses(), readUnsignedFields(params));
    options = model.options;
    prefill = model.prefill;
  } catch (e) {
    console.error('join-class: master lists unavailable', e instanceof Error ? e.message : e);
  }
  return <JoinClassForm options={options} prefill={prefill} />;
}
