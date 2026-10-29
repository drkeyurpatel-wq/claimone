/**
 * What each case needs next, in plain words, and whose desk it sits on.
 * Pure: the database still decides every status change (clm_claims_before_update);
 * this only sorts cases into the admission desk, claims desk and payments.
 */
import type { ClaimStatus, ClaimType } from '@/lib/claims/types';

export type Desk = 'admission' | 'claims' | 'payment' | 'done';
export type StepKey =
  | 'send_preauth' | 'wait_preauth' | 'answer_preauth_query' | 'preauth_rejected' | 'in_hospital_approved'
  | 'send_claim' | 'wait_claim' | 'answer_claim_query' | 'claim_rejected' | 'wait_payment' | 'done';

export interface CaseLike {
  status: ClaimStatus;
  claim_type: ClaimType;
  admitted_at?: string | null;
  admission_date?: string | null;
  discharged_at?: string | null;
  discharge_date?: string | null;
  preauth_submitted_at?: string | null;
  submitted_at?: string | null;
  updated_at: string;
  /** When the status last changed (0017); due clocks run from here, not from any edit. */
  status_changed_at?: string | null;
  created_at: string;
  estimated_amount?: number | null;
  approved_amount?: number | null;
}

export interface Step {
  desk: Desk;
  key: StepKey;
  /** What the person at the desk should do — or what we are waiting for. */
  label: string;
  /** true: the hospital must act. false: waiting on the insurer / scheme. */
  ours: boolean;
  dueAt: Date | null;
  overdue: boolean;
}

const HOUR = 3_600_000, DAY = 24 * HOUR;
const isGovt = (t: ClaimType) => t === 'pmjay' || t === 'cghs' || t === 'echs' || t === 'state_scheme';
const t = (s?: string | null) => (s ? new Date(s.length === 10 ? `${s}T00:00:00+05:30` : s) : null);

/** Service targets. Cashless insurers: IRDAI 2024 master circular — pre-auth decided in 1 hour, discharge in 3 hours. */
export const TARGETS = {
  sendPreauth: 6 * HOUR,          // from admission
  preauthReply: { insurer: 1 * HOUR, govt: 6 * HOUR },
  answerQuery: 4 * HOUR,
  sendClaim: { insurer: 3 * HOUR, govt: 7 * DAY, corporate: 15 * DAY },
  claimDecision: { insurer: 15 * DAY, govt: 30 * DAY },
  payment: { insurer: 30 * DAY, govt: 45 * DAY },
};

function step(desk: Desk, key: StepKey, label: string, ours: boolean, from: Date | null, ms: number | null, now: Date): Step {
  const dueAt = from && ms != null ? new Date(from.getTime() + ms) : null;
  return { desk, key, label, ours, dueAt, overdue: !!dueAt && now > dueAt };
}

