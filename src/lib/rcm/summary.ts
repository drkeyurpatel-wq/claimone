/**
 * The weekly one-pager for the manager, worked out from the same rows as Master.
 * Pure, so it is tested without a database.
 */
import type { LedgerRow } from './ledger';
import type { LeakageRow } from '@/lib/claims/types';
import { DISALLOWANCE_CATEGORIES } from '@/lib/engine/settlement';

const DAY = 86_400_000;
const at = (d: string | null | undefined) => (d ? new Date(d.length === 10 ? `${d}T12:00:00+05:30` : d).getTime() : NaN);
const inLast = (d: string | null | undefined, days: number, now: Date) => {
  const t = at(d);
  return Number.isFinite(t) && t <= now.getTime() && now.getTime() - t < days * DAY;
};

export const BUCKETS = ['0–30 days', '31–60 days', '61–90 days', 'Over 90 days'] as const;
export type Bucket = (typeof BUCKETS)[number];
export const bucketOf = (days: number): Bucket => (days <= 30 ? BUCKETS[0] : days <= 60 ? BUCKETS[1] : days <= 90 ? BUCKETS[2] : BUCKETS[3]);

/** What the payer still owes on an open file: the unpaid balance, else the approval, else the claim. */
export function owedOn(r: LedgerRow): number {
  const { c, money: m } = r.j;
  if (r.next.done) return 0;
  if (m && m.allocated > 0) return Math.max(0, m.balance);
  if (['claim_approved', 'claim_partial', 'settlement_pending'].includes(c.status)) return Number(c.approved_amount ?? 0);
  if (['claim_submitted', 'claim_under_review', 'claim_query'].includes(c.status)) return Number(c.claimed_amount ?? 0);
  return 0;
}

export interface PayerOwed { payer: string; total: number; cases: number; buckets: Record<Bucket, number> }

export function outstandingByPayer(rows: LedgerRow[]): PayerOwed[] {
  const by = new Map<string, PayerOwed>();
  for (const r of rows) {
    const amt = owedOn(r);
    if (amt < 1 || !r.age) continue;
    const payer = r.j.c.clm_payers?.name ?? r.j.c.sponsor_name ?? 'Unknown payer';
    const p = by.get(payer) ?? { payer, total: 0, cases: 0, buckets: { [BUCKETS[0]]: 0, [BUCKETS[1]]: 0, [BUCKETS[2]]: 0, [BUCKETS[3]]: 0 } as Record<Bucket, number> };
    p.total += amt; p.cases += 1; p.buckets[bucketOf(r.age.days)] += amt;
    by.set(payer, p);
  }
  return [...by.values()].sort((a, b) => b.total - a.total);
}

export interface Week { admissions: number; claimsSubmitted: number; claimed: number; approvals: number; approved: number; settled: number; settledNet: number }

/** The last 7 days, from the case dates. Approvals come from the status history when given (a file approved and settled in the same week still counts). */
export function thisWeek(rows: LedgerRow[], now = new Date(), approvals?: { amount: number }[]): Week {
  const w: Week = { admissions: 0, claimsSubmitted: 0, claimed: 0, approvals: 0, approved: 0, settled: 0, settledNet: 0 };
  for (const { j: { c } } of rows) {
    if (inLast(c.admitted_at ?? c.admission_date ?? c.created_at, 7, now)) w.admissions += 1;
    if (inLast(c.submitted_at, 7, now)) { w.claimsSubmitted += 1; w.claimed += Number(c.claimed_amount ?? 0); }
    if (!approvals && ['claim_approved', 'claim_partial', 'settlement_pending'].includes(c.status) && inLast(c.status_changed_at, 7, now)) {
      w.approvals += 1; w.approved += Number(c.approved_amount ?? 0);
    }
    if (c.status === 'settled' && inLast(c.status_changed_at, 7, now)) { w.settled += 1; w.settledNet += Number(c.settled_amount ?? 0); }
  }
  if (approvals) { w.approvals = approvals.length; w.approved = approvals.reduce((s, a) => s + a.amount, 0); }
  return w;
}

