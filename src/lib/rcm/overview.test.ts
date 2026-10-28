import { describe, expect, it } from 'vitest';
import { ageing, bucketOf, collections, deductions, pipeline, turnaround, type OpenBill, type PayerInfo } from './overview';
import type { Step } from './worklist';

const payers = new Map<string, PayerInfo>([
  ['p1', { id: 'p1', code: 'pmjay_gujarat', name: 'PMJAY / MA (Gujarat)' }],
  ['p2', { id: 'p2', code: 'medi_assist', name: 'Medi Assist TPA' }],
  ['p3', { id: 'p3', code: 'cghs', name: 'CGHS' }],
]);
const bill = (o: Partial<OpenBill>): OpenBill => ({ debtor_type: 'tpa', payer_id: 'p2', debtor_name: 'x', doctor_name: null, balance: 0, age_days: 0,
  billed_amount: null, expected_amount: 0, deduction: 0, recon_status: 'open', status: 'open', ...o });

describe('overview', () => {
  it('buckets by age', () => {
    expect([0, 30, 31, 90, 91, 180, 181].map(bucketOf)).toEqual(['0–30', '0–30', '31–60', '61–90', '91–180', '91–180', '180+']);
  });
  it('money owed by category and payer; settled and over-paid bills are left out', () => {
    const a = ageing([
      bill({ debtor_type: 'government', payer_id: 'p1', balance: 100000, age_days: 10 }),
      bill({ debtor_type: 'government', payer_id: 'p3', balance: 50000, age_days: 120 }),
      bill({ balance: 20000, age_days: 95 }),
      bill({ balance: 0.5, age_days: 300 }),
      bill({ balance: -500, age_days: 5 }),
      bill({ debtor_type: 'patient', payer_id: null, debtor_name: 'Patient', balance: 3000, age_days: 40 }),
    ], payers);
    expect(a.total).toBe(173000);
    expect(a.over90).toBe(70000);
    expect(a.byCategory.map((c) => c.category)).toEqual(['Insurance / TPA', 'PMJAY / MA', 'CGHS / ECHS / ESIC', 'Patient dues']);
    expect(a.byCategory.find((c) => c.category === 'CGHS / ECHS / ESIC')?.buckets['91–180']).toBe(50000);
    expect(a.byPayer[0]).toMatchObject({ name: 'PMJAY / MA (Gujarat)', total: 100000 });
  });
  it('desk counts', () => {
    const s = (desk: Step['desk'], ours: boolean, overdue: boolean) => ({ desk, ours, overdue }) as Step;
    expect(pipeline([s('admission', true, true), s('admission', false, false), s('claims', true, false), s('payment', false, true)]))
      .toEqual({ admission: { todo: 1, late: 1, waiting: 1 }, claims: { todo: 1, late: 0, waiting: 0 }, payment: { count: 1, late: 1 } });
  });
  it('deductions by reason and doctor', () => {
    const d = deductions([{ category: 'room_rent_cap', amount: 5000, created_at: '' }, { category: null, amount: 1000, created_at: '' },
      { category: 'room_rent_cap', amount: 2000, created_at: '' }], [bill({ doctor_name: 'Dr A', deduction: 7000 }), bill({ deduction: 1000 })]);
    expect(d.total).toBe(8000);
    expect(d.byReason[0]).toEqual({ reason: 'Room rent limit', amount: 7000 });
    expect(d.byDoctor).toEqual([{ doctor: 'Dr A', amount: 7000 }, { doctor: 'Not recorded', amount: 1000 }]);
  });
  it('collections count bank credits, not the advice for the same money', () => {
    const c = collections([{ value_date: '2026-10-05', amount: 100, source: 'bank' }, { value_date: '2026-10-05', amount: 100, source: 'advice' },
      { value_date: '2026-09-01', amount: 50, source: 'manual' }], 3, new Date('2026-10-28'));
    expect(c).toEqual([{ month: '2026-08', amount: 0 }, { month: '2026-09', amount: 50 }, { month: '2026-10', amount: 100 }]);
    expect(collections([{ value_date: '2026-10-05', amount: 70, source: 'advice' }], 1, new Date('2026-10-28'))[0].amount).toBe(70);
  });
  it('turnaround from the status history', () => {
    const t = turnaround([
      { claim_id: 'a', from_status: 'draft', to_status: 'preauth_pending', created_at: '2026-10-01T10:00:00Z' },
      { claim_id: 'a', from_status: 'preauth_pending', to_status: 'preauth_approved', created_at: '2026-10-01T12:00:00Z' },
      { claim_id: 'a', from_status: 'preauth_approved', to_status: 'claim_submitted', created_at: '2026-10-03T10:00:00Z' },
      { claim_id: 'a', from_status: 'claim_submitted', to_status: 'claim_approved', created_at: '2026-10-13T10:00:00Z' },
      { claim_id: 'b', from_status: 'draft', to_status: 'preauth_pending', created_at: '2026-10-01T10:00:00Z' },
      { claim_id: 'b', from_status: 'preauth_pending', to_status: 'preauth_query', created_at: '2026-10-01T14:00:00Z' },
    ]);
    expect(t).toEqual({ preauthHours: 3, preauthCount: 2, claimDays: 10, claimCount: 1 });
  });
});
