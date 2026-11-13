import { describe, expect, it } from 'vitest';
import type { Claim } from '@/lib/claims/types';
import type { CaseMoney } from './journey';
import { stageOf } from './journey';
import { nextStep } from './worklist';
import { cutOf } from './cut';
import { paymentStep, type Journey } from './api';
import { sortRows, ledgerRow, inBank, inFilter, inPayState, isBacklog, rowPayerGroup, byReminder, toCsv, doctorKey, doctorLabel, type ColKey, type LedgerRow } from './ledger';

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
  const j: Journey = { c: cl, money: m, stage, step: paymentStep(step, stage, m, cutOf(cl, m, NOW), NOW) };
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
    expect(r.cells.paid).toMatchObject({ editable: true, sub: '₹500 due' });
  });
  it('paid in two parts, more expected: balance awaited, no deduction yet, next part can be entered', () => {
    const r = paid({}, { allocated: 30000, tds: 0, balance: 20000, recon_status: 'part_received', parts: 2, last_paid: '2026-10-20' });
    expect(r.cells.paid).toMatchObject({ text: '₹30,000', sub: '₹20,000 awaited · 2 payments', editable: true });
    expect(r.cells.cut).toMatchObject({ state: 'theirs', text: 'Awaited', sub: 'Part-paid · decide after 19 Nov', editable: true });
    expect(r.next).toMatchObject({ ours: false, done: false, text: 'Part-paid (2 payments) — ₹20,000 balance awaited from the payer' });
    expect(inFilter(r, 'cuts')).toBe(false);
  });
  it('part-paid and nothing more for 30 days: the shortfall is put up to accept or dispute', () => {
    const r = paid({}, { allocated: 30000, balance: 20000, recon_status: 'part_received', parts: 1, last_paid: '2026-09-15' });
    expect(r.cells.cut).toMatchObject({ state: 'ours', tone: 'alert', text: '₹22,000' });
    expect(inFilter(r, 'cuts')).toBe(true);
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
    // discharged before 1 Nov 2026: over 30 days, but it sits in Backlog rather than the everyday views
    expect(inFilter(r, 'aged')).toBe(false);
    expect(inFilter(r, 'backlog')).toBe(true);
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
    expect(notYet.cells.paid.sub).toBe('Not in bank');
    const inBank = row(c(base), money({ allocated: 49000, tds: 1000, balance: 0, banked: 49000 }));
    expect(inBank.cells.paid.sub).toBe('In bank ✓');
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
  it('a PMJAY case shows its PMJAY case ID first', () => {
    const p = row(c({ case_source: 'pmjay', claim_type: 'pmjay', tpa_claim_number: '2026102910013158', admission_date: '2026-10-29', admitted_at: null }));
    expect(p.cells.patient.tag).toBe('PMJAY sheet');
    expect(p.cells.patient.sub).toMatch(/^Case 2026102910013158 · IPS-1/);
  });
  it('a PMJAY case has no pre-auth cells and no enhancement: admitted, then discharge', () => {
    const p = row(c({ claim_type: 'pmjay', status: 'draft', tpa_claim_number: '2026102910013158' }));
    expect(p.cells.pa_sent).toMatchObject({ state: 'na', text: 'Not applicable', editable: false });
    expect(p.cells.pa_ok).toMatchObject({ state: 'na', editable: false });
    expect(p.next.text).toBe('Admission approved — record the discharge');
    const approved = row(c({ claim_type: 'pmjay', status: 'preauth_approved', approved_amount: 91714 }));
    expect(approved.cells.pa_ok.sub).toBeUndefined();
    expect(approved.cells.pa_ok.editable).toBe(false);
    // other payers keep the enhancement
    expect(row(c({ status: 'preauth_approved', approved_amount: 91714, preauth_submitted_at: '2026-10-28T10:00:00+05:30' })).cells.pa_ok.sub).toBe('+ Add enhancement');
  });
});

