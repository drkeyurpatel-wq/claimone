/**
 * The ledger: one row per patient, read left to right like the Excel sheet
 * the desk used to keep. Each cell is filled once, in order; the first empty
 * cell is the one to fill next, and the last column says what to do (or chase).
 * Pure: the database still checks every status change.
 */
import type { Claim } from '@/lib/claims/types';
import type { Journey } from './api';
import type { CaseMoney } from './journey';
import { cutOf, CUT_FLOOR, type Cut } from './cut';
import { dueText, type Step } from './worklist';

export type ColKey = 'patient' | 'pa_sent' | 'pa_ok' | 'disch' | 'cl_sent' | 'cl_ok' | 'paid' | 'cut';

/** done: filled · ours: fill this now · theirs: the insurer's answer goes here · open: can be filled · blank: not yet · na: not needed */
export type CellState = 'done' | 'ours' | 'theirs' | 'open' | 'blank' | 'na';

export interface Cell {
  key: ColKey;
  state: CellState;
  /** Main text in the cell. */
  text: string;
  /** Small second line (number, date, note). */
  sub?: string;
  /** Red: a query, a rejection or a cut waiting for a decision. Amber: being fought. */
  tone?: 'alert' | 'warn';
  /** Tapping the cell opens its form. */
  editable: boolean;
}

export const COLUMNS: { key: ColKey; label: string; short: string }[] = [
  { key: 'patient', label: 'Patient', short: 'Patient' },
  { key: 'pa_sent', label: 'Pre-auth submitted', short: 'PA submitted' },
  { key: 'pa_ok', label: 'Pre-auth approved', short: 'PA approved' },
  { key: 'disch', label: 'Discharge', short: 'Discharge' },
  { key: 'cl_sent', label: 'Claim submitted', short: 'Claim submitted' },
  { key: 'cl_ok', label: 'Claim approved', short: 'Approved' },
  { key: 'paid', label: 'Settlement received', short: 'Settlement' },
  { key: 'cut', label: 'Deduction', short: 'Deduction' },
];

const IST = 'Asia/Kolkata';
export const dd = (d: string | null | undefined) =>
  d ? new Date(d.length === 10 ? `${d}T12:00:00+05:30` : d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: IST }) : '';
export const rs = (n: number | null | undefined) => (n == null ? '' : `₹${Math.round(Number(n)).toLocaleString('en-IN')}`);

const PREAUTH_DONE = new Set(['preauth_approved', 'preauth_enhanced']);
const CLAIM_STAGE = new Set(['claim_submitted', 'claim_under_review', 'claim_query', 'claim_approved', 'claim_partial', 'claim_rejected',
  'settlement_pending', 'settled']);
const APPROVED = new Set(['claim_approved', 'claim_partial', 'settlement_pending', 'settled']);
const CLOSED = new Set(['settled', 'closed', 'written_off']);

/** The cut the ledger shows: the insurer's cut, or a short payment with no reason yet (always a person's call). */
export function ledgerCut(c: Claim, m: CaseMoney | null): Cut & { short: boolean; won?: boolean } {
  const cut = cutOf(c, m);
  // fought and paid in full: nothing left to fight
  if (cut.state === 'fought' && cut.amount < 1) return { ...cut, amount: 0, state: 'none', needsDecision: false, short: false, won: true };
  const shortPaid = !!m && m.allocated > 0 && m.balance > 1 && cut.state !== 'fought' && c.status !== 'settled';
  if (shortPaid && !cut.needsDecision) {
    // paid less than approved: nothing closes until someone accepts or fights it, whatever the size
    return { amount: Math.max(cut.amount, Math.round(m!.balance * 100) / 100), state: 'pending', needsDecision: true, decidedAt: cut.decidedAt, short: true };
  }
  return { ...cut, short: false };
}

