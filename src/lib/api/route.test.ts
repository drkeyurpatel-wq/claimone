import { describe, test, expect } from 'vitest';
import { fromDbError } from './route';

describe('database errors become plain answers', () => {
  test('gate refusal → 422 with the blocking documents listed', async () => {
    const res = fromDbError({
      code: '23514', hint: 'CLAIMONE_GATE',
      message: 'Submission blocked — documents not verified: Implant invoice + sticker (missing); Signed discharge summary (uploaded)',
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.blockers).toEqual(['Implant invoice + sticker (missing)', 'Signed discharge summary (uploaded)']);
  });
  test('rule violations → 409 with the trigger message', async () => {
    const res = fromDbError({ code: '23514', message: 'Transition draft → settled is not allowed' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/not allowed/);
  });
  test('manager-only actions → 403', () => {
    expect(fromDbError({ code: '42501', message: 'Only a manager can write off a claim' }).status).toBe(403);
  });
});