describe('Master filters: payer type and payment', () => {
  const approved = { status: 'claim_approved', submitted_at: 'x', claimed_amount: 50000, approved_amount: 50000, discharged_at: 'x' } as const;
  it('payer type follows the payer master grouping', () => {
    expect(rowPayerGroup(row(c({})))).toBe('tpa');
    expect(rowPayerGroup(row(c({ clm_payers: { id: 'g', code: 'pmjay_gj', name: 'PMJAY', type: 'government' } })))).toBe('pmjay');
    expect(rowPayerGroup(row(c({ clm_payers: { id: 'g', code: 'cghs', name: 'CGHS', type: 'government' } })))).toBe('scheme');
    expect(rowPayerGroup(row(c({ clm_payers: null })))).toBeNull();
  });
  it('payment state: nothing, part, full, deduction', () => {
    const none = row(c(approved), money({}));
    const part = row(c(approved), money({ allocated: 20000, balance: 30000, recon_status: 'part_received', last_paid: '2026-10-25' }));
    const full = row(c(approved), money({ allocated: 50000, balance: 0, recon_status: 'settled' }));
    const cut = row(c(approved), money({ allocated: 45000, deduction: 5000, balance: 0, recon_status: 'settled' }));
    expect(inPayState(none, 'unpaid')).toBe(true);
    expect(inPayState(part, 'part')).toBe(true);
    expect(inPayState(part, 'paid')).toBe(false);
    expect(inPayState(full, 'paid')).toBe(true);
    expect(inPayState(cut, 'short')).toBe(true);
    expect(inPayState(cut, 'paid')).toBe(true);
    expect(inPayState(full, 'short')).toBe(false);
  });
});

describe('Master filters: a short payment past its wait is a deduction, not part-paid', () => {
  it('paid less with no balance awaited counts under Deduction taken', () => {
    const r = row(c({ status: 'claim_approved', submitted_at: 'x', claimed_amount: 50000, approved_amount: 50000, discharged_at: 'x' }),
      money({ allocated: 40000, balance: 10000, recon_status: 'part_received', last_paid: '2026-08-01' }));
    expect(inPayState(r, 'short')).toBe(true);
    expect(inPayState(r, 'part')).toBe(false);
  });
});

describe('Backlog: open files discharged before 1 Nov 2026', () => {
  const base = { status: 'claim_approved', submitted_at: 'x', claimed_amount: 50000, approved_amount: 50000 } as const;
  it('old open file sits in Backlog, out of the everyday views', () => {
    const r = row(c({ ...base, discharge_date: '2026-10-20' }), money({}));
    expect(isBacklog(r)).toBe(true);
    expect(inFilter(r, 'backlog')).toBe(true);
    expect(inFilter(r, 'open')).toBe(false);
    expect(inFilter(r, 'aged')).toBe(false);
  });
  it('a file discharged from 1 Nov, or still in hospital, is current', () => {
    const r = row(c({ ...base, discharge_date: '2026-11-01' }), money({}));
    expect(isBacklog(r)).toBe(false);
    expect(inFilter(r, 'open')).toBe(true);
    const inHosp = row(c({ status: 'preauth_approved', preauth_submitted_at: 'x', approved_amount: 40000, admitted_at: '2026-10-25T08:00:00+05:30' }));
    expect(isBacklog(inHosp)).toBe(false);
  });
  it('closed old files still show under Closed, not Backlog', () => {
    const r = row(c({ ...base, status: 'settled', discharge_date: '2026-09-01' }), money({ allocated: 50000, balance: 0, recon_status: 'settled' }));
    expect(inFilter(r, 'backlog')).toBe(false);
    expect(inFilter(r, 'closed')).toBe(true);
  });
});

describe('doctor on Master', () => {
  it('groups the same doctor however the name was typed', () => {
    expect(doctorKey('DR KALPESH C PATEL')).toBe('KALPESH C PATEL');
    expect(doctorKey('Dr. Kalpesh C. Patel')).toBe('KALPESH C PATEL');
    expect(doctorKey('  dr kalpesh  c patel ')).toBe('KALPESH C PATEL');
    expect(doctorLabel('DR KALPESH C PATEL')).toBe('Dr Kalpesh C Patel');
    expect(doctorLabel(null)).toBe('');
  });
  it('Excel export carries the doctor', () => {
    const csv = toCsv([row(c({ treating_doctor_name: 'DR RITESH PATEL' }))]);
    expect(csv.split('\n')[0]).toContain('Doctor');
    expect(csv).toContain('DR RITESH PATEL');
  });
});