/** Which cell the step's next move belongs to. */
export function stepColumn(step: Step): ColKey | null {
  switch (step.key) {
    case 'send_preauth': return 'pa_sent';
    case 'wait_preauth': case 'answer_preauth_query': case 'preauth_rejected': return 'pa_ok';
    case 'in_hospital_approved': return 'disch';
    case 'send_claim': return 'cl_sent';
    case 'wait_claim': case 'answer_claim_query': case 'claim_rejected': return 'cl_ok';
    case 'wait_payment': return 'paid';
    default: return null;
  }
}

export interface LedgerRow {
  j: Journey;
  cells: Record<ColKey, Cell>;
  /** The reminder: what to do next, or what to chase. */
  next: { text: string; due: string | null; late: boolean; ours: boolean; done: boolean };
  cut: Cut & { short: boolean; won?: boolean };
}

export function ledgerRow(j: Journey, canWrite: boolean, now = new Date()): LedgerRow {
  const { c, step, money: m } = j;
  const closed = CLOSED.has(c.status) && !(j.stage === 'payment');
  const cut = ledgerCut(c, m);
  const col = closed ? null : cut.needsDecision ? 'cut' : stepColumn(step);
  const w = canWrite && !closed;
  const mark = (key: ColKey, done: boolean, can: boolean): CellState =>
    done ? 'done'
      : col === key ? (step.ours || key === 'cut' ? 'ours' : key === 'disch' ? 'open' /* in hospital: nothing due */ : 'theirs')
      : can ? 'open' : 'blank';

  const corporate = c.claim_type === 'corporate' || c.claim_type === 'reimbursement';
  const discharged = c.discharged_at ?? c.discharge_date ?? null;
  const preauthSent = !!c.preauth_submitted_at;
  const inClaim = CLAIM_STAGE.has(c.status) || CLOSED.has(c.status);
  const skippedPreauth = !preauthSent && (corporate || inClaim || !!discharged);

  // pre-auth sent
  const paSent: Cell = skippedPreauth
    ? { key: 'pa_sent', state: 'na', text: corporate ? 'Not applicable' : 'Not taken', editable: false }
    : { key: 'pa_sent', state: mark('pa_sent', preauthSent, false), text: preauthSent ? dd(c.preauth_submitted_at) : '',
        sub: c.tpa_preauth_number ?? undefined, editable: w && col === 'pa_sent' };

  // pre-auth decision
  const paAmt = c.preauth_approved_amount ?? (PREAUTH_DONE.has(c.status) ? c.approved_amount : null);
  const paDone = paAmt != null || PREAUTH_DONE.has(c.status);
  const canEnhance = w && PREAUTH_DONE.has(c.status);
  const paText = c.status === 'preauth_query' ? 'Query' : c.status === 'preauth_rejected' ? 'Rejected'
    : paDone ? rs(paAmt) || 'Approved' : c.status === 'preauth_pending' ? 'Awaiting' : '';
  const paOk: Cell = skippedPreauth
    ? { key: 'pa_ok', state: 'na', text: '', editable: false }
    : { key: 'pa_ok', state: col === 'pa_ok' ? mark('pa_ok', false, false) : mark('pa_ok', paDone, false), text: paText,
        // until the claim is submitted, an enhancement (or a further one) can be entered here
        sub: canEnhance ? (c.status === 'preauth_enhanced' ? 'Enhanced · + add more' : '+ Add enhancement') : c.status === 'preauth_enhanced' ? 'Enhanced' : undefined,
        tone: c.status === 'preauth_query' || c.status === 'preauth_rejected' ? 'alert' : undefined,
        editable: w && (col === 'pa_ok' || canEnhance) };

  // discharge: can be typed any time before the claim goes
  const canDischarge = !inClaim && !CLOSED.has(c.status) && c.status !== 'preauth_rejected';
  const disch: Cell = { key: 'disch', state: mark('disch', !!discharged, w && canDischarge), text: discharged ? dd(discharged) : '',
    editable: w && canDischarge };

  // claim sent
  const clDone = !!c.submitted_at || inClaim;
  const clSent: Cell = { key: 'cl_sent', state: mark('cl_sent', clDone, false), text: clDone ? dd(c.submitted_at) || 'Submitted' : '',
    sub: c.claimed_amount != null && clDone ? rs(c.claimed_amount) : undefined, editable: w && col === 'cl_sent' };

  // claim decision
  const clOkDone = APPROVED.has(c.status) || (c.status === 'closed' && c.approved_amount != null && inClaim);
  const clText = c.status === 'claim_query' ? 'Query' : c.status === 'claim_rejected' ? 'Rejected'
    : clOkDone ? rs(c.approved_amount) : ['claim_submitted', 'claim_under_review'].includes(c.status) ? 'Awaiting' : '';
  const approvalCut = clOkDone && c.claimed_amount != null && c.approved_amount != null && Number(c.claimed_amount) > Number(c.approved_amount)
    ? Number(c.claimed_amount) - Number(c.approved_amount) : 0;
  const clOk: Cell = { key: 'cl_ok', state: col === 'cl_ok' ? mark('cl_ok', false, false) : mark('cl_ok', clOkDone, false), text: clText,
    sub: approvalCut >= 1 ? `${rs(approvalCut)} deducted` : undefined,
    tone: c.status === 'claim_query' || c.status === 'claim_rejected' ? 'alert' : undefined, editable: w && col === 'cl_ok' };

  // received
  const got = m?.allocated ?? (c.status === 'settled' ? Number(c.settled_amount ?? 0) : 0);
  const moreDue = !!m && m.balance > 1 && APPROVED.has(c.status) && c.status !== 'settled';
  // more recorded than approved: almost always a typing error (net entered as the gross amount)
  const excess = !!m && m.balance < -1 && c.status !== 'settled' ? -m.balance : 0;
  const paid: Cell = { key: 'paid', state: excess ? 'ours' : col === 'paid' ? mark('paid', false, false) : got > 0 ? 'done' : mark('paid', false, false),
    text: got > 0 ? rs(got) : col === 'paid' ? 'Awaiting' : '',
    sub: excess ? `${rs(excess)} excess — review`
      : got > 0 ? [m && m.tds ? `TDS ${rs(m.tds)}` : '', moreDue ? `${rs(m!.balance)} outstanding` : ''].filter(Boolean).join(' · ') || undefined : undefined,
    tone: excess ? 'alert' : undefined,
    editable: w && APPROVED.has(c.status) && c.status !== 'settled' && (got === 0 || moreDue || excess > 0) };

  // cut
  const cutCell: Cell = cut.won
    ? { key: 'cut', state: 'done', text: 'Recovered', sub: 'Paid in full after dispute', editable: false }
    : cut.state === 'none'
    ? { key: 'cut', state: CLOSED.has(c.status) || got > 0 ? 'done' : 'blank', text: CLOSED.has(c.status) || got > 0 ? 'Nil' : '', editable: false }
    : { key: 'cut', state: cut.needsDecision ? 'ours' : 'done', text: rs(cut.amount),
        sub: cut.needsDecision ? 'Accept or dispute' : cut.state === 'fought' ? 'Disputed' : cut.state === 'accepted' ? 'Accepted' : `Below ${rs(CUT_FLOOR)}`,
        tone: cut.needsDecision ? 'alert' : cut.state === 'fought' ? 'warn' : undefined,
        editable: canWrite && c.status !== 'closed' && c.status !== 'written_off' && (cut.needsDecision || cut.state === 'fought' || (cut.state === 'pending' && c.status === 'settled')) };

  const patient: Cell = { key: 'patient', state: 'done', text: c.patient_name, sub: [c.admission_ref, dd(c.admitted_at ?? c.admission_date)].filter(Boolean).join(' · '),
    editable: true };

  // the reminder
  let next: LedgerRow['next'];
  if (c.status === 'written_off') next = { text: 'Written off', due: null, late: false, ours: false, done: true };
  else if (c.status === 'closed') next = { text: c.preauth_submitted_at && !inClaim ? 'Closed — self-pay' : 'Closed', due: null, late: false, ours: false, done: true };
  else if (c.status === 'settled' && !cut.needsDecision && cut.state !== 'fought') next = { text: 'Settled & closed', due: null, late: false, ours: false, done: true };
  else if (excess) next = { text: `Excess of ${rs(excess)} recorded — review the settlement entry`, due: null, late: false, ours: true, done: false };
  else {
    const due = dueText(step, now);
    next = { text: step.label, due: due ? (step.overdue && !step.ours ? `Follow up — ${due}` : due) : null,
      late: step.overdue, ours: step.ours, done: false };
  }

  return { j, cut, next, cells: { patient, pa_sent: paSent, pa_ok: paOk, disch, cl_sent: clSent, cl_ok: clOk, paid, cut: cutCell } };
}

