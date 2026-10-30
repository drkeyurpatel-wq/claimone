import { describe, expect, it } from 'vitest';
import type { Claim } from '@/lib/claims/types';
import type { CaseMoney } from './journey';
import { stageOf } from './journey';
import { nextStep } from './worklist';
import { cutOf } from './cut';
import { paymentStep, type Journey } from './api';
import { ledgerRow, inFilter, byReminder, toCsv, type ColKey, type LedgerRow } from './ledger';

const NOW = new Date('2026-10-29T12:00:00+05:30');
const c = (o: Partial<Claim>) => ({
  id: 'c1', status: 'draft', claim_type: 'cashless', patient_name: 'Ramesh Shah', admission_ref: 'IPS-1',
  admitted_at: '2026-10-29T08:00:00+05:30', created_at: '2026-10-29T08:00:00+05:30', updated_at: '2026-10-29T08:00:00+05:30',
  clm_payers: { id: 'p', code: 'medi_assist', name: 'Medi Assist TPA', type: 'tpa' }, ...o,
}) as Claim;
const money = (o: Partial<CaseMoney>): CaseMoney => ({ receivable_id: 'r', claim_id: 'c1', expected_amount: 50000, billed_amount: 52000,
  allocated: 0, tds: 0, deduction: 0, balance: 50000, recon_status: 'open', status: 'open', ...o });

function row(cl: Claim, m: CaseMoney | null = null, canWrite = true): LedgerRow {
  const step = nextStep(cl, NOW);
  const stage = stageOf(cl, m, step);
  const j: Journey = { c: cl, money: m, stage, step: paymentStep(step, stage, m, cutOf(cl, m)) };
  return ledgerRow(j, canWrite, NOW);
}
/** The one cell to fill now, if any. */
const now = (r: LedgerRow) => (Object.values(r.cells).filter((x) => x.state === 'ours' || x.state === 'theirs').map((x) => x.key) as ColKey[]);

describe('ledger row: cells fill left to right', () => {
  it('new admission: pre-auth sent is the one to fill', () => {
    const r = row(c({}));
    expect(now(r)).toEqual(['pa_sent']);
    expect(r.cells.pa_sent).toMatchObject({ state: 'ours', editable: true });
    expect(r.cells.cl_sent.editable).toBe(false);
    expect(r.cells.paid.editable).toBe(false);
    expect(r.cells.disch.editable).toBe(true); // a discharge can always be typed before the claim goes
    expect(r.next).toMatchObject({ ours: true, done: false });
  });
  it('pre-auth sent: waiting on the insurer in the approval cell', () => {
    const r = row(c({ status: 'preauth_pending', preauth_submitted_at: '2026-10-29T09:00:00+05:30', tpa_preauth_number: 'PA-1' }));
    expect(r.cells.pa_sent).toMatchObject({ state: 'done', sub: 'PA-1', editable: false });
    expect(r.cells.pa_ok).toMatchObject({ state: 'theirs', text: 'Awaiting', editable: true });
    expect(r.next.ours).toBe(false);
  });
  it('a pre-auth query is red and ours', () => {
    const r = row(c({ status: 'preauth_query', preauth_submitted_at: 'x' }));
    expect(r.cells.pa_ok).toMatchObject({ state: 'ours', tone: 'alert', text: 'Query', editable: true });
  });
  it('in hospital: discharge is next, enhancement still possible', () => {
    const r = row(c({ status: 'preauth_approved', preauth_submitted_at: 'x', approved_amount: 50000, preauth_approved_amount: 50000 }));
    expect(r.cells.pa_ok).toMatchObject({ state: 'done', text: '₹50,000', editable: true });
    expect(now(r)).toEqual([]); // nothing due: in hospital
    expect(r.cells.disch).toMatchObject({ state: 'open', editable: true });
  });
  it('discharged: claim sent is next', () => {
    const r = row(c({ status: 'preauth_approved', preauth_submitted_at: 'x', approved_amount: 50000, discharged_at: '2026-10-29T10:00:00+05:30' }));
    expect(now(r)).toEqual(['cl_sent']);
    expect(r.cells.disch).toMatchObject({ state: 'done', editable: true });
  });
  it('claim sent: pre-auth figure stays, approval cell waits', () => {
    const r = row(c({ status: 'claim_submitted', preauth_submitted_at: 'x', submitted_at: '2026-10-29T11:00:00+05:30', claimed_amount: 52000,
      approved_amount: 50000, preauth_approved_amount: 50000, discharged_at: 'x' }));
    expect(r.cells.pa_ok.text).toBe('₹50,000');
    expect(r.cells.cl_sent).toMatchObject({ state: 'done', sub: '₹52,000' });
    expect(r.cells.cl_ok).toMatchObject({ state: 'theirs', text: 'Awaiting' });
    expect(r.cells.disch.editable).toBe(false);
  });
  it('approved less: shows the cut at approval, then waits for money', () => {
    const r = row(c({ status: 'claim_partial', submitted_at: 'x', claimed_amount: 52000, approved_amount: 50000, discharged_at: 'x' }), money({}));
    expect(r.cells.cl_ok).toMatchObject({ state: 'done', text: '₹50,000', sub: '₹2,000 deducted' });
    // a ₹2,000 cut needs Accept / Fight once known — here at approval, the money comes first
    expect(r.cells.paid.editable).toBe(true);
  });
  it('a company patient skips pre-auth', () => {
    const r = row(c({ claim_type: 'corporate' }));
    expect(r.cells.pa_sent).toMatchObject({ state: 'na', text: 'Not applicable', editable: false });
    expect(r.cells.disch.editable).toBe(true);
  });
  it('a viewer can open nothing but the patient', () => {
    const r = row(c({}), null, false);
    expect(Object.values(r.cells).filter((x) => x.editable).map((x) => x.key)).toEqual(['patient']);
  });
});

