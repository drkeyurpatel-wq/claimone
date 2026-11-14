/**
 * Kotak account statement (the PDF from net banking): "# · Date · Description · Chq/Ref. No. · Withdrawal (Dr.) ·
 * Deposit (Cr.) · Balance". Read from the PDF's own text — no AI. Each row shows one amount and the new balance;
 * whether it came in or went out is taken from how the balance moved, so every row is checked against the balance.
 */
import type { PdfItem } from './pdftext';
import { pdfLines } from './pdftext';
import { extractReference, type BankLine } from './parse';

export interface StatementRow { n: number; date: string; description: string; ref: string | null; withdrawal: number; deposit: number; balance: number }
export interface Statement {
  bank: 'Kotak'; account: string | null; from: string | null; to: string | null;
  opening: number | null; closing: number | null; rows: StatementRow[];
  /** Every row's amount explains the move from the balance before it. */
  ties: boolean;
}

const MON: Record<string, string> = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
const AMOUNT = /^-?[\d,]+\.\d{2}$/;
const num = (s: string) => Number(s.replace(/,/g, ''));
const isoDate = (s: string): string | null => {
  const m = /^(\d{2}) ([A-Za-z]{3}) (\d{4})$/.exec(s.trim());
  return m && MON[m[2].toUpperCase()] ? `${m[3]}-${MON[m[2].toUpperCase()]}-${m[1]}` : null;
};

export function isKotakStatement(items: PdfItem[]): boolean {
  const text = items.slice(0, 400).map((i) => i.str).join(' ');
  return /Account Statement/i.test(text) && /Withdrawal \(Dr\.\)/i.test(text) && /Deposit \(Cr\.\)/i.test(text);
}

export function parseKotakStatement(items: PdfItem[]): Statement {
  const lines = pdfLines(items);
  const all = items.map((i) => i.str).join(' ');
  const account = /Account No\.?\s*(\d{6,})/.exec(all)?.[1] ?? null;
  const period = /(\d{2} [A-Za-z]{3} \d{4})\s*-\s*(\d{2} [A-Za-z]{3} \d{4})/.exec(all);
  const st: Statement = { bank: 'Kotak', account, from: period ? isoDate(period[1]) : null, to: period ? isoDate(period[2]) : null,
    opening: null, closing: null, rows: [], ties: false };

  // column starts, from the header row of each page: text left of "Chq/Ref. No." is the description
  let refX = Infinity; let amtX = Infinity; let descX = 0;
  let cur: StatementRow | null = null;
  for (const line of lines) {
    const words = line.map((i) => i.str.trim());
    const joined = words.join(' ');
    const head = line.find((i) => /^Chq\/Ref/i.test(i.str.trim()));
    if (head && /Description/i.test(joined)) {
      // the figures under a heading start a few points to its left
      refX = head.x - 10;
      amtX = (line.find((i) => /^Withdrawal/i.test(i.str.trim()))?.x ?? Infinity) - 10;
      descX = (line.find((i) => /^Description/i.test(i.str.trim()))?.x ?? 0) - 10;
      cur = null; continue;
    }
    if (/Opening Balance/i.test(joined)) {
      const a = words.filter((w) => AMOUNT.test(w)); if (a.length) st.opening = num(a[a.length - 1]);
      continue;
    }
    if (/^(Statement Generated|Page \d+ of|Account Summary|Closing Balance|End of Statement)/i.test(joined) || /Statement Generated on/i.test(joined)) { cur = null; continue; }

    // a row starts with its running number and a date
    const pieces = line.flatMap((i) => i.str.trim().split(/\s{2,}/).map((s) => ({ x: i.x, s: s.trim() }))).filter((p) => p.s);
    const first = pieces[0]?.s ?? '';
    const startM = /^(\d+)(?:\s+(\d{2} [A-Za-z]{3} \d{4}))?(?:\s+(.*))?$/.exec(first);
    let date: string | null = null; let rest = pieces.slice(1); let seq = 0;
    if (startM && /^\d+$/.test(startM[1])) {
      seq = Number(startM[1]);
      if (startM[2]) { date = isoDate(startM[2]); if (startM[3]) rest = [{ x: descX + 3, s: startM[3] }, ...rest]; }
      else if (rest[0] && isoDate(rest[0].s.slice(0, 11))) {
        date = isoDate(rest[0].s.slice(0, 11));
        const tail = rest[0].s.slice(11).trim();
        rest = tail ? [{ x: descX + 3, s: tail }, ...rest.slice(1)] : rest.slice(1);
      }
    }
    const amounts = rest.filter((p) => AMOUNT.test(p.s) && p.x >= amtX - 40);
    if (date && amounts.length >= 2) {
      const balance = num(amounts[amounts.length - 1].s); const amt = num(amounts[amounts.length - 2].s);
      const text = rest.filter((p) => !amounts.includes(p));
      const description = text.filter((p) => p.x < refX).map((p) => p.s).join(' ');
      const ref = text.filter((p) => p.x >= refX).map((p) => p.s).join(' ') || null;
      cur = { n: seq, date, description, ref, withdrawal: 0, deposit: amt, balance };
      st.rows.push(cur);
    } else if (cur && pieces.length && pieces.every((p) => p.x >= descX && p.x < amtX) && !AMOUNT.test(first)) {
      // the description (and sometimes the ref) runs on to the next line
      const d = pieces.filter((p) => p.x < refX).map((p) => p.s).join(' ');
      const r = pieces.filter((p) => p.x >= refX).map((p) => p.s).join(' ');
      if (d) cur.description = `${cur.description} ${d}`.trim();
      if (r) cur.ref = `${cur.ref ?? ''}${r}`;
    }
  }

  // in or out: by how the balance moved
  let prev = st.opening; let ok = st.rows.length > 0;
  for (const r of st.rows) {
    const amt = r.deposit;
    if (prev == null) { prev = r.balance; continue; }
    const diff = Math.round((r.balance - prev) * 100) / 100;
    if (Math.abs(diff - amt) < 0.011) { r.deposit = amt; r.withdrawal = 0; }
    else if (Math.abs(diff + amt) < 0.011) { r.deposit = 0; r.withdrawal = amt; }
    else { ok = false; r.deposit = diff > 0 ? amt : 0; r.withdrawal = diff > 0 ? 0 : amt; }
    prev = r.balance;
  }
  st.closing = st.rows.length ? st.rows[st.rows.length - 1].balance : st.opening;
  st.ties = ok && st.opening != null && st.rows.every((r, i) => r.n === i + 1);
  return st;
}

