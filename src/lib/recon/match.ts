/**
 * Reconciliation engine: proposes which receipt pays which receivable.
 * Pure function; nothing is saved until a person confirms the proposals
 * (clm_confirm_matches). Evidence, strongest first:
 *   1. advice — the payer's settlement advice names the UTR and the claim
 *   2. utr    — the cashless team recorded this UTR against the bill
 *   3. amount — one open bill from this payer for exactly this amount
 *   4. bulk   — a few open bills from this payer that add up to the receipt
 */

export interface OpenReceivable {
  id: string;
  debtor_name: string;
  payer_id: string | null;
  claim_ref: string | null;
  bill_no: string | null;
  patient_name: string | null;
  bill_date: string;            // YYYY-MM-DD
  balance: number;
  recorded_utr: string | null;
}

export interface OpenReceipt {
  id: string;
  value_date: string;
  unallocated: number;
  reference: string | null;
  narration: string | null;
  payer_id: string | null;
}

export interface AdviceRow {
  id: string;
  utr: string | null;
  claim_ref: string | null;
  bill_no: string | null;
  patient_name: string | null;
  tds_amount: number;
  deduction_amount: number;
  deduction_reason: string | null;
  net_amount: number;
}

export type Method = 'advice' | 'utr' | 'amount' | 'bulk';

export interface Adjustment { kind: 'tds' | 'deduction' | 'rounding'; amount: number; category?: string; reason_text?: string }

export interface Proposal {
  receipt_id: string;
  receivable_id: string;
  amount: number;
  method: Method;
  confidence: 'high' | 'medium';
  remittance_line_id?: string;
  adjustments: Adjustment[];
  /** What is still unexplained on the bill after this match. */
  residual: number;
  note: string;
}

export interface MatchResult {
  proposals: Proposal[];
  ambiguous: { receipt_id: string; candidates: string[] }[];
  unmatchedReceipts: string[];
  unmatchedReceivables: string[];
}

const TOL = 10;                       // rupees
const TDS_RATE = 0.02;                // Section 194J-type TDS seen on Health1's insurer receipts
const MAX_DAYS = 400;

const key = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const r2 = (n: number) => Math.round(n * 100) / 100;
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

const GENERIC = new Set(['THE', 'INSURANCE', 'GENERAL', 'COMPANY', 'CO', 'LTD', 'LIMITED', 'HEALTH', 'OF', 'AND', 'ASSURANCE', 'TPA', 'PVT', 'PRIVATE', 'SERVICES', 'INDIA']);

/** Words in a payer's name that would identify it in a bank narration. */
export function payerTokens(name: string): string[] {
  const words = name.toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(Boolean);
  const sig = words.filter((w) => !GENERIC.has(w) && w.length >= 3);
  if (/NEW INDIA/.test(name.toUpperCase())) return ['NEW INDIA'];
  if (/UNITED INDIA/.test(name.toUpperCase())) return ['UNITED INDIA'];
  return sig.length ? [sig[0]] : words.slice(0, 1);
}

export function narrationMentions(narration: string | null, debtor: string): boolean {
  if (!narration) return false;
  // whole words only: "HDFC" must not match inside a bank reference like HDFCH01055116215
  const n = ` ${narration.toUpperCase().replace(/[^A-Z]+/g, ' ')} `;
  return payerTokens(debtor).some((t) => n.includes(` ${t} `));
}

/** Classify a short payment the way the reconciliation report does. */
export function classifyShort(approved: number, received: number): 'exact' | 'over' | 'tds' | 'part' | 'deduction' {
  const short = approved - received;
  if (Math.abs(short) <= TOL) return 'exact';
  if (short < 0) return 'over';
  const pct = approved ? short / approved : 0;
  if (pct >= 0.017 && pct <= 0.023) return 'tds';
  if (pct > 0.4) return 'part';
  return 'deduction';
}

function explain(balanceBefore: number, paid: number): { adjustments: Adjustment[]; residual: number; note: string } {
  const short = r2(balanceBefore - paid);
  const c = classifyShort(balanceBefore, paid);
  if (c === 'exact') return { adjustments: short > 0 ? [{ kind: 'rounding', amount: short }] : [], residual: 0, note: 'Paid in full' };
  if (c === 'tds') return { adjustments: [{ kind: 'tds', amount: short }], residual: 0, note: `Short ₹${short.toLocaleString('en-IN')} treated as 2% TDS` };
  if (c === 'over') return { adjustments: [], residual: short, note: `Received ₹${(-short).toLocaleString('en-IN')} more than owed — check for a refund` };
  return { adjustments: [], residual: short, note: `₹${short.toLocaleString('en-IN')} still unexplained — get the settlement letter` };
}

