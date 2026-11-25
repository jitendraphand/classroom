import { loadCampuses } from './campusMaster';
import { loadMaster } from './gradeMaster';
import { audienceLabelsFromMaster, type AudienceLabels } from './audienceLabels';

let cache: { at: number; value: AudienceLabels } | null = null;

/** Active master-list labels, reused for 10 s (they change rarely). */
export async function loadAudienceLabels(): Promise<AudienceLabels> {
  const now = Date.now();
  if (cache && now - cache.at < 10_000) return cache.value;
  const [grades, campuses] = await Promise.all([loadMaster(), loadCampuses()]);
  const value = audienceLabelsFromMaster(grades, campuses);
  cache = { at: now, value };
  return value;
}
