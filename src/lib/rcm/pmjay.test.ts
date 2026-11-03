import { describe, expect, it } from 'vitest';
import { isPmjaySheet, parsePmjay, pmjayAmount, pmjayDate, pmjayWarnings } from './pmjay';

const NOV = new Date('2026-11-03T06:00:00Z');
const D = (iso: string) => new Date(`${iso}T00:00:00Z`);
const HEAD = ['NO', 'CASE NO', 'PATIENT NAME\n', 'CARD NUMBER', 'CASE STATUS', 'DR NAME', 'DOA', 'DOD', 'CATEGORY', 'PROCEDURE NAME',
  'NABH', 'NO NABH', '\tIP NO', 'TPA', 'DISTRICT', 'UTR NUMBER', 'CALIM PAID DATE', 'FINAL AMOUNT', 'DED AMOUNT', 'REMARKS', 'PAYMENT DONE', 'TAT'];

describe('pmjayDate', () => {
  it('reads typed dates day-first', () => {
    expect(pmjayDate('29-10-2026', NOV)).toBe('2026-10-29');
    expect(pmjayDate('02/11/2026', NOV)).toBe('2026-11-02');
    expect(pmjayDate('2026-11-01', NOV)).toBe('2026-11-01');
    expect(pmjayDate('31-02-2026', NOV)).toBeNull();
    expect(pmjayDate('', NOV)).toBeNull();
  });
  it('undoes Excel reading 02/11 as 11 Feb', () => {
    expect(pmjayDate(D('2026-02-11'), NOV)).toBe('2026-11-02');
    expect(pmjayDate(D('2026-03-11'), NOV)).toBe('2026-11-03');
  });
  it('leaves a date that Excel read correctly alone', () => {
    expect(pmjayDate(D('2026-11-05'), NOV)).toBe('2026-11-05');
    expect(pmjayDate(D('2026-10-29'), NOV)).toBe('2026-10-29');
  });
});

describe('pmjayAmount', () => {
  it('reads numbers and typed amounts', () => {
    expect(pmjayAmount(4427.5)).toBe(4427.5);
    expect(pmjayAmount('₹ 91,714')).toBe(91714);
    expect(pmjayAmount('abc')).toBeNull();
    expect(pmjayAmount(null)).toBeNull();
  });
});

describe('parsePmjay', () => {
  const cells = [
    HEAD,
    [1, '2026102910013158', 'THAKOR DAHYIBEN\n', 'PZDC3DP68', 'Claims  Submitted', 'DR.SUNIL GURMUKHANI', '29-10-2026', D('2026-02-11'),
      'Cardiology', 'PTCA(MC011A-PTCA)', 91714, 86634, 'IPS1262407', null, 'AHMADABAD', null, null, null, null, null, null, null],
    [2, '2026110210084249', 'GOSWAMI K', 'PAPR7M12Y', null, 'DR.SUNIL GURMUKHANI', D('2026-02-11'), D('2026-03-11'),
      'Cardiology', 'CAG', 4427.5, 4025, ' ips1262457 ', null, null, 'UTR123456', '20-11-2026', 4000, 427.5, 'ok', null, null],
    [3, null, null, null, null, null, null, null, null, null, null, null, null],
  ];
  it('finds the sheet and maps NABH and NO NABH to the right fields', () => {
    expect(isPmjaySheet(cells)).toBe(true);
    const { rows } = parsePmjay(cells, NOV);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      ip_no: 'IPS1262407', patient_name: 'THAKOR DAHYIBEN', case_no: '2026102910013158', card_no: 'PZDC3DP68',
      case_status: 'Claims Submitted', admitted_on: '2026-10-29', discharged_on: '2026-11-02',
      nabh_amount: 91714, non_nabh_amount: 86634, utr: null, paid_amount: null,
    });
    expect(rows[1]).toMatchObject({ ip_no: 'IPS1262457', utr: 'UTR123456', paid_on: '2026-11-20', paid_amount: 4000, deduction: 427.5 });
  });
  it('is not fooled by other sheets', () => {
    expect(isPmjaySheet([['IP NO', 'PATIENT NAME', 'SPONSOR NAME']])).toBe(false);
  });
});

describe('pmjayWarnings', () => {
  it('flags zero amounts, swapped rates and payments without UTR', () => {
    const base = { ip_no: 'X', patient_name: 'P', case_no: 'C' as string | null, card_no: null, case_status: null, doctor: null, admitted_on: null,
      discharged_on: null, category: null, procedure: null, utr: null, paid_on: null, paid_amount: null, deduction: null, remarks: null };
    const w = pmjayWarnings([
      { ...base, ip_no: 'A', case_no: 'CA', nabh_amount: 0, non_nabh_amount: 0 },
      { ...base, ip_no: 'B', case_no: 'CB', nabh_amount: 14300, non_nabh_amount: 15730 },
      { ...base, ip_no: 'C', case_no: 'CC', nabh_amount: 100, non_nabh_amount: 90, paid_amount: 100 },
      { ...base, ip_no: 'D', case_no: 'CD', nabh_amount: 100, non_nabh_amount: 90 },
    ]);
    expect(w.map((x) => x.ip)).toEqual(['A', 'B', 'C']);
  });
  it('flags a missing or repeated case ID', () => {
    const base = { patient_name: 'P', card_no: null, case_status: null, doctor: null, admitted_on: null, discharged_on: null, category: null,
      procedure: null, nabh_amount: 100, non_nabh_amount: 90, utr: null, paid_on: null, paid_amount: null, deduction: null, remarks: null };
    const w = pmjayWarnings([
      { ...base, ip_no: 'A', case_no: null },
      { ...base, ip_no: 'B', case_no: 'C1' },
      { ...base, ip_no: 'E', case_no: 'C1' },
    ]);
    expect(w).toEqual([
      { ip: 'A', note: 'No PMJAY case ID — payments cannot be matched until it is filled' },
      { ip: 'E', note: 'Case ID C1 is also on IP B' },
    ]);
  });
});
