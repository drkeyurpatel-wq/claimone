/**
 * Reading what the accounts and cashless teams already have: CSV exports of
 * the bank statement, the cashless tracker sheet, payer settlement advices,
 * and the patient-dues list. Pure functions, no I/O.
 */

// ─── CSV ─────────────────────────────────────────────────────────────

/** RFC-4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  return rows;
}

// ─── Values ──────────────────────────────────────────────────────────

/** "1,05,000" → 105000; "50K Due" → 50000; "-" or "" → null. */
export function parseAmount(v: string | undefined | null): number | null {
  if (v == null) return null;
  const s = String(v).trim().replace(/[₹,\s]/g, '').replace(/(Cr|Dr)$/i, '');
  if (s === '' || s === '-') return null;
  const k = /^(\d+(?:\.\d+)?)[kK]/.exec(s);
  if (k) return Number(k[1]) * 1000;
  const n = Number(s.replace(/^\((.*)\)$/, '-$1'));
  return Number.isFinite(n) ? n : null;
}

const MONTHS: Record<string, number> = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

/** Indian bank and sheet dates are day-first: 05/06/2026 is 5 June. Returns YYYY-MM-DD or null. */
export function parseDate(v: string | undefined | null): string | null {
  if (!v) return null;
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
  let d: number, mo: number, y: number;
  if (m) { d = +m[1]; mo = +m[2]; y = +m[3]; }
  else {
    m = /^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-,]*(\d{2,4})$/.exec(s);
    if (!m) return null;
    d = +m[1]; mo = MONTHS[m[2].toUpperCase()] ?? 0; y = +m[3];
  }
  if (y < 100) y += 2000;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1) return null;
  return dt.toISOString().slice(0, 10);
}

/**
 * Pull the transfer reference out of a bank narration.
 * "NEFT HDFCH01122534620 HDFC ERGO GENERAL\tNEFTINW-1614370242" → "HDFCH01122534620".
 * Internal transfers ("IFT-NATIONAL INSURANCE COMPANY") carry none → null.
 */
export function extractReference(narration: string | undefined | null): string | null {
  if (!narration) return null;
  const s = narration.toUpperCase();
  for (const tok of s.match(/\b[A-Z]{4}[A-Z0-9]{8,22}\b/g) ?? []) {
    if (/^(NEFT|RTGS|IMPS)[A-Z]*$/.test(tok)) continue;
    if (/\d/.test(tok) && /\d{6,}/.test(tok)) return tok;
  }
  const inw = /NEFTINW-\d+/.exec(s);
  if (inw) return inw[0];
  const utr = /\bUTR[:\s-]*([A-Z0-9]{10,22})\b/.exec(s);
  return utr ? utr[1] : null;
}

// ─── Column mapping ──────────────────────────────────────────────────

const norm = (h: string) => h.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

function pick(headers: string[], ...candidates: string[]): number {
  const H = headers.map(norm);
  for (const c of candidates) {
    const i = H.indexOf(norm(c));
    if (i >= 0) return i;
  }
  for (const c of candidates) {
    const i = H.findIndex((h) => h.includes(norm(c)));
    if (i >= 0) return i;
  }
  return -1;
}

function headerRow(rows: string[][], must: string[]): number {
  for (let i = 0; i < Math.min(rows.length, 25); i++) {
    const H = rows[i].map(norm).join('|');
    if (must.every((m) => H.includes(norm(m)))) return i;
  }
  return -1;
}

export interface ParseResult<T> { rows: T[]; skipped: { line: number; reason: string }[] }

// ─── Bank statement (credits only) ──────────────────────────────────

export interface BankLine { value_date: string; amount: number; reference: string | null; narration: string }

