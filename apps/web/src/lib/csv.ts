/**
 * Minimal RFC 4180 CSV writer/reader. The writer neutralises spreadsheet
 * formula injection (cells starting with = + - @ tab CR are prefixed with ')
 * because names and subjects come from user input.
 */
export type Cell = string | number | boolean | null | undefined | Date;

function cellText(v: Cell): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

export function csvCell(v: Cell): string {
  let s = cellText(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers: string[], rows: Cell[][]): string {
  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  // BOM so Excel opens UTF-8 names correctly.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** Parse CSV text into rows of strings (handles quotes, CRLF, BOM). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  const s = text.replace(/^\uFEFF/, '');
  while (i < s.length) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cell += c;
      i++;
      continue;
    }
    if (c === '"' && cell === '') {
      quoted = true;
      i++;
      continue;
    }
    if (c === ',') {
      row.push(cell);
      cell = '';
      i++;
      continue;
    }
    if (c === '\r' || c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      if (c === '\r' && s[i + 1] === '\n') i++;
      i++;
      continue;
    }
    cell += c;
    i++;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

export function csvResponse(filename: string, body: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
      'Cache-Control': 'no-store',
    },
  });
}
