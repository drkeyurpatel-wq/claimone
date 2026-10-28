/**
 * The daily eCW export ("IPD, daycare" admissions / discharges report) →
 * one row per admission for clm_import_cases. Pure functions, no I/O.
 *
 * Cash / self-pay rows are sent too: the database decides credit vs cash
 * from the sponsor name (clm_sponsor_map), so a new sponsor is reported back
 * instead of silently dropped.
 */
import type { Cell } from '@/lib/recon/payments';

export interface CaseRow {
  ip_no: string;
  uhid: string | null;
  patient_name: string;
  phone: string | null;
  admitted_at: string | null;   // ISO, IST
  intimated_at: string | null;
  discharged_at: string | null;
  bill_no: string | null;
  bill_date: string | null;     // YYYY-MM-DD
  sponsor: string | null;
  doctor: string | null;
  specialisation: string | null;
  bed_category: string | null;
  bill_amount: number | null;
  discount_amount: number | null;
  net_amount: number | null;
  paid_amount: number | null;
  estimated_amount: number | null;
}

const norm = (h: unknown) => String(h ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

/** Header names as eCW prints them (normalised), with the few spellings we have seen. */
const COLS: Record<keyof CaseRow, string[]> = {
  ip_no: ['IP NO'],
  uhid: ['REGISTRATION NO', 'UHID', 'REG NO'],
  patient_name: ['PATIENT NAME'],
  phone: ['MOBILE NO', 'MOBILE'],
  admitted_at: ['ADMISSION DATE TIME', 'ADMISSION DATE'],
  intimated_at: ['INTIMATED DATE TIME'],
  discharged_at: ['DISCHARGE DATE', 'DISCHARGE DATE TIME'],
  bill_no: ['BILL NO'],
  bill_date: ['INVOICE DATE TIME', 'BILL DATE'],
  sponsor: ['SPONSOR NAME', 'SPONSOR'],
  doctor: ['ADMITTED UNDER DOCTOR', 'CONSULTANT', 'TREATING DOCTOR'],
  specialisation: ['SPECIALISATION', 'SPECIALIZATION', 'DEPARTMENT'],
  bed_category: ['BILLING CATEGORY', 'BED CATEGORY'],
  bill_amount: ['BILL AMOUNT'],
  discount_amount: ['DISCOUNT AMOUNT'],
  net_amount: ['NET AMOUNT'],
  paid_amount: ['PAID AMOUNT'],
  estimated_amount: ['ESTIMATED AMOUNT'],
};
const CREDIT_LIMIT = 'CREDIT LIMIT';

export function findEcwHeader(cells: Cell[][]): number {
  for (let i = 0; i < Math.min(cells.length, 25); i++) {
    const H = (cells[i] ?? []).map(norm);
    if (H.includes('IP NO') && H.includes('PATIENT NAME') && (H.includes('SPONSOR NAME') || H.includes('SPONSOR'))) return i;
  }
  return -1;
}

export const isEcwSheet = (cells: Cell[][]) => findEcwHeader(cells) >= 0;

const pad = (n: number) => String(n).padStart(2, '0');

/** "30/09/2026 14:41:01", "30/09/2026 07:05 PM", "30/09/2026", Excel Date or serial → ISO in IST. */
export function ecwDateTime(v: Cell): string | null {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    // read-excel-file gives the sheet's wall-clock time as UTC fields
    return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}T${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}:00+05:30`;
  }
  if (typeof v === 'number') {
    if (v < 20000 || v > 80000) return null;
    return ecwDateTime(new Date(Math.round((v - 25569) * 86400000)));
  }
  const s = String(v).trim();
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i);
  if (m) {
    const [, d, mo, y, hh, mi, , ap] = m;
    let h = hh ? Number(hh) : 0;
    if (ap) { h = h % 12; if (ap.toUpperCase() === 'PM') h += 12; }
    if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31 || h > 23) return null;
    return `${y}-${pad(Number(mo))}-${pad(Number(d))}T${pad(h)}:${mi ?? '00'}:00+05:30`;
  }
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}T${iso[4] ?? '00'}:${iso[5] ?? '00'}:00+05:30`;
  return null;
}