export function parseBankStatement(rows: string[][]): ParseResult<BankLine> {
  const h = headerRow(rows, ['DATE']);
  if (h < 0) throw new Error('Could not find the header row (a column named Date).');
  const H = rows[h];
  const iDate = pick(H, 'Value Date', 'Txn Date', 'Transaction Date', 'Date');
  const iDesc = pick(H, 'Description', 'Narration', 'Particulars', 'Remarks');
  const iRef = pick(H, 'Chq / Ref No', 'Ref No', 'Reference', 'Cheque No', 'UTR');
  const iCr = pick(H, 'Credit', 'Deposit', 'Cr Amount', 'Credit Amount');
  const iDrCr = pick(H, 'Dr / Cr', 'Dr/Cr', 'Type');
  const iAmt = pick(H, 'Amount');
  if (iDate < 0 || iDesc < 0 || (iCr < 0 && iAmt < 0)) throw new Error('Need Date, Description/Narration and Credit (or Amount + Dr/Cr) columns.');
  const out: BankLine[] = [];
  const skipped: ParseResult<BankLine>['skipped'] = [];
  rows.slice(h + 1).forEach((r, k) => {
    const line = h + 2 + k;
    const date = parseDate(r[iDate]);
    let amt: number | null = null;
    if (iCr >= 0) amt = parseAmount(r[iCr]);
    else if (iDrCr >= 0 && /^C/i.test((r[iDrCr] ?? '').trim())) amt = parseAmount(r[iAmt]);
    if (!date) { if (r.some((v) => v.trim())) skipped.push({ line, reason: 'no date' }); return; }
    if (!amt || amt <= 0) return;                       // debits and zero lines are not receipts
    const narration = (r[iDesc] ?? '').trim();
    const ref = (iRef >= 0 ? (r[iRef] ?? '').trim() : '') || null;
    out.push({ value_date: date, amount: Math.round(amt * 100) / 100, reference: extractReference(narration) ?? ref, narration });
  });
  return { rows: out, skipped };
}

// ─── Cashless tracker (the team's monthly sheet, one tab exported as CSV) ─

export interface TrackerLine {
  ip_no: string; patient_name: string; doctor_name: string; bill_no: string; bill_date: string;
  insurer: string; tpa: string; claim_ref: string | null;
  billed: number | null; approved: number; discount: number | null; patient_paid: number | null;
  received: number | null; received_date: string | null; utr_narration: string | null; recorded_utr: string | null;
}

export function parseCashlessTracker(rows: string[][]): ParseResult<TrackerLine> {
  const h = headerRow(rows, ['IP NO', 'BILL NO']);
  if (h < 0) throw new Error('Could not find the tracker header (IP NO., BILL NO. …).');
  const H = rows[h];
  const col = {
    ip: pick(H, 'IP NO'), name: pick(H, 'PATIENT NAME'), doc: pick(H, 'DOCTOR NAME'), bill: pick(H, 'BILL NO'),
    dis: pick(H, 'DISCHARGE DATE'), bdate: pick(H, 'BILL DATE'), ins: pick(H, 'INSURANCE COMPANY'), tpa: pick(H, 'TPA NAME'),
    claim: pick(H, 'CLAIM NO'), billed: pick(H, 'TOTAL BILL AMT', 'BILL AMT'), appr: pick(H, 'IC APPROVAL AMT', 'APPROVAL AMT'),
    disc: pick(H, 'DISCOUNT AMT'), pt: pick(H, 'PAID BY PATIENT'), recv: pick(H, 'IC TO HOSP AMT'), rdate: pick(H, 'IC TO HOSP DATE'),
    utr: pick(H, 'TPA UTR DETAILS', 'UTR'),
  };
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
  const out: TrackerLine[] = [];
  const skipped: ParseResult<TrackerLine>['skipped'] = [];
  for (let k = h + 1; k < rows.length; k++) {
    const r = rows[k];
    const first = norm(r[0] ?? '');
    if (/^(SR|SR NO|NO)$/.test(first) || /REIMBURSEMENT|CASH NI RECEIPT/.test(r.join(' ').toUpperCase())) break; // next block
    const ip = get(r, col.ip);
    if (!ip) continue;
    const approved = parseAmount(get(r, col.appr));
    const bill_date = parseDate(get(r, col.bdate)) ?? parseDate(get(r, col.dis));
    if (approved == null || !bill_date) { skipped.push({ line: k + 1, reason: approved == null ? 'no approved amount' : 'no bill date' }); continue; }
    const narr = get(r, col.utr) || null;
    out.push({
      ip_no: ip, patient_name: get(r, col.name), doctor_name: get(r, col.doc), bill_no: get(r, col.bill), bill_date,
      insurer: get(r, col.ins), tpa: get(r, col.tpa), claim_ref: get(r, col.claim) || null,
      billed: parseAmount(get(r, col.billed)), approved, discount: parseAmount(get(r, col.disc)),
      patient_paid: parseAmount(get(r, col.pt)), received: parseAmount(get(r, col.recv)),
      received_date: parseDate(get(r, col.rdate)), utr_narration: narr, recorded_utr: extractReference(narr),
    });
  }
  return { rows: out, skipped };
}

