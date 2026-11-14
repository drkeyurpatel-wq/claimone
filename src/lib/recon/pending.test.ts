import { describe, expect, it } from 'vitest';
import { outcome, type PendingBill, type Snapshot } from './pending';

const bill = (p: Partial<PendingBill>): PendingBill => ({ payer: 'pmjay', payer_name: 'PMJAY / MA (Gujarat)', balance: 10000, bill_date: '2026-10-01',
  disputed: false, onMaster: false, partPaid: false, ...p });
const snap = (p: Partial<Snapshot>): Snapshot => ({ bills: [], claims: [], closed: 0, payerNames: { pmjay: 'PMJAY / MA (Gujarat)', hdfc: 'HDFC Ergo' }, ...p });
const now = new Date('2026-11-14T15:00:00+05:30');

describe('what an upload cleared and what is left', () => {
  const before = snap({ closed: 3, bills: [
    bill({ balance: 8332, partPaid: true }), bill({ balance: 91714, onMaster: true }), bill({ balance: 220000, onMaster: true }),
    bill({ balance: 189298, disputed: true, partPaid: true }), bill({ balance: 25740, bill_date: '2025-01-16' }),
    bill({ payer: 'hdfc', payer_name: 'HDFC Ergo', balance: 50000, onMaster: true }),
  ], claims: [
    { payer: 'pmjay', amount: 40000, discharged: '2026-09-10' }, { payer: 'pmjay', amount: 15000, discharged: '2026-11-05' },
    { payer: 'hdfc', amount: 70000, discharged: '2026-08-01' },
  ] });
  const after = snap({ closed: 5, bills: [
    bill({ balance: 220000, onMaster: true }), bill({ balance: 189298, disputed: true, partPaid: true }), bill({ balance: 25740, bill_date: '2025-01-16' }),
    bill({ payer: 'hdfc', payer_name: 'HDFC Ergo', balance: 50000, onMaster: true }),
  ], claims: before.claims });

  it('reports only the payer the file touched: pending bills before → after and files archived', () => {
    const o = outcome(before, after, now);
    expect(o.changed).toEqual([{ payer: 'pmjay', name: 'PMJAY / MA (Gujarat)', billsBefore: 5, billsAfter: 3, amountBefore: 535084, amountAfter: 435038 }]);
    expect(o).toMatchObject({ billsBefore: 5, billsAfter: 3, amountBefore: 535084, amountAfter: 435038, archived: 2 });
  });

  it('splits what is still pending by where each file stands, and counts submitted claims the bills leave out', () => {
    const o = outcome(before, after, now);
    expect(o.awaited).toEqual({ files: 1, amount: 220000 });
    expect(o.disputed).toEqual({ files: 1, amount: 189298 });
    expect(o.old).toEqual({ files: 1, amount: 25740 });
    expect(o.submitted).toEqual({ files: 2, amount: 55000 });
    expect(o.total).toEqual({ files: 5, amount: 490038 });
  });

  it('marks submitted claims past 30 days from discharge for chasing', () => {
    expect(outcome(before, after, now).chase).toEqual({ files: 1, amount: 40000 });
  });

  it('a repeat upload changes nothing but still says what is pending for the payer of the file', () => {
    const o = outcome(after, after, now, ['pmjay']);
    expect(o.changed).toEqual([]);
    expect(o).toMatchObject({ billsBefore: 3, billsAfter: 3, archived: 0, total: { files: 5, amount: 490038 } });
  });

  it('a file touching two payers reports both, biggest change first', () => {
    const o = outcome(before, snap({ ...after, bills: after.bills.filter((b) => b.payer !== 'hdfc') }), now);
    expect(o.changed.map((c) => c.payer)).toEqual(['pmjay', 'hdfc']);
    expect(o.total.files).toBe(6); // 3 PMJAY bills + 3 submitted claims (2 PMJAY, 1 HDFC)
  });
});
