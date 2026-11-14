import { describe, expect, it } from 'vitest';
import { tmsOutcome } from './pending';

describe('what one TMS upload cleared', () => {
  it('reports pending bills before and after, files archived, and all that is still to come', () => {
    const o = tmsOutcome(
      { bills: 287, billAmount: 3498440, waiting: 95, waitingAmount: 2900000, closed: 3 },
      { bills: 18, billAmount: 694396, waiting: 92, waitingAmount: 2855561, closed: 132 });
    expect(o).toMatchObject({ billsBefore: 287, billsAfter: 18, amountBefore: 3498440, amountAfter: 694396, archived: 129,
      pendingFiles: 110, pendingAmount: 3549957, waiting: 92, waitingAmount: 2855561 });
  });
  it('a repeat upload clears nothing', () => {
    const s = { bills: 18, billAmount: 694396, waiting: 92, waitingAmount: 2855561, closed: 132 };
    expect(tmsOutcome(s, s)).toMatchObject({ billsBefore: 18, billsAfter: 18, archived: 0, pendingFiles: 110 });
  });
});