export function nextStep(c: CaseLike, now = new Date()): Step {
  const govt = isGovt(c.claim_type);
  const corporate = c.claim_type === 'corporate' || c.claim_type === 'reimbursement';
  const pmjay = c.claim_type === 'pmjay';
  const admitted = t(c.admitted_at) ?? t(c.admission_date) ?? t(c.created_at);
  const discharged = t(c.discharged_at) ?? t(c.discharge_date);
  const changed = t(c.status_changed_at) ?? t(c.updated_at);
  const where = pmjay ? 'TMS' : 'payer';

  switch (c.status) {
    case 'draft':
      if (corporate && !discharged) {
        return step('admission', 'in_hospital_approved', 'Admitted — raise bill to corporate after discharge', false, null, null, now);
      }
      if (discharged) {
        return step('claims', 'send_claim', corporate ? 'Raise final bill to corporate' : 'Submit final claim', true,
          discharged ?? admitted, corporate ? TARGETS.sendClaim.corporate : govt ? TARGETS.sendClaim.govt : TARGETS.sendClaim.insurer, now);
      }
      return step('admission', 'send_preauth', pmjay ? 'Submit pre-auth on TMS' : 'Submit pre-authorisation', true, admitted, TARGETS.sendPreauth, now);
    case 'preauth_pending':
      return step('admission', 'wait_preauth', `Awaiting pre-auth decision (${where})`, false,
        t(c.preauth_submitted_at) ?? changed, govt ? TARGETS.preauthReply.govt : TARGETS.preauthReply.insurer, now);
    case 'preauth_query':
      return step('admission', 'answer_preauth_query', 'Reply to pre-auth query', true, changed, TARGETS.answerQuery, now);
    case 'preauth_rejected':
      return step('admission', 'preauth_rejected', 'Pre-auth rejected — appeal or convert to self-pay', true, changed, TARGETS.answerQuery, now);
    case 'preauth_approved':
    case 'preauth_enhanced':
      if (!discharged) {
        const short = c.estimated_amount != null && c.approved_amount != null && c.estimated_amount > c.approved_amount;
        return step('admission', 'in_hospital_approved',
          short ? 'Approved below estimate — request enhancement if required' : 'Pre-auth approved — patient admitted', false, null, null, now);
      }
      return step('claims', 'send_claim', pmjay ? 'Submit claim on TMS' : 'Submit final claim', true,
        discharged, govt ? TARGETS.sendClaim.govt : TARGETS.sendClaim.insurer, now);
    case 'claim_submitted':
    case 'claim_under_review':
      return step('claims', 'wait_claim', `Awaiting claim decision (${where})`, false,
        t(c.submitted_at) ?? changed, govt ? TARGETS.claimDecision.govt : TARGETS.claimDecision.insurer, now);
    case 'claim_query':
      return step('claims', 'answer_claim_query', 'Reply to claim query', true, changed, 2 * DAY, now);
    case 'claim_rejected':
      return step('claims', 'claim_rejected', 'Claim rejected — appeal or seek write-off approval', true, changed, 7 * DAY, now);
    case 'claim_approved':
    case 'claim_partial':
    case 'settlement_pending':
      return step('payment', 'wait_payment', 'Claim approved — awaiting settlement', false,
        changed, govt ? TARGETS.payment.govt : TARGETS.payment.insurer, now);
    default:
      return step('done', 'done', 'Done', false, null, null, now);
  }
}

/** Sort for a desk: our overdue work first, then our work by due time, then waiting cases that are overdue (to chase). */
export function byUrgency<T extends { step: Step }>(a: T, b: T): number {
  const rank = (s: Step) => (s.ours ? (s.overdue ? 0 : 1) : s.overdue ? 2 : 3);
  const r = rank(a.step) - rank(b.step);
  if (r) return r;
  return (a.step.dueAt?.getTime() ?? Infinity) - (b.step.dueAt?.getTime() ?? Infinity);
}

/** "2 h late", "in 40 min", "3 days late" */
export function dueText(s: Step, now = new Date()): string | null {
  if (!s.dueAt) return null;
  const ms = s.dueAt.getTime() - now.getTime();
  const abs = Math.abs(ms);
  const txt = abs < HOUR ? `${Math.max(1, Math.round(abs / 60000))} min` : abs < 2 * DAY ? `${Math.round(abs / HOUR)} h` : `${Math.round(abs / DAY)} days`;
  return ms < 0 ? `${txt} overdue` : `in ${txt}`;
}

export const STATUS_WORDS: Record<ClaimStatus, string> = {
  draft: 'Not submitted',
  preauth_pending: 'Pre-auth submitted', preauth_query: 'Pre-auth query', preauth_approved: 'Pre-auth approved',
  preauth_enhanced: 'Enhancement approved', preauth_rejected: 'Pre-auth rejected',
  claim_submitted: 'Claim submitted', claim_under_review: 'Claim under review', claim_query: 'Claim query',
  claim_approved: 'Claim approved', claim_partial: 'Partially approved', claim_rejected: 'Claim rejected',
  settlement_pending: 'Settlement due', settled: 'Settled', closed: 'Closed', written_off: 'Written off',
};
