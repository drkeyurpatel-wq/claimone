import { describe, expect, it } from 'vitest';
import type { DeductionLine } from '@/lib/claims/types';
import { groupLines, inPeriod, linesCsv, reasonPending } from './deductions';

const line = (p: Partial<DeductionLine>): DeductionLine => ({
  centre_id: 'c1', centre_name: 'Shilaj', payer_id: 'p1', payer_name: 'PMJAY / MA (Gujarat)', claim_id: null, receivable_id: 'r1', adjustment_id: 'a1',
  patient_name: 'Pt', claim_ref: '2026110110000011', doctor_name: '—', speciality: 'Urology', procedure_code: 'SU041A', procedure_name: 'Cystolithotripsy',
  kind: 'deduction', category: 'unspecified', reason_text: null, is_preventable: false, on_date: '2026-11-12', file_date: '2026-11-03', amount: 1650, ...p });

describe('deductions MIS', () => {
  const lines = [
    line({}),
    line({ adjustment_id: 'a2', amount: 8332, speciality: 'Medical Oncology', procedure_code: 'MO024A', procedure_name: 'Chemo', category: 'tariff_excess', is_preventable: true }),
    line({ adjustment_id: 'a3', amount: 350, doctor_name: 'DR KALPESH C PATEL', category: 'doc_missing', is_preventable: true }),
    line({ adjustment_id: 'a4', amount: 650, doctor_name: 'Dr. Kalpesh C Patel', centre_id: 'c2', centre_name: 'Vastral', on_date: '2026-06-02', file_date: '2026-06-01' }),
  ];

  it('groups by reason, speciality, procedure, consultant and centre, largest first, with shares', () => {
    const byReason = groupLines(lines, 'reason');
    expect(byReason.map((r) => [r.label, r.cases, r.amount])).toEqual([
      ['Package rate / tariff difference', 1, 8332], ['Reason not entered', 2, 2300], ['Missing documents', 1, 350]]);
    expect(Math.round(byReason[0].share * 100)).toBe(76);
    expect(groupLines(lines, 'speciality').map((r) => [r.label, r.amount])).toEqual([['Medical Oncology', 8332], ['Urology', 2650]]);
    expect(groupLines(lines, 'procedure')[1]).toMatchObject({ label: 'SU041A', sub: 'Cystolithotripsy', cases: 3, amount: 2650 });
    expect(groupLines(lines, 'centre').map((r) => [r.label, r.amount])).toEqual([['Shilaj', 10332], ['Vastral', 650]]);
  });

  it('puts one consultant under one name however it was typed, and the rest under Not recorded', () => {
    expect(groupLines(lines, 'doctor').map((r) => [r.label, r.cases, r.amount])).toEqual([['Not recorded', 2, 9982], ['Dr Kalpesh C Patel', 2, 1000]]);
  });

  it('keeps the period to whole months', () => {
    expect(inPeriod(lines, 3, new Date('2026-11-13T10:00:00+05:30'))).toHaveLength(3);
    expect(inPeriod(lines, 6, new Date('2026-11-13T10:00:00+05:30'))).toHaveLength(4);
  });

  it('lists files from 1 Nov whose deduction has no reason yet — not older files, not disputed ones', () => {
    expect(reasonPending(lines).map((r) => r.adjustment_id)).toEqual(['a1']);
    expect(reasonPending([line({ kind: 'fighting' })])).toHaveLength(0);
  });

  it('exports every line with the case ID kept whole for Excel', () => {
    const csv = linesCsv(lines).split('\n');
    expect(csv).toHaveLength(5);
    expect(csv[1]).toContain('"=""2026110110000011"""');
    expect(csv[1]).toContain('Reason not entered');
  });
});
