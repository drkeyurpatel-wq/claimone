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
  /** PMJAY: one case ID (letter) can cover several invoices — e.g. dialysis sessions. */
  bills?: BillPart[];
}

export interface BillPart {
  bill_no: string; bill_date: string | null; ip_no: string | null; uhid: string | null;
  patient_name: string | null; doctor_name: string | null; claimed_amount: number | null;
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
  return { rows: groupByCase(out), skipped };
}

/**
 * In the PMJAY sheet a case ID with several invoices (dialysis, repeat day-care)
 * repeats the case's TOTAL paid and TDS on every invoice row. Counting each row
 * would multiply the payment. Rows of one case with the same paid/TDS/UTR become
 * one payment line that lists its invoices.
 */
export function groupByCase(lines: PaymentLine[]): PaymentLine[] {
  const by = new Map<string, PaymentLine[]>();
  const out: PaymentLine[] = [];
  for (const l of lines) {
    if (!l.claim_ref || !l.bill_no) { out.push(l); continue; }
    const k = l.claim_ref;
    if (!by.has(k)) { by.set(k, []); out.push(l); }
    by.get(k)!.push(l);
  }
  return out.map((l) => {
    const g = l.claim_ref && l.bill_no ? by.get(l.claim_ref)! : [l];
    if (g.length < 2) return l;
    const same = g.every((x) => x.net_amount === l.net_amount && x.tds_amount === l.tds_amount && x.utr === l.utr);
    if (!same) return l;   // genuinely separate payments: keep (only the first is emitted below)
    const claimed = g.reduce((a, x) => a + (x.claimed_amount ?? 0), 0);
    return {
      ...l, bill_no: null, claimed_amount: round2(claimed),
      bills: g.map((x) => ({ bill_no: x.bill_no!, bill_date: x.bill_date, ip_no: x.ip_no, uhid: x.uhid, patient_name: x.patient_name,
        doctor_name: x.doctor_name, claimed_amount: x.claimed_amount })),
    };
  }).flatMap((l) => {
    // a case whose rows differ: emit every row as its own payment
    if (l.bills || !l.claim_ref || !l.bill_no) return [l];
    const g = by.get(l.claim_ref)!;
    return g.length > 1 ? g : [l];
  });
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

export function isBillsMaster(rows: string[][]): boolean {
  return findHeader(rows, ['Bill no', 'Approved', 'Received from payer']) >= 0;
}

/**
 * The Health1 Credit Master "Bills" tab (one-time load, or catching up):
 * every TPA / insurer bill with what was approved and what came in.
 * Patient / doctor dues rows are left out — they are not payer payments.
 */
export function parseBillsMaster(rows: string[][]): { rows: PaymentLine[]; skipped: number } {
  const h = findHeader(rows, ['Bill no', 'Approved', 'Received from payer']);
  if (h < 0) throw new Error('This is not the Bills tab of the credit master.');
  const H = rows[h].map(norm);
  const at = (...names: string[]) => { for (const n of names) { const i = H.indexOf(norm(n)); if (i >= 0) return i; } return -1; };
  const c = {
    cat: at('Payer category'), uhid: at('UHID'), ip: at('IP no'), name: at('Patient name', 'Patient'), doc: at('Treating doctor', 'Doctor'),
    bill: at('Bill no'), bdate: at('Bill date'), dis: at('Discharge date', 'Discharge'), payer: at('Insurer / payer', 'Insurer'), tpa: at('TPA'),
    claim: at('Claim no', 'Claim no / case ID'), billed: at('Total bill'), appr: at('Approved'), recv: at('Received from payer', 'Received'),
    pdate: at('Payment date'), utr: at('UTR'), tds: at('TDS'), why: at('Short-pay reason'),
  };
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
  const out: PaymentLine[] = [];
  let skipped = 0;
  for (const r of rows.slice(h + 1)) {
    const bill = get(r, c.bill);
    const claim = get(r, c.claim).replace(/\.0+$/, '');
    if (!bill && !claim) { if (r.some((v) => String(v).trim())) skipped++; continue; }
    if (/patient|doctor/i.test(get(r, c.cat))) { skipped++; continue; }
    const approved = parseAmount(get(r, c.appr));
    const net = parseAmount(get(r, c.recv)) ?? 0;
    const tds = parseAmount(get(r, c.tds)) ?? 0;
    const why = get(r, c.why) || null;
    const gap = approved != null && net > 0 ? round2(approved - net - tds) : 0;
    out.push({
      source: 'letter', payer_name: get(r, c.payer) || null, tpa_name: get(r, c.tpa) || null,
      claim_ref: claim || null, bill_no: bill || null, patient_name: get(r, c.name) || null, ip_no: get(r, c.ip) || null,
      uhid: get(r, c.uhid) || null, doctor_name: get(r, c.doc) || null,
      bill_date: parseDate(get(r, c.bdate)) ?? parseDate(get(r, c.dis)),
      claimed_amount: null, approved_amount: approved ?? parseAmount(get(r, c.billed)),
      tds_amount: round2(tds), deduction_amount: gap > 1 && why ? gap : 0, deduction_reason: gap > 1 ? why : null,
      net_amount: round2(net), utr: net > 0 ? get(r, c.utr) || null : null,
      payment_date: net > 0 ? parseDate(get(r, c.pdate)) : null,
    });
  }
  return { rows: out, skipped };
}

/** Pick the right reader for a spreadsheet. */
export function parsePaymentSheet(rows: string[][], payerName: string | null = null) {
  if (isPmjaySheet(rows)) return parsePmjay(rows);
  if (isBillsMaster(rows)) return parseBillsMaster(rows);
  return parseLetterSheet(rows, payerName);
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
