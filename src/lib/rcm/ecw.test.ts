import { describe, expect, it } from 'vitest';
import { cleanDoctor, ecwDateTime, isEcwSheet, parseEcw, summariseEcw } from './ecw';

const HEAD = ['Admission Date & Time', 'Intimated Date & Time', 'Invoice Date & Time', 'Net Amount', 'S.No.', 'Registration No.', 'IP No.',
  'Patient Name', 'Discharge Date', 'Bill No', 'Admitted Under Doctor.', 'Sponsor Name', 'Bill Amount', 'Discount Amount', 'Mobile No.',
  'Specialisation', 'Billing Category', 'Estimated Amount', 'Credit Limit', 'Paid Amount'];

const cells = [
  ['September 2026 IPD report'],
  HEAD,
  ['30/09/2026 14:41:01', '30/09/2026 18:20:33', '30/09/2026 19:05:44', 7130, 1, 740735726432, 'DIP-1', 'Test A', '30/09/2026 07:05 PM',
    'IPB126/1', 'Dr. Test Doc Health One Team', 'PMJAY', 7130, 0, 9000000000, 'Medical Oncology', 'DAY CARE', 0, 7130, 0],
  ['29/09/2026 10:00:00', '', '', null, 2, 'H1S-2', 'IPS-2', 'Test B', '', '', 'Dr. Other', 'MEDI ASSIST', null, null, '', 'Cardiology', 'ICU', 250000, null, null],
  ['28/09/2026 09:00:00', '', '30/09/2026 11:00:00', 96000, 3, 'H1S-3', 'IPS-3', 'Test C', '30/09/2026 11:00 AM', 'IPB126/3', 'Dr X', 'CASH', 96366, 366, '', '', '', 0, null, 96000],
  [null, null, null, null, null, null, null, null],
  ['', '', '', 1, 4, '', '', 'No IP', '', '', '', 'PMJAY'],
];

describe('eCW daily export', () => {
  it('finds the header below a title row', () => expect(isEcwSheet(cells)).toBe(true));
  it('does not take a payment sheet for an eCW export', () => expect(isEcwSheet([['Claim No', 'Patient Name', 'UTR']])).toBe(false));

  const { rows, skipped } = parseEcw(cells);
  it('reads one row per admission and skips rows without an IP No.', () => {
    expect(rows).toHaveLength(3);
    expect(skipped).toBe(1);
  });
  it('a discharged PMJAY day-care case with its bill', () => {
    expect(rows[0]).toMatchObject({
      ip_no: 'DIP-1', uhid: '740735726432', admitted_at: '2026-09-30T14:41:00+05:30', discharged_at: '2026-09-30T19:05:00+05:30',
      bill_no: 'IPB126/1', bill_date: '2026-09-30', sponsor: 'PMJAY', doctor: 'Dr. Test Doc', net_amount: 7130, estimated_amount: 7130,
      phone: '9000000000',
    });
  });
  it('a patient still in hospital has no bill or discharge', () => {
    expect(rows[1]).toMatchObject({ ip_no: 'IPS-2', discharged_at: null, bill_no: null, net_amount: null, estimated_amount: 250000 });
  });
  it('cash rows are passed on; the database decides what is credit', () => {
    expect(rows[2]).toMatchObject({ sponsor: 'CASH', discharged_at: '2026-09-30T11:00:00+05:30', paid_amount: 96000 });
  });
  it('keeps the billed row when an admission appears twice', () => {
    const twice = parseEcw([HEAD, cells[3], [...cells[3].slice(0, 9), 'IPB126/9', ...cells[3].slice(10)]]);
    expect(twice.rows).toHaveLength(1);
    expect(twice.rows[0].bill_no).toBe('IPB126/9');
    expect(twice.duplicates).toBe(1);
  });
  it('summarises for the upload screen', () => {
    expect(summariseEcw(rows)).toMatchObject({ admissions: 3, discharged: 2, inHouse: 1 });
  });
});

describe('dates and names', () => {
  it('reads eCW date formats as IST', () => {
    expect(ecwDateTime('01/10/2026 12:05 AM')).toBe('2026-10-01T00:05:00+05:30');
    expect(ecwDateTime('01/10/2026 12:05 PM')).toBe('2026-10-01T12:05:00+05:30');
    expect(ecwDateTime('5/1/2026')).toBe('2026-01-05T00:00:00+05:30');
    expect(ecwDateTime(new Date(Date.UTC(2026, 9, 2, 15, 30)))).toBe('2026-10-02T15:30:00+05:30');
    expect(ecwDateTime('31/13/2026')).toBeNull();
    expect(ecwDateTime('soon')).toBeNull();
  });
  it('drops the "Health One Team" suffix', () => expect(cleanDoctor('Dr. A B Health One Team')).toBe('Dr. A B'));
});
