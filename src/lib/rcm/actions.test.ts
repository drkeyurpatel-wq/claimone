import { describe, expect, it } from 'vitest';
import type { Claim, ClaimStatus, ClaimType } from '@/lib/claims/types';
import { TRANSITIONS } from '@/lib/engine/transitions';
import { actionsFor } from './actions';
import { nextStep } from './worklist';

const STATUSES: ClaimStatus[] = ['draft', 'preauth_pending', 'preauth_query', 'preauth_approved', 'preauth_enhanced', 'preauth_rejected',
  'claim_submitted', 'claim_under_review', 'claim_query', 'claim_approved', 'claim_partial', 'claim_rejected', 'settlement_pending'];
const TYPES: ClaimType[] = ['cashless', 'pmjay', 'corporate', 'cghs'];

const claim = (status: ClaimStatus, claim_type: ClaimType, discharged: boolean) => ({
  status, claim_type, created_at: '2026-10-28T08:00:00+05:30', updated_at: '2026-10-28T08:00:00+05:30',
  discharged_at: discharged ? '2026-10-28T09:00:00+05:30' : null, claimed_amount: 1000, bill_amount: 1200,
  approved_amount: 900, tpa_claim_number: null, tpa_preauth_number: null,
}) as unknown as Claim;

describe('case screen buttons', () => {
  it('every button is a move the database allows', () => {
    for (const s of STATUSES) for (const t of TYPES) for (const d of [false, true]) for (const route of ['portal', 'nhcx', 'tms'] as const) {
      const c = claim(s, t, d);
      for (const a of actionsFor(nextStep(c), c, route)) {
        const allowed = TRANSITIONS[s].map((x) => x.to);
        expect(allowed, `${s} → ${a.to} (${t}, discharged ${d})`).toContain(a.to);
      }
    }
  });
  it('NHCX payers get a real send; others record how it was sent', () => {
    const c = claim('draft', 'cashless', false);
    expect(actionsFor(nextStep(c), c, 'nhcx')[0]).toMatchObject({ nhcx: 'preauth', label: 'Send on NHCX' });
    expect(actionsFor(nextStep(c), c, 'tms')[0]).toMatchObject({ label: 'Submitted on TMS', ref: { field: 'tpa_preauth_number' } });
  });
  it('the final claim is prefilled with the bill', () => {
    const c = claim('preauth_approved', 'cashless', true);
    expect(actionsFor(nextStep(c), c, 'portal')[0].amount).toMatchObject({ field: 'claimed_amount', value: 1000 });
  });
  it('a lower approval asks why, so the deduction has a reason', () => {
    const c = claim('claim_submitted', 'cashless', true);
    expect(actionsFor(nextStep(c), c, 'portal').find((a) => a.to === 'claim_partial')?.note?.required).toBe(true);
  });
  it('only managers write off', () => {
    const c = claim('claim_rejected', 'cashless', true);
    expect(actionsFor(nextStep(c), c, 'portal').find((a) => a.to === 'written_off')?.managerOnly).toBe(true);
  });
});
