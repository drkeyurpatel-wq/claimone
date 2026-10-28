import { describe, expect, it } from 'vitest';
import { byUrgency, dueText, nextStep, type CaseLike } from './worklist';

const now = new Date('2026-10-28T12:00:00+05:30');
const base: CaseLike = { status: 'draft', claim_type: 'cashless', updated_at: '2026-10-28T08:00:00+05:30', created_at: '2026-10-28T08:00:00+05:30' };

describe('next step for a case', () => {
  it('a new cashless admission goes to the admission desk to send pre-auth', () => {
    const s = nextStep({ ...base, admitted_at: '2026-10-28T09:00:00+05:30' }, now);
    expect(s).toMatchObject({ desk: 'admission', key: 'send_preauth', ours: true, overdue: false });
    expect(dueText(s, now)).toBe('in 3 h');
  });
  it('PMJAY pre-auth is filed in TMS', () => {
    expect(nextStep({ ...base, claim_type: 'pmjay' }, now).label).toBe('File pre-auth in TMS');
  });
  it('pre-auth unanswered after an hour is late for an insurer, not for PMJAY', () => {
    const c = { ...base, status: 'preauth_pending' as const, preauth_submitted_at: '2026-10-28T10:00:00+05:30' };
    expect(nextStep(c, now)).toMatchObject({ key: 'wait_preauth', ours: false, overdue: true });
    expect(nextStep({ ...c, claim_type: 'pmjay' }, now).overdue).toBe(false);
  });
  it('approved and still in hospital: nothing to do, but flags an estimate above the approval', () => {
    const s = nextStep({ ...base, status: 'preauth_approved', estimated_amount: 200000, approved_amount: 150000 }, now);
    expect(s).toMatchObject({ desk: 'admission', key: 'in_hospital_approved', ours: false });
    expect(s.label).toMatch(/enhancement/);
  });
  it('discharged after approval moves to the claims desk, 3 hours for an insurer', () => {
    const s = nextStep({ ...base, status: 'preauth_approved', discharged_at: '2026-10-28T08:30:00+05:30' }, now);
    expect(s).toMatchObject({ desk: 'claims', key: 'send_claim', overdue: true });
  });
  it('a corporate (PGVCL) case skips pre-auth: in hospital, then billed after discharge', () => {
    expect(nextStep({ ...base, claim_type: 'corporate' }, now)).toMatchObject({ key: 'in_hospital_approved', ours: false });
    expect(nextStep({ ...base, claim_type: 'corporate', discharged_at: '2026-10-28T09:00:00+05:30' }, now)).toMatchObject({ desk: 'claims', key: 'send_claim' });
  });
  it('approved claims wait for money on the payments side', () => {
    expect(nextStep({ ...base, status: 'claim_partial' }, now)).toMatchObject({ desk: 'payment', key: 'wait_payment' });
  });
  it('settled and closed cases are done', () => {
    expect(nextStep({ ...base, status: 'settled' }, now).desk).toBe('done');
    expect(nextStep({ ...base, status: 'closed' }, now).desk).toBe('done');
  });
  it('date-only admission dates are read as IST midnight', () => {
    const s = nextStep({ ...base, admission_date: '2026-10-28' }, now);
    expect(s.dueAt?.toISOString()).toBe('2026-10-28T00:30:00.000Z');
  });
});

describe('sorting a desk', () => {
  it('our late work, then our work, then late waiting cases, then the rest', () => {
    const mk = (status: CaseLike['status'], at: string, extra: Partial<CaseLike> = {}) =>
      ({ id: status + at, step: nextStep({ ...base, status, updated_at: at, preauth_submitted_at: at, admitted_at: at, ...extra }, now) });
    const list = [
      mk('preauth_pending', '2026-10-28T11:30:00+05:30'),         // waiting, not late
      mk('preauth_pending', '2026-10-28T09:00:00+05:30'),         // waiting, late → chase
      mk('draft', '2026-10-28T11:00:00+05:30'),                   // ours, not late
      mk('preauth_query', '2026-10-28T06:00:00+05:30'),           // ours, late
    ].sort(byUrgency);
    expect(list.map((x) => x.step.key)).toEqual(['answer_preauth_query', 'send_preauth', 'wait_preauth', 'wait_preauth']);
    expect(list[2].step.overdue).toBe(true);
  });
});