function amount(v: Cell): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function text(v: Cell, max = 200): string | null {
  if (v == null) return null;
  const s = (typeof v === 'number' && Number.isInteger(v) ? BigInt(v).toString() : String(v)).replace(/\s+/g, ' ').trim();
  return s && s !== '.' ? s.slice(0, max) : null;
}

/** "Dr. Rajdeep Gupta Health One Team" → "Dr. Rajdeep Gupta" */
export function cleanDoctor(s: string | null): string | null {
  return s ? s.replace(/\s*Health\s*One\s*Team\s*$/i, '').trim() || null : null;
}

export interface EcwParse { rows: CaseRow[]; skipped: number; duplicates: number }

export function parseEcw(cells: Cell[][]): EcwParse {
  const h = findEcwHeader(cells);
  if (h < 0) return { rows: [], skipped: 0, duplicates: 0 };
  const H = cells[h].map(norm);
  const at = {} as Record<keyof CaseRow, number>;
  for (const k of Object.keys(COLS) as (keyof CaseRow)[]) at[k] = COLS[k].map((n) => H.indexOf(n)).find((i) => i >= 0) ?? -1;
  const get = (r: Cell[], k: keyof CaseRow): Cell => (at[k] >= 0 ? r[at[k]] : null);
  const limitAt = H.indexOf(CREDIT_LIMIT);

  const byIp = new Map<string, CaseRow>();
  let skipped = 0, duplicates = 0;
  for (const r of cells.slice(h + 1)) {
    if (!r || r.every((c) => c == null || c === '')) continue;
    const ip = text(get(r, 'ip_no'), 40);
    const name = text(get(r, 'patient_name'));
    if (!ip || !name) { skipped++; continue; }
    const bill = text(get(r, 'bill_no'), 60);
    const billAt = ecwDateTime(get(r, 'bill_date'));
    const row: CaseRow = {
      ip_no: ip,
      uhid: text(get(r, 'uhid'), 40),
      patient_name: name,
      phone: text(get(r, 'phone'), 20),
      admitted_at: ecwDateTime(get(r, 'admitted_at')),
      intimated_at: ecwDateTime(get(r, 'intimated_at')),
      discharged_at: ecwDateTime(get(r, 'discharged_at')),
      bill_no: bill,
      bill_date: bill && billAt ? billAt.slice(0, 10) : null,
      sponsor: text(get(r, 'sponsor'), 120),
      doctor: cleanDoctor(text(get(r, 'doctor'))),
      specialisation: text(get(r, 'specialisation'), 80),
      bed_category: text(get(r, 'bed_category'), 60),
      bill_amount: amount(get(r, 'bill_amount')),
      discount_amount: amount(get(r, 'discount_amount')),
      net_amount: bill ? amount(get(r, 'net_amount')) : null,
      paid_amount: amount(get(r, 'paid_amount')),
      // eCW leaves Estimated Amount at 0 for most cases; the credit limit is the sanctioned amount
      estimated_amount: amount(get(r, 'estimated_amount')) || (limitAt >= 0 ? amount(r[limitAt]) : null) || null,
    };
    const key = ip.toUpperCase();
    if (byIp.has(key)) { duplicates++; }
    // the same admission can appear on several sheets/rows: keep the one with the bill
    const prev = byIp.get(key);
    if (!prev || (!prev.bill_no && row.bill_no)) byIp.set(key, row);
  }
  return { rows: [...byIp.values()], skipped, duplicates };
}

export interface EcwSummary { admissions: number; discharged: number; inHouse: number; bySponsor: { sponsor: string; count: number }[] }

export function summariseEcw(rows: CaseRow[]): EcwSummary {
  const s = new Map<string, number>();
  for (const r of rows) s.set(r.sponsor ?? '(blank)', (s.get(r.sponsor ?? '(blank)') ?? 0) + 1);
  return {
    admissions: rows.length,
    discharged: rows.filter((r) => r.discharged_at).length,
    inHouse: rows.filter((r) => !r.discharged_at).length,
    bySponsor: [...s].map(([sponsor, count]) => ({ sponsor, count })).sort((a, b) => b.count - a.count),
  };
}