// ─── Filters ────────────────────────────────────────────────────────
export type Filter = 'open' | 'mine' | 'chase' | 'cuts' | 'closed';
export const FILTERS: { key: Filter; label: string }[] = [
  { key: 'open', label: 'All open' },
  { key: 'mine', label: 'Action due' },
  { key: 'chase', label: 'Follow-up overdue' },
  { key: 'cuts', label: 'Deductions & disputes' },
  { key: 'closed', label: 'Closed' },
];

export function inFilter(r: LedgerRow, f: Filter): boolean {
  switch (f) {
    case 'open': return !r.next.done;
    case 'mine': return !r.next.done && r.next.ours;
    case 'chase': return !r.next.done && !r.next.ours && r.next.late;
    case 'cuts': return r.cut.needsDecision || r.cut.state === 'fought';
    case 'closed': return r.next.done;
  }
}

/** Late first, then our turn, then waiting on the insurer; oldest admission first. Closed: newest first. */
export function byReminder(a: LedgerRow, b: LedgerRow): number {
  const rank = (r: LedgerRow) => (r.next.done ? 9 : r.next.late ? (r.next.ours ? 0 : 1) : r.next.ours ? 2 : 3);
  const d = rank(a) - rank(b);
  if (d) return d;
  const t = (r: LedgerRow) => new Date(r.j.c.admitted_at ?? r.j.c.admission_date ?? r.j.c.created_at).getTime();
  return a.next.done ? t(b) - t(a) : t(a) - t(b);
}

