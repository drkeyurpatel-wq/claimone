import { describe, expect, it } from 'vitest';
import type { Claim, LeakageRow } from '@/lib/claims/types';
import type { CaseMoney } from './journey';
import { stageOf } from './journey';
import { nextStep } from './worklist';
import { cutOf } from './cut';
import { paymentStep, type Journey } from './api';
import { ledgerRow } from './ledger';
import { deductionGrid, disputesByMonth, outstandingByPayer, stuck, thisWeek } from './summary';

const NOW = new Date('2026-10-29T12:00:00+05:30');
const c = (o: Partial<Claim>) => ({
  id: Math.random().toString(36), status: 'draft', claim_type: 'cashless', patient_name: 'Ramesh Shah', admission_ref: 'IPS-1',
  admitted_at: '2026-10-01T08:00:00+05:30', created_at: '2026-10-01T08:00:00+05:30', updated_at: '2026-10-01T08:00:00+05:30',
  clm_payers: { id: 'p', code: 'medi_assist', name: 'Medi Assist TPA', type: 'tpa' }, ...o,
}) as Claim;
const money = (o: Partial<CaseMoney>): CaseMoney => ({ receivable_id: 'r', claim_id: 'c1', expected_amount: 50000, billed_amount: 52000,
  allocated: 0, tds: 0, deduction: 0, balance: 50000, recon_status: 'open', status: 'open', ...o });
const row = (cl: Claim, m: CaseMoney | null = null) => {
  const step = nextStep(cl, NOW); const stage = stageOf(cl, m, step);
  const j: Journey = { c: cl, money: m, stage, step: paymentStep(step, stage, m, cutOf(cl, m)) };
  return ledgerRow(j, true, NOW);
};

describe('weekly summary', () => {
  const rows = [
    // approved 40 days after discharge, nothing paid: ₹50,000 owed, 31–60
    row(c({ status: 'claim_approved', claimed_amount: 52000, approved_amount: 50000, submitted_at: '2026-09-19T10:00:00+05:30',
      discharged_at: '2026-09-19T10:00:00+05:30', status_changed_at: '2026-10-25T10:00:00+05:30' }), money({})),
    // submitted this week, 5 days since discharge
    row(c({ status: 'claim_submitted', claimed_amount: 30000, submitted_at: '2026-10-25T10:00:00+05:30', discharged_at: '2026-10-24T10:00:00+05:30',
      clm_payers: { id: 'q', code: 'hdfc', name: 'HDFC ERGO', type: 'insurer' } as Claim['clm_payers'] })),
    // pre-auth sent, waiting more than its 1 hour
    row(c({ status: 'preauth_pending', preauth_submitted_at: '2026-10-29T08:00:00+05:30', admitted_at: '2026-10-29T07:00:00+05:30' })),
  ];
  it('outstanding by payer and age', () => {
    const o = outstandingByPayer(rows);
    expect(o.map((p) => [p.payer, p.total])).toEqual([['Medi Assist TPA', 50000], ['HDFC ERGO', 30000]]);
    expect(o[0].buckets['31–60 days']).toBe(50000);
    expect(o[1].buckets['0–30 days']).toBe(30000);
  });
  it('this week', () => {
    expect(thisWeek(rows, NOW)).toMatchObject({ claimsSubmitted: 1, claimed: 30000, approvals: 1, approved: 50000, admissions: 1 });
  });
  it('stuck files grouped by step', () => {
    const s = stuck(rows);
    expect(s.find((x) => x.label.startsWith('Awaiting pre-auth decision'))?.cases).toBe(1);
  });
  it('deductions by reason × payer', () => {
    const leak = [
      { payer_name: 'Medi Assist TPA', kind: 'deduction', category: 'non_payable', month: '2026-09-01', amount: 4000 },
      { payer_name: 'Medi Assist TPA', kind: 'deduction', category: 'room_rent_cap', month: '2026-10-01', amount: 1000 },
      { payer_name: 'HDFC ERGO', kind: 'deduction', category: 'non_payable', month: '2026-10-01', amount: 2000 },
      { payer_name: 'HDFC ERGO', kind: 'fighting', category: 'other', month: '2026-10-01', amount: 9000 },
      { payer_name: 'HDFC ERGO', kind: 'deduction', category: 'other', month: '2025-01-01', amount: 9000 },
    ] as LeakageRow[];
    const g = deductionGrid(leak, '2026-05-01');
    expect(g.categories).toEqual(['Non-payable items', 'Room rent cap']);
    expect(g.total).toBe(7000);
    expect(g.payers[0]).toMatchObject({ payer: 'Medi Assist TPA', total: 5000 });
  });
  it('disputes by month: accepted, disputed, won and recovered', () => {
    const m = disputesByMonth([
      { cut_decision: 'accepted', cut_decided_at: '2026-10-05T10:00:00+05:30', status: 'settled', claimed_amount: 30000, approved_amount: 29500, deduction_amount: 500 },
      { cut_decision: 'fought', cut_decided_at: '2026-10-06T10:00:00+05:30', status: 'settled', claimed_amount: 52000, approved_amount: 50000, deduction_amount: 0 },
      { cut_decision: 'fought', cut_decided_at: '2026-09-06T10:00:00+05:30', status: 'claim_partial', claimed_amount: 40000, approved_amount: 36000, deduction_amount: null },
    ], 6, NOW);
    const oct = m.find((x) => x.month === '2026-10')!;
    expect(oct).toMatchObject({ accepted: 1, acceptedAmt: 500, disputed: 1, won: 1, recovered: 2000, open: 0 });
    expect(m.find((x) => x.month === '2026-09')).toMatchObject({ disputed: 1, disputedAmt: 4000, open: 1 });
    expect(m).toHaveLength(6);
  });
});
