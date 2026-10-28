import { describe, expect, it } from 'vitest';
import { allRows } from './pages';

describe('allRows', () => {
  it('keeps reading until a short page', async () => {
    const rows = Array.from({ length: 2345 }, (_, i) => i);
    const calls: [number, number][] = [];
    const r = await allRows((from, to) => { calls.push([from, to]); return Promise.resolve({ data: rows.slice(from, to + 1), error: null }); });
    expect(r.data).toHaveLength(2345);
    expect(calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });
  it('stops on an error and says so', async () => {
    const r = await allRows(() => Promise.resolve({ data: null, error: { message: 'x' } }));
    expect(r.error?.message).toBe('x');
  });
});
