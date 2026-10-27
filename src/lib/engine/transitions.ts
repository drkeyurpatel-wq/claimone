/**
 * Claim state machine. Mirrors clm_allowed_transitions in 0001_core.sql —
 * the database enforces it; this copy only drives which buttons the desk sees.
 */

import type { ClaimStatus } from '@/lib/claims/types';

export interface TransitionAction {
  label: string;
  to: ClaimStatus;
  tone: 'primary' | 'success' | 'warning' | 'danger' | 'neutral';
  needsAmount?: 'approved_amount' | 'claimed_amount';
  managerOnly?: boolean;
  /** Settlement uses its own form, not the generic transition. */
  viaSettlement?: boolean;
}

export const TRANSITIONS: Record<ClaimStatus, TransitionAction[]> = {
  draft: [
    { label: 'Submit pre-auth', to: 'preauth_pending', tone: 'primary' },
    { label: 'Submit claim directly', to: 'claim_submitted', tone: 'primary', needsAmount: 'claimed_amount' },
  ],
  preauth_pending: [
    { label: 'Approved', to: 'preauth_approved', tone: 'success', needsAmount: 'approved_amount' },
    { label: 'Query raised', to: 'preauth_query', tone: 'warning' },
    { label: 'Rejected', to: 'preauth_rejected', tone: 'danger' },
  ],
  preauth_query: [
    { label: 'Resubmit pre-auth', to: 'preauth_pending', tone: 'primary' },
    { label: 'Rejected', to: 'preauth_rejected', tone: 'danger' },
  ],
  preauth_approved: [
    { label: 'Submit final claim', to: 'claim_submitted', tone: 'primary', needsAmount: 'claimed_amount' },
    { label: 'Enhancement approved', to: 'preauth_enhanced', tone: 'success', needsAmount: 'approved_amount' },
  ],
  preauth_enhanced: [
    { label: 'Submit final claim', to: 'claim_submitted', tone: 'primary', needsAmount: 'claimed_amount' },
  ],
  preauth_rejected: [
    { label: 'Appeal / resubmit', to: 'preauth_pending', tone: 'primary' },
    { label: 'Close (patient pays)', to: 'closed', tone: 'neutral' },
  ],
  claim_submitted: [
    { label: 'Under review', to: 'claim_under_review', tone: 'neutral' },
    { label: 'Query raised', to: 'claim_query', tone: 'warning' },
    { label: 'Approved in full', to: 'claim_approved', tone: 'success', needsAmount: 'approved_amount' },
    { label: 'Part approved', to: 'claim_partial', tone: 'warning', needsAmount: 'approved_amount' },
    { label: 'Rejected', to: 'claim_rejected', tone: 'danger' },
  ],
  claim_under_review: [
    { label: 'Approved in full', to: 'claim_approved', tone: 'success', needsAmount: 'approved_amount' },
    { label: 'Part approved', to: 'claim_partial', tone: 'warning', needsAmount: 'approved_amount' },
    { label: 'Query raised', to: 'claim_query', tone: 'warning' },
    { label: 'Rejected', to: 'claim_rejected', tone: 'danger' },
  ],
  claim_query: [
    { label: 'Resubmit claim', to: 'claim_submitted', tone: 'primary' },
    { label: 'Rejected', to: 'claim_rejected', tone: 'danger' },
  ],
  claim_approved: [
    { label: 'Awaiting payment', to: 'settlement_pending', tone: 'neutral' },
    { label: 'Record settlement', to: 'settled', tone: 'success', viaSettlement: true },
  ],
  claim_partial: [
    { label: 'Awaiting payment', to: 'settlement_pending', tone: 'neutral' },
    { label: 'Record settlement', to: 'settled', tone: 'success', viaSettlement: true },
  ],
  settlement_pending: [
    { label: 'Record settlement', to: 'settled', tone: 'success', viaSettlement: true },
  ],
  settled: [{ label: 'Close claim', to: 'closed', tone: 'neutral' }],
  claim_rejected: [
    { label: 'Appeal', to: 'claim_submitted', tone: 'primary' },
    { label: 'Write off', to: 'written_off', tone: 'danger', managerOnly: true },
  ],
  closed: [],
  written_off: [],
};

export function isAllowed(from: ClaimStatus, to: ClaimStatus): boolean {
  return TRANSITIONS[from]?.some((t) => t.to === to) ?? false;
}

export const TERMINAL: ClaimStatus[] = ['closed', 'written_off'];
export const OPEN_RECEIVABLE: ClaimStatus[] = [
  'claim_submitted', 'claim_under_review', 'claim_query', 'claim_approved', 'claim_partial', 'settlement_pending',
];
