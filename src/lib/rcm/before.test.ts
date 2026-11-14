import { describe, expect, it } from 'vitest';
import { oldSummary } from './before';
import { dischargeDay, isOldBill, isOldCase, isOldDate } from './ledger';

describe('the 1 Nov line', () => {
  it('goes by the discharge date', () => {
    expect(isOldDate('2026-10-31')).toBe(true);
    expect(isOldDate('2026-11-01')).toBe(false);
    expect(isOldDate(null)).toBe(false);
    expect(isOldCase({ discharge_date: '2026-10-28' })).toBe(true);
    expect(isOldCase({ discharge_date: null, discharged_at: null })).toBe(false); // still in hospital
    expect(dischargeDay({ discharge_date: null, discharged_at: '2026-10-31T20:00:00Z' })).toBe('2026-11-01'); // 1:30 am IST
  });
  it('a bill follows its case; a bill with no case goes by its bill date', () => {
    expect(isOldBill('2026-11-05', '2026-10-30', true)).toBe(true);
    expect(isOldBill('2026-10-30', '2026-11-02', true)).toBe(false);
    expect(isOldBill('2026-10-30', null, false)).toBe(true);
    expect(isOldBill(null, null, false)).toBe(false);
  });
});

describe('Before 1 Nov summary', () => {
  const frozen = { as_on: '2026-11-14', bills: 161, bill_amount: 19670937, claims: 70, claim_amount: 1700343 };
  it('puts the frozen figure beside what is pending today', () => {
    const s = oldSummary(frozen, { total: 15000000, count: 120 }, [100000, 50000]);
    expect(s.opening).toEqual({ as_on: '2026-11-14', files: 231, amount: 21371280 });
    expect(s.now).toEqual({ files: 122, amount: 15150000 });
    expect(s.cleared).toEqual({ files: 109, amount: 6221280 });
  });
  it('works without a frozen figure', () => {
    const s = oldSummary(null, { total: 500, count: 1 }, []);
    expect(s.opening).toBeNull(); expect(s.cleared).toBeNull(); expect(s.now).toEqual({ files: 1, amount: 500 });
  });
});