describe('ledger row: money and cuts', () => {
  const paid = (o: Partial<Claim>, m: Partial<CaseMoney>) =>
    row(c({ status: 'claim_approved', submitted_at: 'x', claimed_amount: 52000, approved_amount: 50000, discharged_at: 'x', status_changed_at: '2026-10-29T11:00:00+05:30', ...o }), money(m));
  it('paid with a ₹2,000 cut: red cut cell, ours, file not closed', () => {
    const r = paid({}, { allocated: 49000, tds: 1000, balance: 0, recon_status: 'settled' });
    expect(r.cells.paid).toMatchObject({ state: 'done', text: '₹49,000', sub: 'TDS ₹1,000' });
    expect(r.cells.cut).toMatchObject({ state: 'ours', tone: 'alert', text: '₹2,000', editable: true });
    expect(inFilter(r, 'cuts')).toBe(true);
    expect(r.next.done).toBe(false);
  });
  it('paid ₹500 short of the approval: still a decision, whatever the size', () => {
    const r = paid({ claimed_amount: 50000 }, { allocated: 49500, balance: 500, recon_status: 'part_received' });
    expect(r.cells.cut).toMatchObject({ state: 'ours', text: '₹500', editable: true });
    expect(r.cells.paid).toMatchObject({ editable: true, sub: '₹500 outstanding' });
  });
  it('fighting: amber, can still take the payment', () => {
    const r = paid({ cut_decision: 'fought', cut_decided_at: '2026-10-29T11:00:00+05:30' },
      { allocated: 49000, tds: 1000, balance: 2000, expected_amount: 52000, recon_status: 'disputed' });
    expect(r.cells.cut).toMatchObject({ tone: 'warn', sub: 'Disputed · letter due', editable: true });
    expect(r.next).toMatchObject({ ours: true, text: 'Disputed ₹2,000 — send the reconsideration letter' });
    expect(r.cells.paid.editable).toBe(true);
    expect(inFilter(r, 'cuts')).toBe(true);
  });
  it('net entered as the gross: excess shows red, the entry can be reviewed', () => {
    const r = paid({ claimed_amount: 72000, approved_amount: 72000 }, { expected_amount: 72000, allocated: 72000, tds: 1440, balance: -1440, recon_status: 'over_received' });
    expect(r.cells.paid).toMatchObject({ tone: 'alert', sub: '₹1,440 excess — review', editable: true });
    expect(r.next).toMatchObject({ ours: true, done: false });
    expect(r.next.text).toContain('Excess of ₹1,440');
  });
  it('a further enhancement stays possible until the claim is submitted', () => {
    const r = row(c({ status: 'preauth_enhanced', preauth_submitted_at: 'x', approved_amount: 82000, preauth_approved_amount: 82000, discharged_at: 'x' }));
    expect(r.cells.pa_ok).toMatchObject({ text: '₹82,000', sub: 'Enhanced · + add more', editable: true });
    const s = row(c({ status: 'claim_submitted', preauth_submitted_at: 'x', submitted_at: 'x', approved_amount: 82000, preauth_approved_amount: 82000, discharged_at: 'x' }));
    expect(s.cells.pa_ok.editable).toBe(false);
  });
  it('fought and paid in full: shows Won, row closed', () => {
    const r = paid({ status: 'settled', claimed_amount: 52000, cut_decision: 'fought', cut_decided_at: 'x' },
      { allocated: 51000, tds: 1000, balance: 0, expected_amount: 52000, recon_status: 'settled' });
    expect(r.cells.cut).toMatchObject({ text: 'Recovered', editable: false });
    expect(r.next).toMatchObject({ done: true, text: 'Settled & closed' });
    expect(inFilter(r, 'cuts')).toBe(false);
  });
  it('paid in full and settled: closed row, nothing editable but the patient', () => {
    const r = paid({ status: 'settled', claimed_amount: 50000, settled_amount: 49000 }, { allocated: 49000, tds: 1000, balance: 0, recon_status: 'settled' });
    expect(r.next).toMatchObject({ done: true, text: 'Settled & closed' });
    expect(r.cells.cut).toMatchObject({ text: 'Nil', editable: false });
    expect(Object.values(r.cells).filter((x) => x.editable).map((x) => x.key)).toEqual(['patient']);
    expect(inFilter(r, 'closed')).toBe(true);
  });
});

