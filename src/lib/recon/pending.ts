/**
 * What an upload cleared and what is still pending.
 * A picture of everything insurers still owe is taken before and after a payment file is saved; the difference is
 * what the file did, and the "after" picture — split by where each file stands — is what is left to chase.
 * "Pending" = bills with money still owed + claims submitted and not decided yet (their bill only goes on the book
 * once the claim is decided, so the bills alone understate it).
 */
import { sb } from '@/lib/supabase/browser';
import { allRows } from '@/lib/supabase/pages';

export interface PendingBill {
  payer: string; payer_name: string; balance: number; bill_date: string | null;
  disputed: boolean; onMaster: boolean; partPaid: boolean;
}
export interface PendingClaim { payer: string; amount: number; discharged: string | null }
export interface Snapshot { bills: PendingBill[]; claims: PendingClaim[]; closed: number; payerNames: Record<string, string> }

/** Days after discharge by which an insurer has normally paid; beyond it the claim needs chasing. */
export const CHASE_AFTER_DAYS = 30;

export async function takeSnapshot(centreId: string): Promise<Snapshot> {
  const [bills, claims, closed, payers] = await Promise.all([
    allRows<Record<string, unknown>>((f, t) => sb().from('clm_v_receivable_balance')
      .select('payer_id, debtor_name, balance, bill_date, status, claim_id, allocated')
      .eq('centre_id', centreId).neq('debtor_type', 'patient').gt('balance', 1).order('id').range(f, t)),
    allRows<Record<string, unknown>>((f, t) => sb().from('clm_claims').select('payer_id, claimed_amount, package_amount, discharge_date')
      .eq('centre_id', centreId).eq('status', 'claim_submitted').order('id').range(f, t)),
    sb().from('clm_claims').select('id', { count: 'exact', head: true }).eq('centre_id', centreId).in('status', ['settled', 'closed']),
    sb().from('clm_payers').select('id, name').limit(2000),
  ]);
  if (bills.error || claims.error || closed.error) throw new Error('Could not read what is pending');
  const payerNames: Record<string, string> = {};
  for (const p of (payers.data ?? []) as { id: string; name: string }[]) payerNames[p.id] = p.name;
  return {
    bills: (bills.data ?? []).map((b) => {
      const payer = String(b.payer_id ?? b.debtor_name ?? 'unknown');
      if (b.debtor_name && !payerNames[payer]) payerNames[payer] = String(b.debtor_name);
      return { payer, payer_name: String(b.debtor_name ?? payerNames[payer] ?? 'Unknown payer'), balance: Number(b.balance ?? 0),
        bill_date: (b.bill_date as string) ?? null, disputed: b.status === 'disputed', onMaster: !!b.claim_id, partPaid: Number(b.allocated ?? 0) > 0 };
    }),
    claims: (claims.data ?? []).map((c) => ({ payer: String(c.payer_id ?? 'unknown'), amount: Number(c.claimed_amount ?? c.package_amount ?? 0),
      discharged: (c.discharge_date as string) ?? null })),
    closed: closed.count ?? 0, payerNames,
  };
}

export interface Bucket { files: number; amount: number }
export interface PayerChange { payer: string; name: string; billsBefore: number; billsAfter: number; amountBefore: number; amountAfter: number }
export interface Outcome {
  /** Payers whose pending bills this upload changed, biggest change first. Empty: the file changed nothing. */
  changed: PayerChange[];
  billsBefore: number; billsAfter: number; amountBefore: number; amountAfter: number;
  /** Master files this upload closed (now in Archive). */
  archived: number;
  /** What is still pending for those payers, by where each file stands. */
  awaited: Bucket;      // bill on Master, claim decided, money not in yet
  submitted: Bucket;    // claim submitted, not decided or paid yet
  chase: Bucket;        // … of those, discharged more than CHASE_AFTER_DAYS ago
  disputed: Bucket;     // deduction being disputed
  old: Bucket;          // older bills not on Master, unpaid or part-paid
  total: Bucket;
}

const add = (b: Bucket, amount: number) => { b.files += 1; b.amount += amount; };
const daysAgo = (d: string | null, now: Date) => (d ? Math.floor((now.getTime() - new Date(`${d}T12:00:00+05:30`).getTime()) / 86_400_000) : null);

/**
 * Before and after one upload → what it cleared and what is left.
 * `fallbackPayers`: when nothing changed (a repeat upload), still report on these payers (e.g. the PMJAY payer for a TMS sheet).
 */
export function outcome(before: Snapshot, after: Snapshot, now = new Date(), fallbackPayers: string[] = []): Outcome {
  const tally = (s: Snapshot) => {
    const m = new Map<string, { n: number; amt: number }>();
    for (const b of s.bills) { const v = m.get(b.payer) ?? { n: 0, amt: 0 }; v.n += 1; v.amt += b.balance; m.set(b.payer, v); }
    return m;
  };
  const tb = tally(before); const ta = tally(after);
  const names = { ...before.payerNames, ...after.payerNames };
  const changed: PayerChange[] = [];
  for (const payer of new Set([...tb.keys(), ...ta.keys()])) {
    const b = tb.get(payer) ?? { n: 0, amt: 0 }; const a = ta.get(payer) ?? { n: 0, amt: 0 };
    if (b.n !== a.n || Math.abs(b.amt - a.amt) > 1) {
      changed.push({ payer, name: names[payer] ?? 'Unknown payer', billsBefore: b.n, billsAfter: a.n, amountBefore: b.amt, amountAfter: a.amt });
    }
  }
  changed.sort((x, y) => Math.abs(y.amountBefore - y.amountAfter) - Math.abs(x.amountBefore - x.amountAfter));
  const scope = new Set(changed.length ? changed.map((c) => c.payer) : fallbackPayers);
  const inScope = (p: string) => scope.size === 0 || scope.has(p);

  const o: Outcome = {
    changed, billsBefore: 0, billsAfter: 0, amountBefore: 0, amountAfter: 0, archived: Math.max(0, after.closed - before.closed),
    awaited: { files: 0, amount: 0 }, submitted: { files: 0, amount: 0 }, chase: { files: 0, amount: 0 },
    disputed: { files: 0, amount: 0 }, old: { files: 0, amount: 0 }, total: { files: 0, amount: 0 },
  };
  for (const b of before.bills) if (inScope(b.payer)) { o.billsBefore += 1; o.amountBefore += b.balance; }
  for (const b of after.bills) {
    if (!inScope(b.payer)) continue;
    o.billsAfter += 1; o.amountAfter += b.balance;
    add(b.disputed ? o.disputed : b.onMaster ? o.awaited : o.old, b.balance);
    add(o.total, b.balance);
  }
  for (const c of after.claims) {
    if (!inScope(c.payer)) continue;
    add(o.submitted, c.amount); add(o.total, c.amount);
    const d = daysAgo(c.discharged, now);
    if (d != null && d > CHASE_AFTER_DAYS) add(o.chase, c.amount);
  }
  return o;
}
