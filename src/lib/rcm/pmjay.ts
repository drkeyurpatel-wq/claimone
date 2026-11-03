/**
 * The PMJAY desk's monthly sheet (one row per PMJAY case) → rows for
 * clm_import_pmjay. Pure functions, no I/O.
 *
 * PMJAY pays Shilaj the NABH package rate, so that is the claim amount.
 * The NO NABH rate is sent too and kept for internal calculations.
 */
import type { Cell } from '@/lib/recon/payments';

export interface PmjayRow {
  ip_no: string;
  patient_name: string;
  case_no: string | null;
  card_no: string | null;
  case_status: string | null;
  doctor: string | null;
  admitted_on: string | null;    // YYYY-MM-DD
  discharged_on: string | null;
  category: string | null;
  procedure: string | null;
  nabh_amount: number | null;
  non_nabh_amount: number | null;
  utr: string | null;
  paid_on: string | null;
  paid_amount: number | null;
  deduction: number | null;
  remarks: string | null;
}

const norm = (h: unknown) => String(h ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

/** Header names as typed on the sheet (normalised), with the spellings we have seen. */
const COLS: Record<keyof PmjayRow, string[]> = {
  ip_no: ['IP NO', 'IP NUMBER', 'IPD NO'],
  patient_name: ['PATIENT NAME'],
  case_no: ['CASE NO', 'CASE NUMBER', 'CASE ID'],
  card_no: ['CARD NUMBER', 'CARD NO', 'PMJAY ID', 'BENEFICIARY ID'],
  case_status: ['CASE STATUS', 'STATUS'],
  doctor: ['DR NAME', 'DOCTOR NAME', 'DOCTOR'],
  admitted_on: ['DOA', 'ADMISSION DATE'],
  discharged_on: ['DOD', 'DISCHARGE DATE'],
  category: ['CATEGORY', 'SPECIALITY', 'SPECIALTY'],
  procedure: ['PROCEDURE NAME', 'PROCEDURE', 'PACKAGE NAME'],
  nabh_amount: ['NABH', 'NABH AMOUNT'],
  non_nabh_amount: ['NO NABH', 'NON NABH', 'NO NABH AMOUNT', 'NON NABH AMOUNT'],
  utr: ['UTR NUMBER', 'UTR NO', 'UTR'],
  paid_on: ['CALIM PAID DATE', 'CLAIM PAID DATE', 'PAID DATE', 'PAYMENT DATE'],
  paid_amount: ['FINAL AMOUNT', 'PAID AMOUNT'],
  deduction: ['DED AMOUNT', 'DEDUCTION', 'DEDUCTION AMOUNT'],
  remarks: ['REMARKS', 'REMARK'],
};

export function findPmjayHeader(cells: Cell[][]): number {
  for (let i = 0; i < Math.min(cells.length, 25); i++) {
    const H = (cells[i] ?? []).map(norm);
    if (H.includes('IP NO') && H.includes('PATIENT NAME') && H.includes('NABH')) return i;
  }
  return -1;
}

export const isPmjaySheet = (cells: Cell[][]) => findPmjayHeader(cells) >= 0;

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const valid = (y: number, m: number, d: number) => {
  if (m < 1 || m > 12 || d < 1 || y < 2000 || y > 2100) return false;
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};
const days = (s: string, ref: Date) => Math.abs(Date.parse(`${s}T00:00:00Z`) - ref.getTime()) / 864e5;

/**
 * Dates on this sheet are typed day-first. Excel often reads "02/11/2026" as
 * 11 Feb, so an Excel date is read both ways and the one nearer the upload
 * day wins. Text dates ("29-10-2026", "29/10/2026") are always day-first.
 */
export function pmjayDate(v: Cell, ref: Date = new Date()): string | null {
  if (v == null || v === '') return null;
  if (v instanceof Date || typeof v === 'number') {
    const d = v instanceof Date ? v : new Date(Math.round((v - 25569) * 864e5));
    if (Number.isNaN(d.getTime())) return null;
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1, day = d.getUTCDate();
    const asIs = ymd(y, m, day);
    if (day > 12 || !valid(y, day, m)) return asIs;
    const swapped = ymd(y, day, m);
    return days(swapped, ref) < days(asIs, ref) ? swapped : asIs;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})\b/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return valid(y, Number(m[2]), Number(m[1])) ? ymd(y, Number(m[2]), Number(m[1])) : null;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return valid(+m[1], +m[2], +m[3]) ? ymd(+m[1], +m[2], +m[3]) : null;
  return null;
}