// ─── Excel download ─────────────────────────────────────────────────
const esc = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const n = (v: number | null | undefined) => (v == null ? '' : Math.round(Number(v)));
const ymd = (d: string | null | undefined) => (d ? new Date(d.length === 10 ? `${d}T12:00:00+05:30` : d).toLocaleDateString('en-CA', { timeZone: IST }) : '');

export function toCsv(rows: LedgerRow[]): string {
  const head = ['Admission date', 'Patient', 'IP number', 'UHID', 'Payer', 'Pre-auth submitted', 'Pre-auth number', 'Pre-auth approved',
    'Discharge date', 'Claim submitted', 'Claim number', 'Claimed', 'Approved', 'Received', 'TDS', 'Outstanding', 'Deduction', 'Deduction status', 'Next action', 'Due'];
  const lines = rows.map(({ j: { c, money: m }, cut, next, cells }) => [
    ymd(c.admitted_at ?? c.admission_date), c.patient_name, c.admission_ref, c.patient_uhid, c.clm_payers?.name ?? c.sponsor_name,
    ymd(c.preauth_submitted_at), c.tpa_preauth_number, n(c.preauth_approved_amount), ymd(c.discharged_at ?? c.discharge_date),
    ymd(c.submitted_at), c.tpa_claim_number, n(c.claimed_amount), APPROVED.has(c.status) || c.status === 'closed' ? n(c.approved_amount) : '',
    m ? n(m.allocated) : '', m ? n(m.tds) : '', m ? n(m.balance) : '', cut.amount >= 1 ? n(cut.amount) : '', cells.cut.sub ?? '',
    next.text, next.due ?? '',
  ].map(esc).join(','));
  return '﻿' + [head.join(','), ...lines].join('\r\n');
}