export function proposeMatches(receivables: OpenReceivable[], receipts: OpenReceipt[], advice: AdviceRow[] = []): MatchResult {
  const bal = new Map(receivables.map((r) => [r.id, r2(r.balance)]));
  const left = new Map(receipts.map((r) => [r.id, r2(r.unallocated)]));
  const proposals: Proposal[] = [];
  const ambiguous: MatchResult['ambiguous'] = [];
  const byClaim = new Map<string, OpenReceivable>();
  const byBill = new Map<string, OpenReceivable>();
  for (const r of receivables) {
    if (r.claim_ref) byClaim.set(key(r.claim_ref), r);
    if (r.bill_no) byBill.set(key(r.bill_no), r);
  }
  const receiptByRef = new Map<string, OpenReceipt>();
  for (const rc of receipts) if (rc.reference) receiptByRef.set(key(rc.reference), rc);

  const take = (rc: OpenReceipt, rv: OpenReceivable, method: Method, confidence: 'high' | 'medium', amount?: number, extra?: Partial<Proposal>) => {
    const before = bal.get(rv.id) ?? 0;
    const avail = left.get(rc.id) ?? 0;
    const amt = r2(Math.min(amount ?? before, avail));
    if (amt <= 0) return false;
    const ex = extra?.adjustments ? { adjustments: extra.adjustments, residual: r2(before - amt - extra.adjustments.reduce((s, a) => s + a.amount, 0)), note: extra.note ?? '' } : explain(before, amt);
    proposals.push({ receipt_id: rc.id, receivable_id: rv.id, amount: amt, method, confidence, ...extra, ...ex });
    bal.set(rv.id, r2(before - amt - ex.adjustments.reduce((s, a) => s + a.amount, 0)));
    left.set(rc.id, r2(avail - amt));
    return true;
  };

  // 1. Settlement advice lines
  for (const a of advice) {
    const rc = a.utr ? receiptByRef.get(key(a.utr)) ?? receipts.find((x) => key(x.narration).includes(key(a.utr))) : undefined;
    const rv = (a.claim_ref && byClaim.get(key(a.claim_ref))) || (a.bill_no && byBill.get(key(a.bill_no))) || undefined;
    if (!rc || !rv || (left.get(rc.id) ?? 0) <= 0 || (bal.get(rv.id) ?? 0) <= 0) continue;
    const adjustments: Adjustment[] = [];
    if (a.tds_amount > 0) adjustments.push({ kind: 'tds', amount: r2(a.tds_amount) });
    if (a.deduction_amount > 0) adjustments.push({ kind: 'deduction', amount: r2(a.deduction_amount), category: 'other', reason_text: a.deduction_reason || 'Per payer settlement advice' });
    take(rc, rv, 'advice', 'high', a.net_amount, { remittance_line_id: a.id, adjustments, note: 'Matched on settlement advice' });
  }

  // 2. UTR recorded against the bill (bulk payments share one UTR)
  const byUtr = new Map<string, OpenReceivable[]>();
  for (const r of receivables) if (r.recorded_utr) byUtr.set(key(r.recorded_utr), [...(byUtr.get(key(r.recorded_utr)) ?? []), r]);
  for (const rc of receipts) {
    if (!rc.reference) continue;
    const list = (byUtr.get(key(rc.reference)) ?? []).filter((r) => (bal.get(r.id) ?? 0) > 0)
      .sort((a, b) => a.bill_date.localeCompare(b.bill_date));
    if (list.length === 1) take(rc, list[0], 'utr', 'high');
    else if (list.length > 1) {
      const total = list.reduce((s, r) => s + (bal.get(r.id) ?? 0), 0);
      const conf = Math.abs(total - (left.get(rc.id) ?? 0)) <= TOL ? 'high' : 'medium';
      // the bulk receipt covers these bills: pay each in full while money lasts
      for (const r of list) {
        if ((left.get(rc.id) ?? 0) <= 0) break;
        take(rc, r, 'utr', conf);
      }
    }
  }

  // 3 + 4. Amount within the same payer
  const eligible = (rc: OpenReceipt) => receivables.filter((r) => {
    const b = bal.get(r.id) ?? 0;
    if (b <= 0) return false;
    const d = days(r.bill_date, rc.value_date);
    if (d < 0 || d > MAX_DAYS) return false;
    return rc.payer_id ? r.payer_id === rc.payer_id : narrationMentions(rc.narration, r.debtor_name);
  });
  const fits = (want: number, owed: number) => Math.abs(owed - want) <= TOL || Math.abs(owed * (1 - TDS_RATE) - want) <= TOL;

  for (const rc of receipts) {
    const amt = left.get(rc.id) ?? 0;
    if (amt <= TOL) continue;
    const cands = eligible(rc);
    const single = cands.filter((r) => fits(amt, bal.get(r.id) ?? 0));
    if (single.length === 1) { take(rc, single[0], 'amount', 'medium'); continue; }
    if (single.length > 1) { ambiguous.push({ receipt_id: rc.id, candidates: single.map((r) => r.id) }); continue; }
    const pool = cands.sort((a, b) => a.bill_date.localeCompare(b.bill_date)).slice(0, 18);
    const combo = subsetSum(pool.map((r) => bal.get(r.id) ?? 0), amt);
    if (combo) for (const i of combo) take(rc, pool[i], 'bulk', 'medium');
  }

  const used = new Set(proposals.map((p) => p.receipt_id));
  const paidBills = new Set(proposals.map((p) => p.receivable_id));
  return {
    proposals,
    ambiguous,
    unmatchedReceipts: receipts.filter((r) => !used.has(r.id) && !ambiguous.some((a) => a.receipt_id === r.id)).map((r) => r.id),
    unmatchedReceivables: receivables.filter((r) => !paidBills.has(r.id)).map((r) => r.id),
  };
}

/** Smallest set of 2–6 balances summing to the target (in full, or net of 2% TDS). */
export function subsetSum(values: number[], target: number): number[] | null {
  const n = values.length;
  let found: number[] | null = null;
  const walk = (start: number, picked: number[], sum: number) => {
    if (found) return;
    if (picked.length >= 2 && (Math.abs(sum - target) <= TOL || Math.abs(sum * (1 - TDS_RATE) - target) <= TOL)) { found = [...picked]; return; }
    if (picked.length === 6 || sum - target > TOL) return;
    for (let i = start; i < n; i++) { picked.push(i); walk(i + 1, picked, sum + values[i]); picked.pop(); if (found) return; }
  };
  walk(0, [], 0);
  return found;
}