/** The money that came in, as the bank lines ClaimOne stores (UTR taken from the narration). */
export function statementCredits(st: Statement): BankLine[] {
  return st.rows.filter((r) => r.deposit > 0).map((r) => ({
    value_date: r.date, amount: r.deposit, narration: r.description.slice(0, 300), reference: extractReference(r.description) ?? r.ref }));
}

// Who pays claims: insurers, TPAs and government schemes. Cash, card and UPI settlements, transfers between the
// hospital's own accounts, loans and personal transfers are not claim money and stay out of the claims desk's lists.
const PAYER = /INSUR|BAJAJ GENERAL|ASSURANCE|\bTPA\b|ERGO|LOMBARD|MEDI ?ASSIST|PARAMOUNT|VIDAL|RAKSHA|MD ?INDIA|FHPL|FAMILY HEALTH|HERITAGE HEALTH|GENINS|ERICSON|GOOD HEALTH|SAFEWAY|VIPUL MED|HEALTH INDIA|STAR HEALTH|CARE HEALTH|NIVA BUPA|MANIPAL ?CIGNA|ADITYA BIRLA|ABHICL|GO DIGIT|SOMPO|IFFCO|TATA AIG|CHOLAMANDALAM|ROYAL SUNDARAM|LIBERTY GENERAL|MAGMA|ACKO|\bESIC?\b|\bECHS\b|\bCGHS\b|AYUSHMAN|PMJAY|SWASTHYA BIMA|STATE HEALTH|GENERALI|ZUNO|ZURICH|INDUSIND GENERAL|MEDSAVE|EAST WEST ASSIST|PARK MEDICLAIM|UNITED HEALTH|AWP HEALTH|PAY AND ACCOUNT|\bPCDA\b|TREASURY OFFICE/i;

export const isPayerCredit = (narration: string) => PAYER.test(narration);

/**
 * Of a statement's credits, the ones the claims desk works with:
 *  - any credit whose UTR is already on a payment in ClaimOne — it verifies that payment (the blue tick);
 *  - money from an insurer / TPA / government payer dated on or after `from` (the day the desk's files start) —
 *    if no payment is recorded for it yet, it shows on "To check".
 * Older payer money with no payment in ClaimOne belongs to bills ClaimOne does not hold, so it is counted, not saved.
 */
export function claimCredits(credits: BankLine[], knownRefs: Set<string>, from: string): {
  keep: BankLine[]; confirms: number; confirmsAmount: number; older: number; olderAmount: number; other: number; otherAmount: number;
} {
  const out = { keep: [] as BankLine[], confirms: 0, confirmsAmount: 0, older: 0, olderAmount: 0, other: 0, otherAmount: 0 };
  for (const c of credits) {
    if (c.reference && knownRefs.has(c.reference.toUpperCase())) { out.keep.push(c); out.confirms += 1; out.confirmsAmount += c.amount; }
    else if (!isPayerCredit(c.narration)) { out.other += 1; out.otherAmount += c.amount; }
    else if (c.value_date >= from) out.keep.push(c);
    else { out.older += 1; out.olderAmount += c.amount; }
  }
  return out;
}
