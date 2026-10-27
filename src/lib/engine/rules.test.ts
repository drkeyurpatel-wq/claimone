// Transitions and settlement maths, plus a parity check that the
// TypeScript state machine matches the one the database enforces.
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { TRANSITIONS, isAllowed } from './transitions';
import { checkSettlement, DISALLOWANCE_CATEGORIES } from './settlement';
import { STATUS_CONFIG, type ClaimStatus } from '@/lib/claims/types';

const sql = readFileSync(path.resolve(__dirname, '../../../supabase/migrations/0001_core.sql'), 'utf8');

describe('state machine', () => {
  test('matches clm_allowed_transitions in the database exactly', () => {
    const block = sql.split('insert into clm_allowed_transitions')[1].split(';')[0];
    const dbPairs = [...block.matchAll(/\('(\w+)','(\w+)'\)/g)].map((m) => `${m[1]}>${m[2]}`).sort();
    const tsPairs = Object.entries(TRANSITIONS)
      .flatMap(([from, list]) => list.map((t) => `${from}>${t.to}`)).sort();
    expect(tsPairs).toEqual(dbPairs);
  });

  test('every status has a label and a transition list', () => {
    for (const s of Object.keys(STATUS_CONFIG) as ClaimStatus[]) expect(TRANSITIONS[s]).toBeDefined();
  });

  test('terminal states go nowhere', () => {
    expect(TRANSITIONS.closed).toHaveLength(0);
    expect(TRANSITIONS.written_off).toHaveLength(0);
  });

  test('cannot jump from draft to settled', () => {
    expect(isAllowed('draft', 'settled')).toBe(false);
    expect(isAllowed('settlement_pending', 'settled')).toBe(true);
  });

  test('write-off is manager-only and only from rejected', () => {
    const wo = Object.entries(TRANSITIONS).flatMap(([f, l]) => l.filter((t) => t.to === 'written_off').map((t) => ({ f, t })));
    expect(wo).toHaveLength(1);
    expect(wo[0].f).toBe('claim_rejected');
    expect(wo[0].t.managerOnly).toBe(true);
  });
});

describe('settlement maths', () => {
  test('deduction = claimed − approved; net = approved − TDS', () => {
    const r = checkSettlement({ claimed: 50000, approved: 42000, tds: 4200, net: 37800, items: [] });
    expect(r.ok).toBe(true);
    expect(r.deduction).toBe(8000);
    expect(r.expectedNet).toBe(37800);
  });

  test('H1 Claims bug: ignoring TDS overstates cash', () => {
    const r = checkSettlement({ claimed: 50000, approved: 42000, tds: 4200, net: 42000, items: [] });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/37,800/);
  });

  test('approved above claimed is rejected', () => {
    expect(checkSettlement({ claimed: 1000, approved: 1200, tds: 0, net: 1200, items: [] }).ok).toBe(false);
  });

  test('itemised deductions must add up to the deduction (₹1 tolerance)', () => {
    const base = { claimed: 50000, approved: 42000, tds: 0, net: 42000 };
    expect(checkSettlement({ ...base, items: [{ category: 'room_rent_cap', amount: 5000 }] }).ok).toBe(false);
    expect(checkSettlement({ ...base, items: [
      { category: 'room_rent_cap', amount: 5000 }, { category: 'non_payable', amount: 2999.5 },
    ] }).ok).toBe(true);
  });

  test('categories match the database check constraint and preventable flag', () => {
    const constraint = sql.split("category     text not null check (category in (")[1].split('))')[0];
    const dbCats = [...constraint.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();
    expect(Object.keys(DISALLOWANCE_CATEGORIES).sort()).toEqual(dbCats);
    const prevent = sql.split("(category in (")[2].split('))')[0];
    const dbPrev = [...prevent.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();
    const tsPrev = Object.entries(DISALLOWANCE_CATEGORIES).filter(([, v]) => v.preventable).map(([k]) => k).sort();
    expect(tsPrev).toEqual(dbPrev);
  });
});
