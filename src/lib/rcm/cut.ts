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
  /** Dispute letters (0023): 1 reconsideration, 2 escalation to the insurer, 3 patient grievance. */
  letter?: { level: number; sentAt: string } | null;
  /**
   * Paid in parts (PMJAY often): the balance is still expected from the payer, so it is
   * not a deduction yet. It becomes one to accept or dispute PART_WAIT_DAYS after the
   * last part, or when the desk records a decision.
   */
  awaited?: { amount: number; parts: number; lastPaid: string | null; dueAt: Date | null } | null;
}

/** Days after the last part payment before an unpaid balance is treated as a deduction. */
export const PART_WAIT_DAYS = 30;

type CutClaim = Pick<Claim, 'status' | 'claimed_amount' | 'approved_amount'> & {
  cut_decision?: 'accepted' | 'fought' | null; cut_decided_at?: string | null; dispute_level?: number | null; dispute_sent_at?: string | null;
};

const LIVE = new Set(['claim_approved', 'claim_partial', 'settlement_pending', 'settled']);

export function cutOf(c: CutClaim, m: CaseMoney | null, now = new Date()): Cut {
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
  const aw = awaitedOf(c, m, now);
  if (aw) return { amount: Math.max(amount, 0), state: 'pending', needsDecision: false, decidedAt, awaited: aw };
  if (c.cut_decision === 'fought') {
    const letter = c.dispute_level && c.dispute_sent_at ? { level: c.dispute_level, sentAt: c.dispute_sent_at } : null;
    return { amount: Math.max(amount, 0), state: 'fought', needsDecision: false, decidedAt, letter };
  }
  if (amount < 1) return none;
  if (c.cut_decision === 'accepted') return { amount, state: 'accepted', needsDecision: false, decidedAt };
  if (amount < CUT_FLOOR) return { amount, state: 'small', needsDecision: false, decidedAt };
  // a file that was settled before cuts needed a decision can still be fought, but is not waiting
  return { amount, state: 'pending', needsDecision: c.status !== 'settled', decidedAt };
}

/** A balance still expected after a part payment; null once the wait is over or nothing is due. */
export function awaitedOf(c: CutClaim, m: CaseMoney | null, now = new Date()): Cut['awaited'] {
  if (!m || m.allocated <= 0 || m.balance <= 1 || c.status === 'settled' || c.cut_decision === 'fought') return null;
  const lastPaid = m.last_paid ?? null;
  if (!lastPaid) return null;
  const dueAt = lastPaid ? new Date(new Date(`${lastPaid.slice(0, 10)}T00:00:00+05:30`).getTime() + PART_WAIT_DAYS * DAY_MS) : null;
  // a decision recorded after the last part closes the wait (the desk said this is final)
  if (c.cut_decided_at && lastPaid && new Date(c.cut_decided_at) >= new Date(`${lastPaid.slice(0, 10)}T00:00:00+05:30`)) return null;
  if (dueAt && now > dueAt) return null;
  return { amount: Math.round(m.balance * 100) / 100, parts: m.parts ?? 1, lastPaid, dueAt };
}

const rs = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const DAY_MS = 86_400_000;
/** Days to wait for an answer to each letter before the next step. */
export const LETTER_WAIT_DAYS: Record<number, number> = { 1: 15, 2: 15, 3: 30 };
export const LETTERS: Record<number, { title: string; short: string }> = {
  1: { title: 'Reconsideration request to the payer', short: 'Reconsideration' },
  2: { title: 'Escalation to the insurer', short: 'Escalation' },
  3: { title: "Patient's grievance to the insurer", short: 'Patient grievance' },
};
const shortDay = (d: string) => new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' });

/** The worklist line for a file whose cut is waiting or being fought; null when the cut needs nothing. */
export function cutStep(cut: Cut, now = new Date()): { label: string; ours: boolean; dueAt: Date | null; overdue: boolean } | null {
  if (cut.awaited) {
    const a = cut.awaited;
    return { label: `Part-paid (${a.parts} payment${a.parts === 1 ? '' : 's'}) — ${rs(a.amount)} balance awaited from the payer`,
      ours: false, dueAt: a.dueAt, overdue: false };
  }
  if (cut.needsDecision) return { label: `Deduction ${rs(cut.amount)} — accept or dispute`, ours: true, dueAt: null, overdue: false };
  if (cut.state === 'fought' && cut.amount >= 1) {
    const l = cut.letter;
    if (!l) {
      // disputed, but no letter yet: sending it is ours
      const dueAt = cut.decidedAt ? new Date(new Date(cut.decidedAt).getTime() + 2 * DAY_MS) : null;
      return { label: `Disputed ${rs(cut.amount)} — send the reconsideration letter`, ours: true, dueAt, overdue: !!dueAt && now > dueAt };
    }
    const dueAt = new Date(new Date(l.sentAt).getTime() + (LETTER_WAIT_DAYS[l.level] ?? 15) * DAY_MS);
    const late = now > dueAt;
    const label = l.level === 1
      ? (late ? `No reply to reconsideration of ${rs(cut.amount)} — escalate to the insurer` : `Reconsideration of ${rs(cut.amount)} sent ${shortDay(l.sentAt)} — awaiting reply`)
      : l.level === 2
      ? (late ? `No reply to escalation of ${rs(cut.amount)} — patient's grievance or write-off` : `Escalated ${rs(cut.amount)} to the insurer ${shortDay(l.sentAt)} — awaiting reply`)
      : `Patient's grievance on ${rs(cut.amount)} filed ${shortDay(l.sentAt)} — follow up`;
    // no reply in time: the next letter is ours to send
    return { label, ours: late && l.level < 3, dueAt, overdue: late };
  }
  return null;
}