export interface Stuck { label: string; cases: number; oldest: string; ours: boolean }

/** Overdue files, grouped by what is overdue. */
export function stuck(rows: LedgerRow[]): Stuck[] {
  const by = new Map<string, Stuck & { worst: number }>();
  for (const r of rows) {
    if (r.next.done || !r.next.late) continue;
    // the money words vary by amount; group on the kind of step
    const label = r.next.text.replace(/₹[\d,]+/g, '₹…').replace(/ sent \d{2} \w{3}/, ' sent');
    const s = by.get(label) ?? { label, cases: 0, oldest: '', ours: r.next.ours, worst: -1 };
    s.cases += 1;
    const d = r.age?.days ?? 0;
    if (d > s.worst) { s.worst = d; s.oldest = `${r.j.c.patient_name}${r.j.c.admission_ref ? ` (${r.j.c.admission_ref})` : ''}`; }
    by.set(label, s);
  }
  return [...by.values()].sort((a, b) => Number(b.ours) - Number(a.ours) || b.cases - a.cases).map(({ worst: _w, ...s }) => s);
}

export interface ReasonGrid { categories: string[]; payers: { payer: string; total: number; by: Record<string, number> }[]; totals: Record<string, number>; total: number }

/** Deductions by reason × payer (amounts), from the leakage view. */
export function deductionGrid(leak: LeakageRow[], sinceMonth?: string): ReasonGrid {
  const rows = leak.filter((l) => l.kind === 'deduction' && (!sinceMonth || l.month >= sinceMonth));
  const label = (k: string) => (DISALLOWANCE_CATEGORIES as Record<string, { label: string }>)[k]?.label ?? k;
  const totals: Record<string, number> = {};
  const byPayer = new Map<string, { payer: string; total: number; by: Record<string, number> }>();
  for (const l of rows) {
    const cat = label(l.category);
    const amt = Number(l.amount);
    totals[cat] = (totals[cat] ?? 0) + amt;
    const p = byPayer.get(l.payer_name) ?? { payer: l.payer_name, total: 0, by: {} };
    p.by[cat] = (p.by[cat] ?? 0) + amt; p.total += amt;
    byPayer.set(l.payer_name, p);
  }
  const categories = Object.keys(totals).sort((a, b) => totals[b] - totals[a]);
  return { categories, payers: [...byPayer.values()].sort((a, b) => b.total - a.total), totals, total: Object.values(totals).reduce((s, x) => s + x, 0) };
}

export interface DisputeCase {
  cut_decision: 'accepted' | 'fought' | null; cut_decided_at: string | null; status: string;
  claimed_amount: number | null; approved_amount: number | null; deduction_amount: number | null;
}
export interface DisputeMonth { month: string; accepted: number; acceptedAmt: number; disputed: number; disputedAmt: number; won: number; recovered: number; open: number }

/** By the month the deduction was decided: accepted, disputed, won (paid in full after the dispute) and ₹ recovered. */
export function disputesByMonth(cases: DisputeCase[], months = 6, now = new Date()): DisputeMonth[] {
  const keys: string[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  const out = new Map(keys.map((k) => [k, { month: k, accepted: 0, acceptedAmt: 0, disputed: 0, disputedAmt: 0, won: 0, recovered: 0, open: 0 }]));
  for (const c of cases) {
    if (!c.cut_decision || !c.cut_decided_at) continue;
    const k = new Date(c.cut_decided_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).slice(0, 7);
    const m = out.get(k);
    if (!m) continue;
    const cut = Math.max(0, Number(c.claimed_amount ?? 0) - Number(c.approved_amount ?? 0));
    if (c.cut_decision === 'accepted') { m.accepted += 1; m.acceptedAmt += Math.max(cut, Number(c.deduction_amount ?? 0)); continue; }
    m.disputed += 1; m.disputedAmt += cut;
    if (c.status === 'settled') {
      // what came back over the original approval
      const rec = Math.max(0, cut - Number(c.deduction_amount ?? 0));
      if (rec >= 1) { m.won += 1; m.recovered += rec; }
    } else m.open += 1;
  }
  return keys.map((k) => out.get(k)!);
}
