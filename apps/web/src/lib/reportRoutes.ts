import { csvResponse } from './csv';
import {
  attendanceDetail,
  attendanceDetailCsv,
  parseReportFilter,
  ReportError,
  sessionSummary,
  sessionSummaryCsv,
  studentSummaryCsv,
  summariseByStudent,
} from './reports';
import { jsonError, jsonOk } from './response';

export type ReportKind = 'sessions' | 'students' | 'detail';

/** JSON or (?format=csv) CSV for one report; teacherId forces a teacher's own sessions. */
export async function reportResponse(kind: ReportKind, req: Request, scope: { teacherId?: string } = {}) {
  const url = new URL(req.url);
  try {
    const f = parseReportFilter(url, { forceTeacherId: scope.teacherId });
    const csv = url.searchParams.get('format') === 'csv';
    const stamp = `${f.from}_${f.to}`;
    if (kind === 'sessions') {
      const rows = await sessionSummary(f);
      return csv ? csvResponse(`sessions_${stamp}.csv`, sessionSummaryCsv(rows)) : jsonOk({ filter: f, rows });
    }
    const detail = await attendanceDetail(f);
    if (kind === 'detail') {
      return csv ? csvResponse(`attendance_${stamp}.csv`, attendanceDetailCsv(detail)) : jsonOk({ filter: f, rows: detail.slice(0, 5000), total: detail.length });
    }
    const rows = summariseByStudent(detail);
    return csv ? csvResponse(`students_${stamp}.csv`, studentSummaryCsv(rows)) : jsonOk({ filter: f, rows });
  } catch (e) {
    if (e instanceof ReportError) return jsonError(e.message);
    console.error('report failed', e);
    return jsonError('Could not build the report', 500);
  }
}
