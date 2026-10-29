/**
 * The insurer's cut on a file, and whether a person must decide on it.
 * The database enforces the same rule (clm_settle_from_receivable, clm_cut_floor):
 * a cut of CUT_FLOOR or more never closes a file until someone presses
 * "Accept the cut"; "Fight it" keeps the cut as money still due.
 */
import type { Claim } from '@/lib/claims/types';
import type { CaseMoney } from './journey';

/** Cuts below this close on their own. SQL copy: clm_cut_floor(). */
export const CUT_FLOOR = 1000;

export type CutState = 'none' | 'small' | 'pending' | 'accepted' | 'fought';
export interface Cut {
  /** Rupees the insurer has not paid (or approved) out of the claim. */
  amount: number;
  state: CutState;
  /** true when the file is waiting for Accept / Fight. */
  needsDecision: boolean;
  /** When the desk decided (fought cuts are chased from here). */
  decidedAt: string | null;
}

type CutClaim = Pick<Claim, 'status' | 'claimed_amount' | 'approved_amount'> & { cut_decision?: 'accepted' | 'fought' | null; cut_decided_at?: string | null };

const LIVE = new Set(['claim_approved', 'claim_partial', 'settlement_pending', 'settled']);

export function cutOf(c: CutClaim, m: CaseMoney | null): Cut {
  const decidedAt = c.cut_decided_at ?? null;
  const none: Cut = { amount: 0, state: 'none', needsDecision: false, decidedAt };
  if (!LIVE.has(c.status)) return none;
  // same order as the database: claim, then the bill, then the approval
  const claimed = Number(c.claimed_amount ?? m?.billed_amount ?? c.approved_amount ?? m?.expected_amount ?? 0);
  let amount: number;
  if (m && m.allocated > 0) amount = claimed - (m.allocated + m.tds);
  else if (c.approved_amount != null) amount = claimed - Number(c.approved_amount);
  else return none;
  amount = Math.round(amount * 100) / 100;
  if (c.cut_decision === 'fought') return { amount: Math.max(amount, 0), state: 'fought', needsDecision: false, decidedAt };
  if (amount < 1) return none;
  if (c.cut_decision === 'accepted') return { amount, state: 'accepted', needsDecision: false, decidedAt };
  if (amount < CUT_FLOOR) return { amount, state: 'small', needsDecision: false, decidedAt };
  // a file that was settled before cuts needed a decision can still be fought, but is not waiting
  return { amount, state: 'pending', needsDecision: c.status !== 'settled', decidedAt };
}

const rs = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const FOLLOW_UP_MS = 15 * 86_400_000;

/** The worklist line for a file whose cut is waiting or being fought; null when the cut needs nothing. */
export function cutStep(cut: Cut, now = new Date()): { label: string; ours: boolean; dueAt: Date | null; overdue: boolean } | null {
  if (cut.needsDecision) return { label: `Deduction ${rs(cut.amount)} — accept or dispute`, ours: true, dueAt: null, overdue: false };
  if (cut.state === 'fought' && cut.amount >= 1) {
    const dueAt = cut.decidedAt ? new Date(new Date(cut.decidedAt).getTime() + FOLLOW_UP_MS) : null;
    return { label: `Disputed deduction ${rs(cut.amount)} — follow up with payer`, ours: false, dueAt, overdue: !!dueAt && now > dueAt };
  }
  return null;
}