describe('Master view: one cell per stage', () => {
  it('pre-auth: due → waiting → query → approved, each in the same cell, tap opens the step due', () => {
    expect(row(c({})).view.preauth).toMatchObject({ key: 'pa_sent', state: 'ours', text: 'Send pre-auth', editable: true });
    const waiting = row(c({ status: 'preauth_pending', preauth_submitted_at: '2026-10-27T09:00:00+05:30', tpa_preauth_number: 'PA-1' })).view.preauth;
    expect(waiting).toMatchObject({ key: 'pa_ok', state: 'theirs', text: 'Sent 27 Oct', sub: 'PA-1 · Awaiting · 2 d', editable: true });
    const query = row(c({ status: 'preauth_query', preauth_submitted_at: '2026-10-27T09:00:00+05:30' })).view.preauth;
    expect(query).toMatchObject({ key: 'pa_ok', text: 'Query', sub: 'Sent 27 Oct', tone: 'alert' });
    const ok = row(c({ status: 'preauth_approved', preauth_submitted_at: '2026-10-27T09:00:00+05:30', preauth_approved_amount: 85000 })).view.preauth;
    expect(ok).toMatchObject({ key: 'pa_ok', text: 'Approved ₹85,000', sub: '+ Add enhancement', editable: true });
  });
  it('pre-auth not taken stays a plain note', () => {
    const r = row(c({ status: 'claim_submitted', submitted_at: '2026-10-28T12:00:00+05:30', discharged_at: '2026-10-28T10:00:00+05:30', claimed_amount: 50000 }));
    expect(r.view.preauth).toMatchObject({ state: 'na', text: 'Not taken', editable: false });
  });
  it('claim: sent with amount and days waiting, then approved with the cut', () => {
    const sent = row(c({ status: 'claim_submitted', submitted_at: '2026-10-28T12:00:00+05:30', discharged_at: '2026-10-28T10:00:00+05:30', claimed_amount: 91714 })).view.claim;
    expect(sent).toMatchObject({ key: 'cl_ok', state: 'theirs', text: 'Sent 28 Oct', sub: '₹91,714 · Awaiting · 1 d' });
    const ok = row(c({ status: 'claim_partial', submitted_at: '2026-10-28T12:00:00+05:30', discharged_at: 'x', claimed_amount: 52000, approved_amount: 50000 }), money({})).view.claim;
    expect(ok).toMatchObject({ text: 'Approved ₹50,000', sub: 'Claimed ₹52,000 · ₹2,000 deducted' });
    const full = row(c({ status: 'claim_approved', submitted_at: 'x', discharged_at: 'x', claimed_amount: 50000, approved_amount: 50000 }), money({})).view.claim;
    expect(full).toMatchObject({ text: 'Approved ₹50,000' });
    expect(full.sub).toBeUndefined();
    const due = row(c({ status: 'draft', discharged_at: '2026-10-28T10:00:00+05:30', claim_type: 'pmjay', case_source: 'pmjay' })).view.claim;
    expect(due).toMatchObject({ key: 'cl_sent', state: 'ours', text: 'Send claim' });
  });
  it('payment: received, and a short payment waiting for Accept / Dispute takes the cell', () => {
    const paid = row(c({ status: 'settled', submitted_at: 'x', discharged_at: 'x', claimed_amount: 50000, approved_amount: 50000, settled_amount: 50000 }),
      money({ allocated: 50000, balance: 0, banked: 50000 })).view.pay;
    expect(paid).toMatchObject({ text: '₹50,000', sub: 'In bank ✓', state: 'done' });
    const short = row(c({ status: 'claim_approved', submitted_at: 'x', discharged_at: 'x', claimed_amount: 50000, approved_amount: 50000 }),
      money({ allocated: 45000, balance: 5000 })).view.pay;
    expect(short).toMatchObject({ key: 'cut', state: 'ours', text: '₹45,000', tone: 'alert' });
    expect(short.sub).toContain('₹5,000 cut');
    expect(short.sub).toContain('Accept or dispute');
  });
});

describe('Archive', () => {
  it('a settled file with no cut pending is done (Archive); a disputed one stays on Master', () => {
    const settled = row(c({ status: 'settled', submitted_at: 'x', discharged_at: 'x', claimed_amount: 50000, approved_amount: 50000, settled_amount: 50000 }),
      money({ allocated: 50000, balance: 0, banked: 50000 }));
    expect(settled.next.done).toBe(true);
    expect(inBank(settled)).toBe(true);
    const notBanked = row(c({ status: 'settled', submitted_at: 'x', discharged_at: 'x', claimed_amount: 50000, approved_amount: 50000, settled_amount: 50000 }),
      money({ allocated: 50000, balance: 0, banked: 0 }));
    expect(notBanked.next.done).toBe(true);
    expect(inBank(notBanked)).toBe(false);
    const fought = row(c({ status: 'settled', cut_decision: 'fought', submitted_at: 'x', discharged_at: 'x', claimed_amount: 50000, approved_amount: 45000, settled_amount: 45000 }),
      money({ allocated: 45000, balance: 0, expected_amount: 45000 }));
    expect(fought.next.done).toBe(false);
  });
});

