/**
 * What is still to come from PMJAY: bills waiting for money, plus claims submitted on TMS that are not paid yet
 * (their bill only goes on the book once the claim is decided). Read before and after the weekly TMS sheet is
 * saved, so the upload can say what it cleared and what is still pending.
 */
import { sb } from '@/lib/supabase/browser';
import { allRows } from '@/lib/supabase/pages';

export interface PmjayPending {
  /** Bills with money still owed, and that money. */
  bills: number; billAmount: number;
  /** Claims submitted and not decided yet, and what was claimed. */
  waiting: number; waitingAmount: number;
  /** PMJAY files closed (Archive). */
  closed: number;
}

export async function pmjayPending(centreId: string): Promise<PmjayPending> {
  const [bills, claims, closed] = await Promise.all([
    allRows<{ balance: number }>((f, t) => sb().from('clm_v_receivable_balance').select('balance')
      .eq('centre_id', centreId).eq('debtor_type', 'government').gt('balance', 1).order('id').range(f, t)),
    allRows<{ claimed_amount: number | null; package_amount: number | null }>((f, t) => sb().from('clm_claims').select('claimed_amount, package_amount')
      .eq('centre_id', centreId).eq('claim_type', 'pmjay').eq('status', 'claim_submitted').order('id').range(f, t)),
    sb().from('clm_claims').select('id', { count: 'exact', head: true }).eq('centre_id', centreId).eq('claim_type', 'pmjay').in('status', ['settled', 'closed']),
  ]);
  if (bills.error || claims.error || closed.error) throw new Error('Could not read what is pending');
  const B = bills.data ?? []; const C = claims.data ?? [];
  return {
    bills: B.length, billAmount: B.reduce((s, b) => s + Number(b.balance ?? 0), 0),
    waiting: C.length, waitingAmount: C.reduce((s, c) => s + Number(c.claimed_amount ?? c.package_amount ?? 0), 0),
    closed: closed.count ?? 0,
  };
}

export interface TmsOutcome {
  billsBefore: number; billsAfter: number; amountBefore: number; amountAfter: number;
  /** Master files this upload closed. */
  archived: number;
  /** Everything still to come: pending bills + submitted claims. */
  pendingFiles: number; pendingAmount: number;
  waiting: number; waitingAmount: number;
}

/** Before and after one TMS upload → what it cleared and what is still pending. */
export function tmsOutcome(before: PmjayPending, after: PmjayPending): TmsOutcome {
  return {
    billsBefore: before.bills, billsAfter: after.bills, amountBefore: before.billAmount, amountAfter: after.billAmount,
    archived: Math.max(0, after.closed - before.closed),
    pendingFiles: after.bills + after.waiting, pendingAmount: after.billAmount + after.waitingAmount,
    waiting: after.waiting, waitingAmount: after.waitingAmount,
  };
}
