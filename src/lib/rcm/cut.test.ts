import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { cutOf, cutStep, CUT_FLOOR } from './cut';
import { stageOf } from './journey';
import { paymentStep } from './api';
import { nextStep } from './worklist';
import type { CaseMoney } from './journey';
import type { Claim } from '@/lib/claims/types';

const claim = (o: Partial<Claim>): Claim => ({
  id: 'c1', status: 'claim_approved', claim_type: 'cashless', claimed_amount: 42000, approved_amount: 42000,
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', ...o,
} as unknown as Claim);
const money = (o: Partial<CaseMoney>): CaseMoney => ({
  receivable_id: 'r1', claim_id: 'c1', expected_amount: 42000, billed_amount: 42000, allocated: 0, tds: 0,
  deduction: 0, balance: 42000, recon_status: 'open', status: 'open', ...o,
});
// the letter: ₹39,200 paid + ₹800 TDS + ₹2,000 non billable
const paidShort = money({ allocated: 39200, tds: 800, deduction: 2000, balance: 0, recon_status: 'settled' });

describe('cut decisions', () => {
  it('matches the database floor', () => {
    const sql = readFileSync('supabase/migrations/0019_cut_decisions.sql', 'utf8');
    expect(sql).toContain(`select ${CUT_FLOOR}::numeric`);
  });

  it('a ₹2,000 cut waits for a person, even when the bill balances', () => {
    const c = claim({});
    const cut = cutOf(c, paidShort);
    expect(cut).toMatchObject({ amount: 2000, state: 'pending', needsDecision: true });
    expect(stageOf(c, paidShort)).toBe('payment');
    const step = paymentStep(nextStep(c), 'payment', paidShort, cut);
    expect(step.ours).toBe(true);
    expect(step.label).toBe('Deduction ₹2,000 — accept or dispute');
  });

  it('an approval cut waits before any money comes', () => {
    const cut = cutOf(claim({ status: 'claim_partial', approved_amount: 40000 }), null);
    expect(cut).toMatchObject({ amount: 2000, needsDecision: true });
  });

  it('cuts under ₹1,000 close on their own', () => {
    const m = money({ allocated: 40670, tds: 830, balance: 0, recon_status: 'settled' });
    const c = claim({});
    expect(cutOf(c, m)).toMatchObject({ amount: 500, state: 'small', needsDecision: false });
    expect(stageOf(c, m)).toBe('closed');
  });

  it('accepted cut lets the file close', () => {
    const c = claim({ status: 'settled', cut_decision: 'accepted' });
    expect(cutOf(c, paidShort).state).toBe('accepted');
    expect(stageOf(c, paidShort)).toBe('closed');
  });

  it('a fought cut stays in payment and is chased after 15 days', () => {
    const c = claim({ cut_decision: 'fought', cut_decided_at: '2026-10-01T10:00:00+05:30' });
    const m = money({ allocated: 39200, tds: 800, balance: 2000, recon_status: 'disputed' });
    const cut = cutOf(c, m);
    expect(cut).toMatchObject({ amount: 2000, state: 'fought', needsDecision: false });
    expect(stageOf(c, m)).toBe('payment');
    const s = cutStep(cut, new Date('2026-10-28T10:00:00+05:30'))!;
    expect(s.ours).toBe(false);
    expect(s.overdue).toBe(true);
    expect(s.label).toBe('Disputed deduction ₹2,000 — follow up with payer');
  });

  it('a won fight closes', () => {
    const c = claim({ status: 'settled', cut_decision: 'fought' });
    const m = money({ allocated: 41200, tds: 800, balance: 0, recon_status: 'settled' });
    expect(cutOf(c, m).amount).toBe(0);
    expect(stageOf(c, m)).toBe('closed');
  });

  it('a file settled before decisions existed can be fought but is not waiting', () => {
    const c = claim({ status: 'settled' });
    expect(cutOf(c, paidShort)).toMatchObject({ state: 'pending', needsDecision: false });
    expect(stageOf(c, paidShort)).toBe('closed');
  });

  it('no cut before approval', () => {
    expect(cutOf(claim({ status: 'claim_submitted', approved_amount: null }), null).state).toBe('none');
  });
});
