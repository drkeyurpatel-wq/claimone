/**
 * The weekly upload. Whatever arrived this week — the PMJAY settlement sheet,
 * a TPA's Excel, or the lines Claude read off a PDF / photo / email — becomes
 * one list of PaymentLine, which the database matches to bills
 * (clm_apply_payments). Pure functions, no I/O.
 */
import { parseAdvice, parseAmount, parseDate } from './parse';

export interface PaymentLine {
  source: 'pmjay' | 'letter';
  payer_name: string | null;
  tpa_name: string | null;
  claim_ref: string | null;
  bill_no: string | null;
  patient_name: string | null;
  ip_no: string | null;
  uhid: string | null;
  doctor_name: string | null;
  bill_date: string | null;
  claimed_amount: number | null;
  approved_amount: number | null;
  tds_amount: number;
  deduction_amount: number;
  deduction_reason: string | null;
  net_amount: number;
  utr: string | null;
  payment_date: string | null;
}

export type Cell = string | number | boolean | Date | null | undefined;

const pad = (n: number) => String(n).padStart(2, '0');

/** Spreadsheet cells → strings the CSV parsers understand. Long IDs keep every digit; dates become YYYY-MM-DD. */
export function cellsToRows(cells: Cell[][]): string[][] {
  return cells.map((r) =>
    r.map((c) => {
      if (c == null) return '';
      if (c instanceof Date) return `${c.getUTCFullYear()}-${pad(c.getUTCMonth() + 1)}-${pad(c.getUTCDate())}`;
      if (typeof c === 'number') return Number.isInteger(c) ? BigInt(c).toString() : String(c);
      return String(c);
    }),
  );
}

const norm = (h: string) => h.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
const round2 = (n: number) => Math.round(n * 100) / 100;

function findHeader(rows: string[][], must: string[]): number {
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const H = rows[i].map(norm);
    if (must.every((m) => H.includes(norm(m)))) return i;
  }
  return -1;
}

export function isPmjaySheet(rows: string[][]): boolean {
  return findHeader(rows, ['Invoice No', 'Letter No', 'Claim Paid Amount']) >= 0;
}

/**
 * PMJAY / MA settlement sheet (bill_settle_sheet_pmjay*.xlsx):
 * Invoice No. · Inv. Date · IP No. · Reg. No. · Patient Name · Letter No. · Doctor Name ·
 * Credit Limit · Pending · TDS Amount · Claim Paid Amount · UTR · Payment Date.
 * "Pending" is what was claimed; a row with Claim Paid Amount 0 is not paid yet.
 */
export function parsePmjay(rows: string[][]): { rows: PaymentLine[]; skipped: number } {
  const h = findHeader(rows, ['Invoice No', 'Letter No', 'Claim Paid Amount']);
  if (h < 0) throw new Error('This is not the PMJAY settlement sheet (needs Invoice No., Letter No., Claim Paid Amount).');
  const H = rows[h].map(norm);
  const at = (name: string) => H.indexOf(norm(name));
  const c = {
    inv: at('Invoice No'), idate: at('Inv Date'), ip: at('IP No'), reg: at('Reg No'), name: at('Patient Name'),
    letter: at('Letter No'), doc: at('Doctor Name'), limit: at('Credit Limit'), pending: at('Pending'),
    tds: at('TDS Amount'), paid: at('Claim Paid Amount'), utr: at('UTR'), pdate: at('Payment Date'),
  };
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
  const out: PaymentLine[] = [];
  let skipped = 0;
  for (const r of rows.slice(h + 1)) {
    const bill = get(r, c.inv);
    const letter = get(r, c.letter).replace(/\.0+$/, '');
    if (!bill && !letter) { if (r.some((v) => String(v).trim())) skipped++; continue; }
    const net = parseAmount(get(r, c.paid)) ?? 0;
    out.push({
      source: 'pmjay', payer_name: 'PMJAY / MA (Gujarat)', tpa_name: null,
      claim_ref: letter || null, bill_no: bill || null, patient_name: get(r, c.name) || null,
      ip_no: get(r, c.ip) || null, uhid: get(r, c.reg) || null, doctor_name: get(r, c.doc) || null,
      bill_date: parseDate(get(r, c.idate)),
      claimed_amount: parseAmount(get(r, c.pending)) ?? parseAmount(get(r, c.limit)),
      approved_amount: null,
      tds_amount: round2(parseAmount(get(r, c.tds)) ?? 0),
      deduction_amount: 0, deduction_reason: null,
      net_amount: round2(net),
      utr: net > 0 ? get(r, c.utr) || null : null,
      payment_date: net > 0 ? parseDate(get(r, c.pdate).slice(0, 10)) : null,
    });
  }
  return { rows: out, skipped };
}

