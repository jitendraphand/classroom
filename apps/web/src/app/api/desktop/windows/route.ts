import { windowsAppInfo } from '@/lib/desktopApp';
import { jsonOk } from '@/lib/response';

export const dynamic = 'force-dynamic';

/** Latest / minimum Windows teacher app version and its download link (no auth: nothing secret). */
export async function GET() {
  return jsonOk(windowsAppInfo(process.env));
}
