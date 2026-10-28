import { describe, expect, it } from 'vitest';
import type { Claim } from '@/lib/claims/types';
import { stageOf, stageStates, type CaseMoney } from './journey';

const c = (o: Partial<Claim>) => ({ status: 'draft', claim_type: 'cashless', created_at: '2026-10-28T08:00:00+05:30', updated_at: '2026-10-28T08:00:00+05:30', ...o }) as Claim;
const money = (o: Partial<CaseMoney>): CaseMoney => ({ receivable_id: 'r', claim_id: 'c', expected_amount: 100000, billed_amount: 100000, allocated: 0, tds: 0,
  deduction: 0, balance: 100000, recon_status: 'open', status: 'open', ...o });

describe('file journey', () => {
  it('follows the file from pre-auth to closed', () => {
    expect(stageOf(c({}), null)).toBe('preauth');
    expect(stageOf(c({ status: 'preauth_query' }), null)).toBe('preauth');
    expect(stageOf(c({ status: 'preauth_approved' }), null)).toBe('stay');
    expect(stageOf(c({ status: 'preauth_approved', discharged_at: '2026-10-28T09:00:00+05:30' }), null)).toBe('discharge');
    expect(stageOf(c({ status: 'claim_query' }), null)).toBe('claim');
    expect(stageOf(c({ status: 'claim_approved' }), money({}))).toBe('payment');
    expect(stageOf(c({ status: 'claim_approved' }), money({ allocated: 100000, balance: 0, recon_status: 'settled' }))).toBe('closed');
  });
  it('money already received puts a file in payment even if nobody recorded the approval', () => {
    expect(stageOf(c({ status: 'claim_submitted' }), money({ allocated: 60000, balance: 40000, recon_status: 'part_received' }))).toBe('payment');
  });
  it('a company case skips pre-auth on the tracker', () => {
    const k = c({ claim_type: 'corporate', discharged_at: '2026-10-28T09:00:00+05:30' });
    expect(stageOf(k, null)).toBe('discharge');
    expect(stageStates(k, 'discharge')).toMatchObject({ preauth: 'skipped', stay: 'done', discharge: 'current', claim: 'todo' });
  });
  it('closed shows every step done', () => {
    expect(Object.values(stageStates(c({ preauth_submitted_at: 'x' }), 'closed')).every((s) => s === 'done')).toBe(true);
  });
});
