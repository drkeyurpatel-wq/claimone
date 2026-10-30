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

  it('a fought cut stays in payment: letter due, then the payer is chased, then escalation', () => {
    const c = claim({ cut_decision: 'fought', cut_decided_at: '2026-10-01T10:00:00+05:30' });
    const m = money({ allocated: 39200, tds: 800, balance: 2000, recon_status: 'disputed' });
    const cut = cutOf(c, m);
    expect(cut).toMatchObject({ amount: 2000, state: 'fought', needsDecision: false, letter: null });
    expect(stageOf(c, m)).toBe('payment');
    // no letter yet: ours, 2 days
    const s = cutStep(cut, new Date('2026-10-05T10:00:00+05:30'))!;
    expect(s).toMatchObject({ ours: true, overdue: true, label: 'Disputed ₹2,000 — send the reconsideration letter' });
    // letter sent: waiting on the payer for 15 days
    const sent = cutOf(claim({ cut_decision: 'fought', cut_decided_at: '2026-10-01T10:00:00+05:30', dispute_level: 1, dispute_sent_at: '2026-10-02T10:00:00+05:30' }), m);
    expect(cutStep(sent, new Date('2026-10-10T10:00:00+05:30'))).toMatchObject({ ours: false, overdue: false, label: 'Reconsideration of ₹2,000 sent 02 Oct — awaiting reply' });
    // no reply in 15 days: escalation is ours
    expect(cutStep(sent, new Date('2026-10-20T10:00:00+05:30'))).toMatchObject({ ours: true, overdue: true, label: 'No reply to reconsideration of ₹2,000 — escalate to the insurer' });
    // escalated, then the patient's grievance: no further letter
    const esc = cutOf(claim({ cut_decision: 'fought', dispute_level: 2, dispute_sent_at: '2026-10-20T10:00:00+05:30' }), m);
    expect(cutStep(esc, new Date('2026-10-25T10:00:00+05:30'))!.label).toBe('Escalated ₹2,000 to the insurer 20 Oct — awaiting reply');
    const pg = cutOf(claim({ cut_decision: 'fought', dispute_level: 3, dispute_sent_at: '2026-11-10T10:00:00+05:30' }), m);
    expect(cutStep(pg, new Date('2026-12-20T10:00:00+05:30'))).toMatchObject({ ours: false, overdue: true });
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

describe('payments in parts', () => {
  const now = new Date('2026-10-30T10:00:00+05:30');
  // ₹42,000 approved, ₹20,000 came on 20 Oct in the first of two transfers
  const part = money({ allocated: 20000, balance: 22000, recon_status: 'part_received', parts: 1, last_paid: '2026-10-20' });

  it('a part payment is a balance awaited, not a deduction', () => {
    const c = claim({});
    const cut = cutOf(c, part, now);
    expect(cut.needsDecision).toBe(false);
    expect(cut.awaited).toMatchObject({ amount: 22000, parts: 1, lastPaid: '2026-10-20' });
    const step = paymentStep(nextStep(c, now), stageOf(c, part), part, cut);
    expect(step.ours).toBe(false);
    expect(step.label).toBe('Part-paid (1 payment) — ₹22,000 balance awaited from the payer');
  });

  it('thirty days after the last part, the balance comes up to accept or dispute', () => {
    const cut = cutOf(claim({}), part, new Date('2026-11-25T10:00:00+05:30'));
    expect(cut.awaited ?? null).toBeNull();
    expect(cut).toMatchObject({ amount: 22000, needsDecision: true });
  });

  it('a decision recorded after the last part ends the wait (the payer said it is final)', () => {
    const cut = cutOf(claim({ cut_decision: 'fought', cut_decided_at: '2026-10-25T10:00:00Z' } as Partial<Claim>), part, now);
    expect(cut.awaited ?? null).toBeNull();
    expect(cut.state).toBe('fought');
  });

  it('a desk acceptance before the money came does not stop later parts being awaited', () => {
    const cut = cutOf(claim({ cut_decision: 'accepted', cut_decided_at: '2026-10-01T10:00:00Z' } as Partial<Claim>), part, now);
    expect(cut.awaited?.amount).toBe(22000);
  });

  it('the database fills each invoice by what it still waits for', () => {
    const sql = readFileSync('supabase/migrations/0026_split_payments.sql', 'utf8');
    expect(sql).toMatch(/caps := caps \|\| greatest\(coalesce\(\(select v\.balance/);
  });
});
