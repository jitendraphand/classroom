import { androidAppInfo } from '@/lib/desktopApp';
import { jsonOk } from '@/lib/response';

export const dynamic = 'force-dynamic';

/** Latest / minimum Android teacher app version and its download link (no auth: nothing secret). */
export async function GET() {
  return jsonOk(androidAppInfo(process.env));
}
