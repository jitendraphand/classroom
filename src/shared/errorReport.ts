/**
 * Renderer crash/exception reports → POST /api/client-error (web lib/clientError,
 * one `[client-error]` server log line). Trimmed and scrubbed (no query strings
 * or JWTs), and rate limited so an error loop cannot flood the server.
 */
import { buildClientErrorReport, type ClientErrorReport } from './web/clientError';

export const ERROR_REPORT_MAX_PER_MIN = 5;

export function createErrorReporter(opts: {
  windowName: string;
  code: () => string;
  post: (report: ClientErrorReport) => Promise<unknown>;
  ua: string;
  now?: () => number;
}): (error: unknown, componentStack?: string | null) => boolean {
  const now = opts.now ?? Date.now;
  let recent: number[] = [];
  const seen = new Set<string>();
  return (error, componentStack) => {
    const t = now();
    recent = recent.filter((x) => t - x < 60_000);
    if (recent.length >= ERROR_REPORT_MAX_PER_MIN) return false;
    const report = buildClientErrorReport(opts.code() || 'win', error, componentStack, {
      url: `app://classroom/${opts.windowName}`,
      ua: opts.ua,
      at: t,
    });
    const key = `${report.name}|${report.message}`;
    if (seen.has(key)) return false; // same error once per window session
    seen.add(key);
    recent.push(t);
    try {
      void Promise.resolve(opts.post(report)).catch(() => undefined);
    } catch {
      /* no bridge in this window */
    }
    return true;
  };
}
