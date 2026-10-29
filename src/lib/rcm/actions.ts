/**
 * The buttons on a case screen. Each is a normal status change (the database
 * still checks it); this file only picks the few that fit the step, in words
 * the desk uses, and which box to ask for.
 */
import type { Claim, ClaimStatus } from '@/lib/claims/types';
import type { Step } from './worklist';
import { ROUTE_WORDS, type Route } from './payer';

export interface CaseAction {
  id: string;
  label: string;
  to: ClaimStatus;
  tone: 'primary' | 'success' | 'warning' | 'danger' | 'neutral';
  /** Ask for an amount, prefilled with this. */
  amount?: { field: 'approved_amount' | 'claimed_amount'; label: string; value: number | null };
  /** Ask for a reference number. */
  ref?: { field: 'tpa_preauth_number' | 'tpa_claim_number'; label: string; value: string | null };
  note?: { label: string; required: boolean };
  /** Send it over NHCX instead of only recording that it was sent. */
  nhcx?: 'preauth' | 'claim';
  managerOnly?: boolean;
}

const num = (x: unknown) => (x == null || x === '' ? null : Number(x));

export function actionsFor(step: Step, c: Claim, route: Route): CaseAction[] {
  const w = ROUTE_WORDS[route];
  const preauthRef = { field: 'tpa_preauth_number' as const, label: 'Pre-auth number (optional)', value: c.tpa_preauth_number };
  const claimRef = { field: 'tpa_claim_number' as const, label: 'Claim number (optional)', value: c.tpa_claim_number };
  const billed = num(c.claimed_amount) ?? num(c.bill_amount) ?? null;

  switch (step.key) {
    case 'send_preauth':
      return [{ id: 'sent', label: w.sent, to: 'preauth_pending', tone: 'primary', ...(route === 'nhcx' ? { nhcx: 'preauth' as const } : { ref: preauthRef }) }];
    case 'wait_preauth':
      return [
        { id: 'approved', label: 'Approved', to: 'preauth_approved', tone: 'success',
          amount: { field: 'approved_amount', label: 'Approved amount (₹)', value: num(c.approved_amount) }, ref: preauthRef },
        { id: 'query', label: 'Query raised', to: 'preauth_query', tone: 'warning', note: { label: 'Query details', required: true } },
        { id: 'rejected', label: 'Rejected', to: 'preauth_rejected', tone: 'danger', note: { label: 'Rejection reason', required: true } },
      ];
    case 'answer_preauth_query':
      return [{ id: 'answered', label: route === 'nhcx' ? 'Send reply on NHCX' : 'Query replied & resubmitted', to: 'preauth_pending', tone: 'primary',
        note: { label: 'Reply summary', required: true }, ...(route === 'nhcx' ? { nhcx: 'preauth' as const } : {}) }];
    case 'preauth_rejected':
      return [
        { id: 'appeal', label: 'Resubmit (appeal)', to: 'preauth_pending', tone: 'primary', note: { label: 'Grounds for appeal', required: true } },
        { id: 'close', label: 'Convert to self-pay & close', to: 'closed', tone: 'neutral', note: { label: 'Remarks', required: false } },
      ];
    case 'in_hospital_approved':
      return c.status === 'preauth_approved'
        ? [{ id: 'enhanced', label: 'Enhancement approved', to: 'preauth_enhanced', tone: 'success',
            amount: { field: 'approved_amount', label: 'Revised approved amount (₹)', value: num(c.approved_amount) } }]
        : [];
    case 'send_claim':
      return [{ id: 'claim_sent', label: w.sent, to: 'claim_submitted', tone: 'primary',
        amount: { field: 'claimed_amount', label: 'Final bill amount claimed (₹)', value: billed },
        ...(route === 'nhcx' ? { nhcx: 'claim' as const } : { ref: claimRef }) }];
    case 'wait_claim':
      return [
        { id: 'full', label: 'Approved in full', to: 'claim_approved', tone: 'success',
          amount: { field: 'approved_amount', label: 'Approved amount (₹)', value: billed }, ref: claimRef },
        { id: 'part', label: 'Partially approved', to: 'claim_partial', tone: 'warning',
          amount: { field: 'approved_amount', label: 'Approved amount (₹)', value: null }, ref: claimRef,
          note: { label: 'Deduction details (as per approval letter)', required: true } },
        { id: 'query', label: 'Query raised', to: 'claim_query', tone: 'warning', note: { label: 'Query details', required: true } },
        { id: 'rejected', label: 'Rejected', to: 'claim_rejected', tone: 'danger', note: { label: 'Rejection reason', required: true } },
      ];
    case 'answer_claim_query':
      return [{ id: 'answered', label: route === 'nhcx' ? 'Send reply on NHCX' : 'Query replied & resubmitted', to: 'claim_submitted', tone: 'primary',
        note: { label: 'Reply summary', required: true }, ...(route === 'nhcx' ? { nhcx: 'claim' as const } : {}) }];
    case 'claim_rejected':
      return [
        { id: 'appeal', label: 'Appeal & resubmit', to: 'claim_submitted', tone: 'primary', note: { label: 'Grounds for appeal', required: true } },
        { id: 'writeoff', label: 'Write off', to: 'written_off', tone: 'danger', managerOnly: true, note: { label: 'Write-off reason', required: true } },
      ];
    default:
      return [];
  }
}
