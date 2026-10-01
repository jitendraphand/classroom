import { z } from 'zod';
import { requireAdminApi } from '@/lib/adminGuard';
import { jsonError, jsonOk } from '@/lib/response';
import { importRoster, parseRoster } from '@/lib/roster';

const schema = z.object({ csv: z.string().min(1).max(2_000_000), dryRun: z.boolean().optional() });

/** Roster CSV import (externalId,name,grade,division,roll) so absentees are known before first join. */
export async function POST(req: Request) {
  const { res } = await requireAdminApi();
  if (res) return res;
  try {
    const body = schema.parse(await req.json());
    const { rows, errors } = parseRoster(body.csv);
    if (rows.length > 20_000) return jsonError('At most 20 000 students per import');
    if (body.dryRun) return jsonOk({ valid: rows.length, errors: errors.slice(0, 100), errorCount: errors.length });
    const out = await importRoster(rows);
    return jsonOk({ ...out, errors: errors.slice(0, 100), errorCount: errors.length });
  } catch (e) {
    if (e instanceof z.ZodError) return jsonError('Paste or choose a CSV file (max 2 MB)');
    console.error(e);
    return jsonError('Import failed', 500);
  }
}