/** Any other settlement Excel/CSV (TPA portal download): reuse the advice parser. */
export function parseLetterSheet(rows: string[][], payerName: string | null): { rows: PaymentLine[]; skipped: number } {
  const r = parseAdvice(rows);
  return {
    skipped: r.skipped.length,
    rows: r.rows.map((a) => ({
      source: 'letter', payer_name: payerName, tpa_name: null, claim_ref: a.claim_ref, bill_no: a.bill_no,
      patient_name: a.patient_name, ip_no: null, uhid: null, doctor_name: null, bill_date: null,
      claimed_amount: null, approved_amount: a.approved_amount, tds_amount: a.tds_amount,
      deduction_amount: a.deduction_amount, deduction_reason: a.deduction_reason, net_amount: a.net_amount,
      utr: a.utr, payment_date: a.advice_date,
    })),
  };
}

/** Pick the right reader for a spreadsheet. */
export function parsePaymentSheet(rows: string[][], payerName: string | null = null) {
  return isPmjaySheet(rows) ? parsePmjay(rows) : parseLetterSheet(rows, payerName);
}

/** Lines Claude read off a letter: fill gaps, drop what can't be matched. */
export function cleanLetterLines(raw: unknown): PaymentLine[] {
  if (!Array.isArray(raw)) return [];
  const s = (v: unknown) => (v == null ? null : String(v).trim() || null);
  const n = (v: unknown) => (v == null || v === '' ? null : parseAmount(String(v)));
  const out: PaymentLine[] = [];
  for (const x of raw as Record<string, unknown>[]) {
    if (!x || typeof x !== 'object') continue;
    const approved = n(x.approved_amount);
    const tds = n(x.tds_amount) ?? 0;
    let net = n(x.net_amount);
    if (net == null && approved != null) net = approved - tds;
    if (net == null || (!s(x.claim_ref) && !s(x.bill_no))) continue;
    out.push({
      source: 'letter', payer_name: s(x.payer_name), tpa_name: s(x.tpa_name), claim_ref: s(x.claim_ref), bill_no: s(x.bill_no),
      patient_name: s(x.patient_name), ip_no: s(x.ip_no), uhid: s(x.uhid), doctor_name: null, bill_date: parseDate(s(x.bill_date)),
      claimed_amount: n(x.claimed_amount), approved_amount: approved, tds_amount: round2(tds),
      deduction_amount: round2(n(x.deduction_amount) ?? 0), deduction_reason: s(x.deduction_reason), net_amount: round2(net),
      utr: s(x.utr), payment_date: parseDate(s(x.payment_date)),
    });
  }
  return out;
}

export interface UploadSummary { lines: number; paid: number; paidAmount: number; tds: number; unpaid: number }

export function summarise(lines: PaymentLine[]): UploadSummary {
  const paid = lines.filter((l) => l.net_amount > 0);
  return {
    lines: lines.length, paid: paid.length,
    paidAmount: round2(paid.reduce((a, l) => a + l.net_amount, 0)),
    tds: round2(paid.reduce((a, l) => a + l.tds_amount, 0)),
    unpaid: lines.length - paid.length,
  };
}