describe('ledger order and download', () => {
  it('late first, closed last', () => {
    const late = row(c({ id: 'a', admitted_at: '2026-10-28T08:00:00+05:30' }));          // pre-auth not sent in 6 h
    const fresh = row(c({ id: 'b', admitted_at: '2026-10-29T11:00:00+05:30' }));
    const waiting = row(c({ id: 'd', status: 'preauth_approved', approved_amount: 1, preauth_submitted_at: 'x' }));
    expect(late.next.late).toBe(true);
    expect([waiting, fresh, late].sort(byReminder).map((r) => r.j.c.id)).toEqual(['a', 'b', 'd']);
  });
  it('the Excel file has a header and one line per patient, commas quoted', () => {
    const csv = toCsv([row(c({ patient_name: 'Shah, Ramesh' }))]);
    const lines = csv.replace('﻿', '').split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith('Source,Admission date,Patient,IP number')).toBe(true);
    expect(lines[1]).toContain('"Shah, Ramesh"');
  });
});

describe('ageing, bank and letters', () => {
  it('days since discharge, coloured; over 30 days filter', () => {
    const r = row(c({ status: 'claim_submitted', submitted_at: '2026-09-25T10:00:00+05:30', discharged_at: '2026-09-20T10:00:00+05:30' }));
    expect(r.age).toMatchObject({ from: 'discharge', days: 39, band: 'warn' });
    expect(inFilter(r, 'aged')).toBe(true);
    const old = row(c({ status: 'claim_submitted', submitted_at: '2026-08-20T10:00:00+05:30', discharged_at: '2026-08-15T10:00:00+05:30' }));
    expect(old.age?.band).toBe('late');
    const fresh = row(c({ status: 'claim_submitted', submitted_at: '2026-10-21T10:00:00+05:30', discharged_at: '2026-10-20T10:00:00+05:30' }));
    expect(fresh.age).toMatchObject({ days: 9, band: 'ok' });
    expect(inFilter(fresh, 'aged')).toBe(false);
  });
  it('in hospital: counted from admission, never late', () => {
    const r = row(c({ status: 'preauth_approved', preauth_submitted_at: '2026-10-20T10:00:00+05:30', approved_amount: 50000, admitted_at: '2026-10-20T08:00:00+05:30' }));
    expect(r.age).toMatchObject({ from: 'admission', days: 9, band: 'ok' });
    expect(inFilter(r, 'aged')).toBe(false);
  });
  it('closed files carry no age', () => {
    const r = row(c({ status: 'settled', claimed_amount: 50000, approved_amount: 50000, discharged_at: '2026-08-01T10:00:00+05:30' }),
      money({ allocated: 49000, tds: 1000, balance: 0, recon_status: 'settled' }));
    expect(r.age).toBeNull();
  });
  it('settlement cell says whether the money is in the bank', () => {
    const base = { status: 'claim_approved' as const, submitted_at: 'x', claimed_amount: 50000, approved_amount: 50000, discharged_at: 'x' };
    const notYet = row(c(base), money({ allocated: 49000, tds: 1000, balance: 0, banked: 0 }));
    expect(notYet.cells.paid.sub).toBe('TDS ₹1,000 · Not in bank yet');
    const inBank = row(c(base), money({ allocated: 49000, tds: 1000, balance: 0, banked: 49000 }));
    expect(inBank.cells.paid.sub).toBe('TDS ₹1,000 · In bank ✓');
  });
  it('a letter sent shows on the deduction cell', () => {
    const r = row(c({ status: 'claim_approved', submitted_at: 'x', claimed_amount: 52000, approved_amount: 50000, discharged_at: 'x',
      cut_decision: 'fought', cut_decided_at: '2026-10-20T11:00:00+05:30', dispute_level: 1, dispute_sent_at: '2026-10-21T11:00:00+05:30' }),
      money({ allocated: 49000, tds: 1000, balance: 2000, expected_amount: 52000, recon_status: 'disputed' }));
    expect(r.cells.cut.sub).toBe('Disputed · Reconsideration sent 21 Oct');
    expect(r.next).toMatchObject({ ours: false, late: false });
    expect(r.next.text).toContain('awaiting reply');
  });
  it('after a query reply, the payer is chased in 48 hours', () => {
    const r = row(c({ status: 'claim_submitted', submitted_at: '2026-10-01T10:00:00+05:30', discharged_at: '2026-09-30T10:00:00+05:30',
      query_replied_at: '2026-10-26T10:00:00+05:30', status_changed_at: '2026-10-26T10:00:00+05:30' }));
    expect(r.next).toMatchObject({ ours: false, late: true });
    expect(r.next.text).toBe('Query replied — awaiting claim decision (payer)');
    expect(r.cells.cl_sent.text).toBe('01 Oct');
  });
});

describe('old sheet', () => {
  it('rows brought over from the old sheet are tagged; others are not', () => {
    expect(row(c({ case_source: 'sheet' })).cells.patient.tag).toBe('Old sheet');
    const old = row(c({ case_source: 'sheet', status: 'claim_submitted', submitted_at: '2026-03-01T12:00:00+05:30', discharged_at: '2026-03-01T12:00:00+05:30' }));
    expect(old.cells.pa_sent.text).toBe('Not recorded');
    expect(old.cells.patient.sub).toBe('IPS-1');
    expect(row(c({ case_source: 'manual' })).cells.patient.tag).toBeUndefined();
    expect(toCsv([row(c({ case_source: 'sheet' })), row(c({ case_source: 'manual', id: 'c2' }))]).split('\r\n').slice(1).map((l) => l.split(',')[0]))
      .toEqual(['Old sheet', 'Entered in ClaimOne']);
  });
});