describe('PMJAY: after the claim goes, the wait is for the payment sheet', () => {
  it('claim cell shows when it went; payment cell waits, due 30 days from submission', () => {
    const r = row(c({ status: 'claim_submitted', claim_type: 'pmjay', case_source: 'pmjay', submitted_at: '2026-10-20T12:00:00+05:30',
      discharged_at: '2026-10-20T10:00:00+05:30', claimed_amount: 91714 }));
    expect(r.next.text).toBe('Awaiting PMJAY payment');
    expect(r.next.ours).toBe(false);
    expect(r.view.claim).toMatchObject({ text: 'Sent 20 Oct', sub: '₹91,714', key: 'cl_ok', editable: true });
    expect(r.view.pay).toMatchObject({ text: 'Awaiting', state: 'theirs', sub: 'Due by 19 Nov' });
  });
  it('past 30 days: follow up', () => {
    const r = row(c({ status: 'claim_submitted', claim_type: 'pmjay', submitted_at: '2026-09-01T12:00:00+05:30', discharged_at: 'x', claimed_amount: 5000 }));
    expect(r.next.late).toBe(true);
    expect(r.view.pay.sub).toBe('Was due 01 Oct');
  });
  it('other payers still wait for the claim decision', () => {
    const r = row(c({ status: 'claim_submitted', submitted_at: '2026-10-20T12:00:00+05:30', discharged_at: 'x', claimed_amount: 5000 }));
    expect(r.next.text).toMatch(/claim decision/);
    expect(r.view.pay.text).toBe('');
  });
});

describe('Excel download keeps long numbers as text', () => {
  it('16-digit PMJAY case ID and leading-zero numbers are not turned into rounded numbers', () => {
    const csv = toCsv([row(c({ claim_type: 'pmjay', tpa_claim_number: '2026102910013158', patient_uhid: '00123', admission_ref: 'IPS1262407' }))]);
    expect(csv).toContain('="2026102910013158"');
    expect(csv).toContain('="00123"');
    expect(csv).toContain(',IPS1262407,');
    expect(csv.split('\r\n')[0]).toContain('Claim no. / PMJAY case ID');
  });
});

describe('sorting Master by a column', () => {
  const a = row(c({ id: 'a', patient_name: 'Zarna Patel', status: 'claim_submitted', preauth_submitted_at: 'x', discharged_at: '2026-10-20T10:00:00+05:30', submitted_at: '2026-10-21T10:00:00+05:30', claimed_amount: 90000 }));
  const b = row(c({ id: 'b', patient_name: 'amit Shah', status: 'claim_submitted', preauth_submitted_at: 'x', discharged_at: '2026-10-25T10:00:00+05:30', submitted_at: '2026-10-26T10:00:00+05:30', claimed_amount: 40000 }));
  const n = row(c({ id: 'n', patient_name: 'Mona Dave' })); // new admission: no discharge, nothing due
  const ids = (rs: LedgerRow[]) => rs.map((r) => r.j.c.id).join('');
  it('names A to Z, whatever the capitals', () => {
    expect(ids(sortRows([a, n, b], { key: 'patient', dir: 'asc' }))).toBe('bna');
    expect(ids(sortRows([a, n, b], { key: 'patient', dir: 'desc' }))).toBe('anb');
  });
  it('dates and money both ways, with empty cells last either way', () => {
    expect(ids(sortRows([a, n, b], { key: 'disch', dir: 'desc' }))).toBe('ban');
    expect(ids(sortRows([a, n, b], { key: 'disch', dir: 'asc' }))).toBe('abn');
    expect(ids(sortRows([b, n, a], { key: 'pay', dir: 'desc' }))).toBe('abn');
    expect(ids(sortRows([b, n, a], { key: 'pay', dir: 'asc' }))).toBe('ban');
  });
  it('no column chosen: the reminder order', () => {
    expect(ids(sortRows([a, n, b], null))).toBe(ids([a, n, b].sort(byReminder)));
  });
});