// ─── Payer settlement advice ─────────────────────────────────────────

export interface AdviceLine {
  utr: string | null; advice_ref: string | null; advice_date: string | null; claim_ref: string | null; bill_no: string | null;
  patient_name: string | null; approved_amount: number | null; tds_amount: number; deduction_amount: number;
  deduction_reason: string | null; net_amount: number;
}

export function parseAdvice(rows: string[][]): ParseResult<AdviceLine> {
  const h = headerRow(rows, ['CLAIM']);
  if (h < 0) throw new Error('Could not find a header row with a Claim column.');
  const H = rows[h];
  const col = {
    utr: pick(H, 'UTR', 'UTR No', 'Transaction Ref', 'NEFT Ref'), ref: pick(H, 'Advice No', 'Payment Ref', 'Batch'),
    date: pick(H, 'Payment Date', 'Settlement Date', 'Date'), claim: pick(H, 'Claim No', 'Claim Number', 'CCN', 'Claim ID'),
    bill: pick(H, 'Bill No', 'Invoice No', 'Hospital Bill'), name: pick(H, 'Patient Name', 'Insured Name', 'Member Name', 'Claimant'),
    appr: pick(H, 'Approved', 'Settled Amount', 'Claim Amount Settled', 'Gross'), tds: pick(H, 'TDS'),
    ded: pick(H, 'Deduction', 'Disallowed', 'Disallowance'), why: pick(H, 'Deduction Reason', 'Remarks', 'Reason'),
    net: pick(H, 'Net Paid', 'Net Amount', 'Amount Paid', 'Net Payable', 'Paid Amount'),
  };
  if (col.net < 0) throw new Error('Need a Net Paid / Amount Paid column.');
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
  const out: AdviceLine[] = [];
  const skipped: ParseResult<AdviceLine>['skipped'] = [];
  rows.slice(h + 1).forEach((r, k) => {
    const net = parseAmount(get(r, col.net));
    if (net == null || net <= 0) { if (r.some((v) => v.trim())) skipped.push({ line: h + 2 + k, reason: 'no net amount' }); return; }
    out.push({
      utr: get(r, col.utr) || null, advice_ref: get(r, col.ref) || null, advice_date: parseDate(get(r, col.date)),
      claim_ref: get(r, col.claim) || null, bill_no: get(r, col.bill) || null, patient_name: get(r, col.name) || null,
      approved_amount: parseAmount(get(r, col.appr)), tds_amount: parseAmount(get(r, col.tds)) ?? 0,
      deduction_amount: parseAmount(get(r, col.ded)) ?? 0, deduction_reason: get(r, col.why) || null, net_amount: net,
    });
  });
  return { rows: out, skipped };
}

// ─── Patient dues ("CASH NI RECEIPT AAPEL CHE" list) ───────────────

export interface DueLine { ip_no: string; patient_name: string; doctor_name: string; amount: number; bill_date: string; care_of: string; note: string }

export function parsePatientDues(rows: string[][]): ParseResult<DueLine> {
  const h = headerRow(rows, ['IP NO', 'AMOUNT']);
  if (h < 0) throw new Error('Could not find the dues header (IP NO., AMOUNT …).');
  const H = rows[h];
  const col = { ip: pick(H, 'IP NO'), name: pick(H, 'PATIENT NAME'), doc: pick(H, 'DOCTOR NAME'), amt: pick(H, 'AMOUNT'),
    date: pick(H, 'DOD', 'DISCHARGE DATE', 'DATE'), rem: pick(H, 'REMARK', 'CARE OF') };
  const out: DueLine[] = [];
  const skipped: ParseResult<DueLine>['skipped'] = [];
  rows.slice(h + 1).forEach((r, k) => {
    const ip = (r[col.ip] ?? '').trim();
    const amt = parseAmount(r[col.amt]);
    const date = parseDate(r[col.date]);
    if (!ip) return;
    if (!amt || !date) { skipped.push({ line: h + 2 + k, reason: !amt ? 'no amount' : 'no date' }); return; }
    const extra = r.filter((_, i) => i > Math.max(col.rem, col.date)).join(' ').trim();
    out.push({ ip_no: ip, patient_name: (r[col.name] ?? '').trim(), doctor_name: (r[col.doc] ?? '').trim(), amount: amt,
      bill_date: date, care_of: (r[col.rem] ?? '').trim(), note: extra });
  });
  return { rows: out, skipped };
}
