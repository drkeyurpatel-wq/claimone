/**
 * The manager's one page: money owed and how old, what is stuck where,
 * what we lost in deductions and why, how fast payers answer, and what came in.
 * Pure aggregation over rows already read through RLS.
 */
import type { Step } from './worklist';

export type Category = 'Insurance / TPA' | 'PMJAY / MA' | 'CGHS / ECHS / ESIC' | 'Corporate' | 'Patient dues';
export const CATEGORIES: Category[] = ['Insurance / TPA', 'PMJAY / MA', 'CGHS / ECHS / ESIC', 'Corporate', 'Patient dues'];
export const BUCKETS = ['0–30', '31–60', '61–90', '91–180', '180+'] as const;
export type Bucket = (typeof BUCKETS)[number];

export interface OpenBill {
  debtor_type: string; payer_id: string | null; debtor_name: string; doctor_name: string | null;
  balance: number; age_days: number; billed_amount: number | null; expected_amount: number; deduction: number;
  recon_status: string; status: string;
}
export interface PayerInfo { id: string; code: string; name: string }
export interface DeductionAdj { category: string | null; amount: number; created_at: string }
export interface ReceiptLite { value_date: string; amount: number; source: string; bank_receipt_id?: string | null }
export interface TransitionLite { claim_id: string; from_status: string | null; to_status: string; created_at: string }

export function categoryOf(b: Pick<OpenBill, 'debtor_type' | 'payer_id'>, payers: Map<string, PayerInfo>): Category {
  if (b.debtor_type === 'patient' || b.debtor_type === 'referrer') return 'Patient dues';
  if (b.debtor_type === 'corporate') return 'Corporate';
  if (b.debtor_type === 'government') return payers.get(b.payer_id ?? '')?.code.startsWith('pmjay') ? 'PMJAY / MA' : 'CGHS / ECHS / ESIC';
  return 'Insurance / TPA';
}

export function bucketOf(age: number): Bucket {
  return age <= 30 ? '0–30' : age <= 60 ? '31–60' : age <= 90 ? '61–90' : age <= 180 ? '91–180' : '180+';
}

const r0 = (n: number) => Math.round(n);

export interface Ageing {
  total: number; count: number; over90: number;
  byCategory: { category: Category; total: number; buckets: Record<Bucket, number> }[];
  byPayer: { name: string; total: number; over90: number; count: number }[];
}

/** Open money only: bills with a balance still due (over-received and settled bills are left out). */
export function ageing(bills: OpenBill[], payers: Map<string, PayerInfo>): Ageing {
  const open = bills.filter((b) => b.status !== 'closed' && b.balance > 1);
  const cat = new Map<Category, { total: number; buckets: Record<Bucket, number> }>();
  for (const c of CATEGORIES) cat.set(c, { total: 0, buckets: Object.fromEntries(BUCKETS.map((k) => [k, 0])) as Record<Bucket, number> });
  const payer = new Map<string, { total: number; over90: number; count: number }>();
  for (const b of open) {
    const c = cat.get(categoryOf(b, payers))!;
    c.total += b.balance; c.buckets[bucketOf(b.age_days)] += b.balance;
    const name = payers.get(b.payer_id ?? '')?.name ?? b.debtor_name;
    const p = payer.get(name) ?? { total: 0, over90: 0, count: 0 };
    p.total += b.balance; p.count++; if (b.age_days > 90) p.over90 += b.balance;
    payer.set(name, p);
  }
  return {
    total: r0(open.reduce((s, b) => s + b.balance, 0)),
    count: open.length,
    over90: r0(open.filter((b) => b.age_days > 90).reduce((s, b) => s + b.balance, 0)),
    byCategory: CATEGORIES.map((category) => {
      const c = cat.get(category)!;
      return { category, total: r0(c.total), buckets: Object.fromEntries(BUCKETS.map((k) => [k, r0(c.buckets[k])])) as Record<Bucket, number> };
    }).filter((c) => c.total > 0),
    byPayer: [...payer].map(([name, v]) => ({ name, total: r0(v.total), over90: r0(v.over90), count: v.count }))
      .sort((a, b) => b.total - a.total),
  };
}

export interface Pipeline { admission: { todo: number; late: number; waiting: number }; claims: { todo: number; late: number; waiting: number }; payment: { count: number; late: number } }

