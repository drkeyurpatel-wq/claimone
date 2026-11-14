/**
 * The patient's file journey, as the desk sees it: one row of stages from
 * pre-auth to the money being reconciled. Each case sits at exactly one stage.
 * Status changes still go through the database; this only says where the file is.
 */
import type { Claim } from '@/lib/claims/types';
import { nextStep, type Step } from './worklist';
import { cutOf } from './cut';

export type StageKey = 'preauth' | 'stay' | 'discharge' | 'claim' | 'payment' | 'closed';

export const STAGES: { key: StageKey; label: string; hint: string }[] = [
  { key: 'preauth', label: 'Pre-auth', hint: 'Send the pre-auth with the admission papers and get it approved.' },
  { key: 'stay', label: 'In hospital', hint: 'Watch the bill against the approval; ask for enhancement if it will cross.' },
  { key: 'discharge', label: 'Discharge & bill', hint: 'Final bill and discharge papers ready — send the claim.' },
  { key: 'claim', label: 'Claim', hint: 'Insurer decides: approved, cut, query or rejected.' },
  { key: 'payment', label: 'Payment', hint: 'Money comes in from the weekly upload. Accept or fight any cut of ₹1,000 or more.' },
  { key: 'closed', label: 'Closed', hint: 'Paid and reconciled.' },
];

/**
 * What a file is waiting for when the next move is not ours — said for the stage it is in, never one phrase for all.
 * Claim: the insurer has the claim and has not decided. Payment: the claim is approved and the money has not come.
 */
export const WAITING: Record<StageKey | 'all', string> = {
  all: 'Nothing for us to do right now',
  preauth: 'Pre-auth sent — insurer has not replied yet',
  stay: 'In hospital — nothing due from us',
  discharge: 'Nothing due from us',
  claim: 'Claim submitted — insurer has not approved it yet',
  payment: 'Claim approved — money not received yet',
  closed: 'Closed',
};

/** The money side of a case (its bill on the receivables book). */
export interface CaseMoney {
  receivable_id: string; claim_id: string; expected_amount: number; billed_amount: number | null; allocated: number; tds: number;
  deduction: number; balance: number; recon_status: 'open' | 'part_received' | 'settled' | 'over_received' | 'disputed'; status: string;
  /** Of the money received, how much is matched to a bank credit (0023). */
  banked?: number;
  /** How many payments (transfers) make up what was received (0026). */
  parts?: number;
  /** Date of the latest payment (IST day, yyyy-mm-dd). */
  last_paid?: string | null;
  /** Of the money received, how much came with a UTR (0038). A payment with a UTR is in the bank; `banked` is the later statement check. */
  withUtr?: number;
}

const PAYMENT_STEPS = new Set(['wait_payment']);

export function stageOf(c: Claim, money: CaseMoney | null, step: Step = nextStep(c)): StageKey {
  if (c.status === 'closed' || c.status === 'written_off') return 'closed';
  // a cut waiting for Accept / Fight, or being fought, keeps the file in payment
  const cut = cutOf(c, money);
  if (cut.needsDecision || (cut.state === 'fought' && cut.amount >= 1)) return 'payment';
  if (c.status === 'settled') return 'closed';
  if (money && (money.recon_status === 'settled' || (money.status === 'closed' && Math.abs(money.balance) <= 1))) return 'closed';
  if (PAYMENT_STEPS.has(step.key) || (money && money.allocated > 0)) return 'payment';
  switch (step.key) {
    case 'send_preauth': case 'wait_preauth': case 'answer_preauth_query': case 'preauth_rejected': return 'preauth';
    case 'in_hospital_approved': return 'stay';
    case 'send_claim': return 'discharge';
    case 'wait_claim': case 'answer_claim_query': case 'claim_rejected': return 'claim';
    default: return 'closed';
  }
}

export const stageIndex = (k: StageKey) => STAGES.findIndex((s) => s.key === k);

/** For the tracker: which stages are done, which is current, which are skipped (e.g. no pre-auth for a company). */
export function stageStates(c: Claim, current: StageKey): Record<StageKey, 'done' | 'current' | 'todo' | 'skipped'> {
  const at = stageIndex(current);
  // past pre-auth without one sent: not needed (corporate), not taken, or not recorded (old sheet) — never "done"
  // PMJAY has no pre-auth step at all: the admission is approved on TMS with the case ID
  const noPreauth = !c.preauth_submitted_at || c.claim_type === 'pmjay';
  return Object.fromEntries(STAGES.map((s, i) => [s.key,
    s.key === 'preauth' && noPreauth && i < at ? 'skipped' : i < at ? 'done' : i === at ? (current === 'closed' ? 'done' : 'current') : 'todo',
  ])) as Record<StageKey, 'done' | 'current' | 'todo' | 'skipped'>;
}

/** How a pre-auth stage that was never sent is described — the same words Master uses. */
export function noPreauthWord(c: Pick<Claim, 'claim_type' | 'case_source'>): string {
  if (c.claim_type === 'corporate' || c.claim_type === 'reimbursement' || c.claim_type === 'pmjay') return 'Not needed';
  return c.case_source === 'sheet' || c.case_source === 'pmjay' ? 'Not recorded' : 'Not taken';
}

/** Which stages a desk login starts on. */
export const WORKSPACE_STAGE: Record<string, StageKey> = { admission: 'preauth', claims: 'discharge', payments: 'payment' };