export function pmjayAmount(v: Cell): number | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  const s = String(v).replace(/[₹,\s]/g, '').replace(/^rs\.?/i, '');
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s) * 100) / 100;
}

const text = (v: Cell) => {
  if (v == null) return null;
  const s = (v instanceof Date ? '' : String(v)).replace(/\s+/g, ' ').trim();
  return s || null;
};

/** Case and card numbers can come through as long numbers: keep every digit. */
const code = (v: Cell) => (typeof v === 'number' ? (Number.isInteger(v) ? BigInt(Math.round(v)).toString() : String(v)) : text(v));

export function parsePmjay(cells: Cell[][], ref: Date = new Date()): { rows: PmjayRow[]; header: number } {
  const header = findPmjayHeader(cells);
  if (header < 0) return { rows: [], header };
  const H = cells[header].map(norm);
  const at = {} as Record<keyof PmjayRow, number>;
  for (const k of Object.keys(COLS) as (keyof PmjayRow)[]) {
    // exact name first, so "NABH" never picks up "NO NABH"
    at[k] = COLS[k].map((n) => H.indexOf(n)).find((i) => i >= 0) ?? -1;
  }
  const get = (r: Cell[], k: keyof PmjayRow) => (at[k] >= 0 ? r[at[k]] : null);

  const rows: PmjayRow[] = [];
  for (const r of cells.slice(header + 1)) {
    if (!r) continue;
    const ip = text(get(r, 'ip_no'))?.toUpperCase().replace(/\s+/g, '') ?? null;
    const name = text(get(r, 'patient_name'));
    if (!ip || !name) continue;
    rows.push({
      ip_no: ip,
      patient_name: name,
      case_no: code(get(r, 'case_no')),
      card_no: code(get(r, 'card_no')),
      case_status: text(get(r, 'case_status')),
      doctor: text(get(r, 'doctor')),
      admitted_on: pmjayDate(get(r, 'admitted_on'), ref),
      discharged_on: pmjayDate(get(r, 'discharged_on'), ref),
      category: text(get(r, 'category')),
      procedure: text(get(r, 'procedure')),
      nabh_amount: pmjayAmount(get(r, 'nabh_amount')),
      non_nabh_amount: pmjayAmount(get(r, 'non_nabh_amount')),
      utr: code(get(r, 'utr')),
      paid_on: pmjayDate(get(r, 'paid_on'), ref),
      paid_amount: pmjayAmount(get(r, 'paid_amount')),
      deduction: pmjayAmount(get(r, 'deduction')),
      remarks: text(get(r, 'remarks')),
    });
  }
  return { rows, header };
}

/** Things the desk should look at before saving. Never blocks the upload. */
export function pmjayWarnings(rows: PmjayRow[]): { ip: string; note: string }[] {
  const out: { ip: string; note: string }[] = [];
  for (const r of rows) {
    if (!r.nabh_amount) out.push({ ip: r.ip_no, note: 'No NABH amount — status will not be updated' });
    else if (r.non_nabh_amount && r.non_nabh_amount > r.nabh_amount) out.push({ ip: r.ip_no, note: 'NO NABH is more than NABH — the two may be swapped' });
    if (r.discharged_on && r.admitted_on && r.discharged_on < r.admitted_on) out.push({ ip: r.ip_no, note: 'Discharge date is before admission date' });
    if (r.paid_amount && !r.utr) out.push({ ip: r.ip_no, note: 'Final amount without a UTR — payment will not be recorded' });
  }
  return out;
}