export function pipeline(steps: Step[]): Pipeline {
  const desk = (d: 'admission' | 'claims') => {
    const s = steps.filter((x) => x.desk === d);
    return { todo: s.filter((x) => x.ours).length, late: s.filter((x) => x.overdue).length, waiting: s.filter((x) => !x.ours).length };
  };
  const pay = steps.filter((x) => x.desk === 'payment');
  return { admission: desk('admission'), claims: desk('claims'), payment: { count: pay.length, late: pay.filter((x) => x.overdue).length } };
}

/** Category codes from clm_deduction_category() (0007). */
export const DEDUCTION_WORDS: Record<string, string> = {
  room_rent_cap: 'Room rent limit', co_pay: 'Co-pay', non_payable: 'Consumables / not payable', policy_exclusion: 'Policy exclusion',
  pre_existing: 'Pre-existing disease', query_tat: 'Query not answered in time', tariff_excess: 'Above package / tariff', doc_missing: 'Papers missing', other: 'Other',
  unknown: 'No reason given',
};

/** Money lost to deductions, from the leakage view (approval cuts, short payments, itemised lines). */
export interface LeakLite { kind: string; category: string | null; doctor_name: string; amount: number }
export function deductions(rows: LeakLite[]) {
  const byReason = new Map<string, number>();
  const byDoctor = new Map<string, number>();
  let fighting = 0;
  for (const r of rows) {
    if (r.kind === 'fighting') { fighting += r.amount; continue; }
    if (r.kind !== 'deduction') continue;
    byReason.set(r.category ?? 'unknown', (byReason.get(r.category ?? 'unknown') ?? 0) + r.amount);
    const d = !r.doctor_name || r.doctor_name === '—' ? 'Not recorded' : r.doctor_name;
    byDoctor.set(d, (byDoctor.get(d) ?? 0) + r.amount);
  }
  const total = [...byReason.values()].reduce((s, x) => s + x, 0);
  return {
    total: r0(total),
    /** Cuts the desk is fighting: not lost yet. */
    fighting: r0(fighting),
    byReason: [...byReason].map(([k, v]) => ({ reason: DEDUCTION_WORDS[k] ?? k, amount: r0(v) })).sort((a, b) => b.amount - a.amount),
    byDoctor: [...byDoctor].map(([doctor, amount]) => ({ doctor, amount: r0(amount) })).sort((a, b) => b.amount - a.amount).slice(0, 10),
  };
}

/** Collections by month (bank credits and payment advices). Months as YYYY-MM, oldest first. */
export function collections(receipts: ReceiptLite[], months = 6, now = new Date()) {
  const keys: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    keys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  const m = new Map(keys.map((k) => [k, 0]));
  // a payment letter tied to its bank credit is the same money: count the bank credit only
  for (const r of receipts) {
    if (r.source === 'advice' && r.bank_receipt_id) continue;
    const k = r.value_date.slice(0, 7);
    if (m.has(k)) m.set(k, m.get(k)! + r.amount);
  }
  return keys.map((month) => ({ month, amount: r0(m.get(month)!) }));
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** Turnaround: hours from pre-auth sent to the payer's first answer; days from claim sent to decision. */
export function turnaround(rows: TransitionLite[]) {
  const by = new Map<string, TransitionLite[]>();
  for (const r of rows) (by.get(r.claim_id) ?? by.set(r.claim_id, []).get(r.claim_id)!).push(r);
  const pre: number[] = [], claim: number[] = [];
  for (const list of by.values()) {
    list.sort((a, b) => a.created_at.localeCompare(b.created_at));
    let sentPre: number | null = null, sentClaim: number | null = null;
    for (const r of list) {
      const t = new Date(r.created_at).getTime();
      if (r.to_status === 'preauth_pending') sentPre = t;
      else if (sentPre != null && ['preauth_approved', 'preauth_query', 'preauth_rejected'].includes(r.to_status)) { pre.push((t - sentPre) / 3_600_000); sentPre = null; }
      if (r.to_status === 'claim_submitted') sentClaim = t;
      else if (sentClaim != null && ['claim_approved', 'claim_partial', 'claim_query', 'claim_rejected'].includes(r.to_status)) { claim.push((t - sentClaim) / 86_400_000); sentClaim = null; }
    }
  }
  const one = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);
  return { preauthHours: one(median(pre)), preauthCount: pre.length, claimDays: one(median(claim)), claimCount: claim.length };
}
