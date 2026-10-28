// bot/src/statement.ts — turn a downloaded payment statement into rows of text,
// the shape ClaimOne's "Upload payments" screen reads (same as an uploaded file).
import readXlsxFile from 'read-excel-file/node';

type Cell = string | number | boolean | Date | null | undefined;
const pad = (n: number) => String(n).padStart(2, '0');

/** Excel cells → text. Long IDs keep every digit; dates become YYYY-MM-DD. */
export function cellsToRows(cells: Cell[][]): string[][] {
  return cells.map((r) => r.map((c) => {
    if (c == null) return '';
    if (c instanceof Date) return `${c.getUTCFullYear()}-${pad(c.getUTCMonth() + 1)}-${pad(c.getUTCDate())}`;
    if (typeof c === 'number') return Number.isInteger(c) ? BigInt(c).toString() : String(c);
    return String(c).trim();
  })).filter((r) => r.some((v) => v !== ''));
}

/** RFC-4180 CSV, enough for portal exports. */
export function csvRows(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let f = ''; let q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(f); f = ''; if (row.some((v) => v.trim())) rows.push(row); row = []; }
    else f += c;
  }
  row.push(f); if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}

/**
 * Rows from the flow's outputs: a downloaded file (payments_file → .xlsx or .csv)
 * or a table read off the page (payments_table, with its column names as the header).
 */
export async function statementRows(outputs: Record<string, string>): Promise<string[][]> {
  if (outputs.payments_file_buffer) {
    const buf = Buffer.from(outputs.payments_file_buffer, 'base64');
    const name = (outputs.payments_file_filename || '').toLowerCase();
    if (name.endsWith('.csv') || buf.subarray(0, 2).toString() !== 'PK') return csvRows(buf.toString('utf8'));
    return cellsToRows((await readXlsxFile(buf)) as Cell[][]);
  }
  if (outputs.payments_table) {
    const table = JSON.parse(outputs.payments_table) as Record<string, string>[];
    if (!table.length) return [];
    const head = Object.keys(table[0]);
    return [head, ...table.map((r) => head.map((h) => r[h] ?? ''))].filter((r, i) => i === 0 || r.some((v) => v.trim()));
  }
  return [];
}

/** {{from_date}} / {{to_date}} for the portal's date filter, day-first as Indian portals expect. */
export function statementWindow(today: Date, days: number): Record<string, string> {
  const fmt = (d: Date) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  const from = new Date(today.getTime() - days * 86400000);
  return { from_date: fmt(from), to_date: fmt(today) };
}
