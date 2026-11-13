import { describe, expect, it } from 'vitest';
import { cellsToRows, cleanLetterLines, isPmjaySheet, isTmsSheet, parsePaymentSheet, parsePmjay, parseTms, sheetDate, summarise } from './payments';
import { detectKind } from './detect';

const HEAD = ['S.No.', 'Invoice No.', 'Inv. Date', 'IP No.', 'Reg. No.', 'Patient Name', 'DOA', 'DOD', 'Letter No.', 'Doctor Name',
  'Credit Limit', 'Pending', 'TDS Amount', 'Claim Paid Amount', 'UTR', 'Payment Date'];

describe('PMJAY settlement sheet', () => {
  const cells = [
    HEAD,
    [1, 'IPB126/569', '05/05/2026', 'IPS1', 'H1-01/3386', 'Test A', '04/05/2026', '05/05/2026', 2026050410019520, 'Dr X', 4427.5, 4427.5, 443, 3985, 'AXISCN1377079391', new Date(Date.UTC(2026, 5, 16))],
    [2, 'IPB126/570', '06/05/2026', 'IPS2', 'H1S-1', 'Test B', '04/05/2026', '06/05/2026', 2026050410015120, 'Dr Y', 60390, 60390, 0, 0, '', new Date(Date.UTC(2026, 5, 16))],
    [null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
  ];
  const rows = cellsToRows(cells);

  it('recognises the sheet', () => expect(isPmjaySheet(rows)).toBe(true));

  it('keeps all 16 digits of the case ID and reads amounts and dates', () => {
    const { rows: out } = parsePmjay(rows);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      source: 'pmjay', bill_no: 'IPB126/569', claim_ref: '2026050410019520', claimed_amount: 4427.5, tds_amount: 443,
      net_amount: 3985, utr: 'AXISCN1377079391', payment_date: '2026-06-16', bill_date: '2026-05-05', uhid: 'H1-01/3386',
    });
  });

  it('reads a deduction and its reason when the sheet has them', () => {
    const r = parsePmjay(cellsToRows([[...HEAD, 'Deduction Amount', 'Deduction Remarks'],
      [1, 'IPB126/600', '05/05/2026', 'IPS9', 'R9', 'Test D', '', '', 2026050410099999, 'Dr X', 50000, 50000, 0, 48000, 'UTR9', '20/05/2026', 2000, 'Implant not covered'],
      [2, 'IPB126/601', '05/05/2026', 'IPS8', 'R8', 'Test E', '', '', 2026050410088888, 'Dr X', 9000, 9000, 0, 9000, 'UTR8', '20/05/2026', 0, '']]));
    expect(r.rows[0]).toMatchObject({ net_amount: 48000, deduction_amount: 2000, deduction_reason: 'Implant not covered' });
    expect(r.rows[1]).toMatchObject({ deduction_amount: 0, deduction_reason: null });
  });

  it('an unpaid row has no UTR or payment date', () => {
    const { rows: out } = parsePmjay(rows);
    expect(out[1]).toMatchObject({ net_amount: 0, utr: null, payment_date: null, claimed_amount: 60390 });
    expect(summarise(out)).toEqual({ lines: 2, paid: 1, paidAmount: 3985, tds: 443, unpaid: 1 });
  });

  it('a case with several invoices is one payment, not one per row', () => {
    const r = parsePmjay(cellsToRows([HEAD,
      [1, 'IPB126/11', '01/04/2026', 'DIP-1', 'R1', 'Test G', '', '', 2026040410000001, 'Dr X', 2420, 2420, 1452, 13068, 'AXISCN9', new Date(Date.UTC(2026, 4, 1))],
      [2, 'IPB126/90', '06/04/2026', 'DIP-2', 'R1', 'Test G', '', '', 2026040410000001, 'Dr X', 2420, 2420, 1452, 13068, 'AXISCN9', new Date(Date.UTC(2026, 4, 1))],
      [3, 'IPB126/95', '07/04/2026', 'DIP-3', 'R2', 'Test H', '', '', 2026040410000002, 'Dr X', 5000, 5000, 100, 4900, 'AXISCN9', new Date(Date.UTC(2026, 4, 1))],
    ]));
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ claim_ref: '2026040410000001', bill_no: null, net_amount: 13068, tds_amount: 1452, claimed_amount: 4840 });
    expect(r.rows[0].bills?.map((b) => b.bill_no)).toEqual(['IPB126/11', 'IPB126/90']);
    expect(summarise(r.rows).paidAmount).toBe(13068 + 4900);
  });

  it('a case with one more unpaid invoice is still one payment, never one per row', () => {
    const r = parsePmjay(cellsToRows([HEAD,
      [1, 'Q1', '01/10/2026', 'I1', 'R1', 'T', '', '', 7770000000000001, 'Dr', 2420, 2420, 96.8, 4743.2, 'U77', new Date(Date.UTC(2026, 9, 20))],
      [2, 'Q2', '02/10/2026', 'I2', 'R1', 'T', '', '', 7770000000000001, 'Dr', 2420, 2420, 96.8, 4743.2, 'U77', new Date(Date.UTC(2026, 9, 20))],
      [3, 'Q3', '03/10/2026', 'I3', 'R1', 'T', '', '', 7770000000000001, 'Dr', 2420, 2420, 0, 0, '', new Date(Date.UTC(2026, 9, 20))],
    ]));
    expect(r.rows).toHaveLength(2);
    expect(summarise(r.rows).paidAmount).toBe(4743.2);
    expect(r.rows[0].bills?.map((b) => b.bill_no)).toEqual(['Q1', 'Q2']);
    expect(r.rows[1]).toMatchObject({ net_amount: 0, bill_no: 'Q3' });
  });

  it('routes other sheets to the letter reader', () => {
    const tpa = cellsToRows([['Claim No', 'Patient Name', 'Approved', 'TDS', 'Deduction', 'Deduction Reason', 'Net Paid', 'UTR', 'Payment Date'],
      ['CL-1', 'Test C', 100000, 2000, 3000, 'Room rent', 95000, 'UTR1', '22/10/2026']]);
    const { rows: out } = parsePaymentSheet(tpa, 'Medi Assist');
    expect(out[0]).toMatchObject({ source: 'letter', claim_ref: 'CL-1', net_amount: 95000, deduction_reason: 'Room rent', payment_date: '2026-10-22', payer_name: 'Medi Assist' });
  });
});

describe('credit master Bills tab', () => {
  const rows = cellsToRows([
    ['Sr', 'Payer category', 'UHID', 'IP no', 'Patient name', 'Treating doctor', 'Bill no', 'Bill date', 'Insurer / payer', 'TPA', 'Claim no', 'Approved', 'Received from payer', 'Payment date', 'UTR', 'TDS', 'Short-pay reason'],
    [1, 'TPA / Insurance', '', 'IPS1', 'Test D', 'Dr Z', 'IPB125/4867', '03/03/2026', 'New India Assurance', 'GENINS INDIA', '', 320534, 300000, '14/03/2026', 'AXISCN1', null, 'Room rent'],
    [2, 'TPA / Insurance', '', 'IPS2', 'Test E', 'Dr Z', 'IPB125/4868', '04/03/2026', 'Tata AIG', 'TATA AIG', 'CL9', 90000, null, null, null, null, null],
    [3, 'Patient / doctor due', '', 'IPS3', 'Test F', 'Dr Z', 'CR-1', '04/03/2026', '', '', '', 5000, null, null, null, null, null],
  ]);
  it('reads paid, short-with-reason and unpaid bills; leaves out patient dues', () => {
    const r = parsePaymentSheet(rows);
    expect(r.skipped).toBe(1);
    expect(r.rows[0]).toMatchObject({ bill_no: 'IPB125/4867', approved_amount: 320534, net_amount: 300000, deduction_amount: 20534, deduction_reason: 'Room rent', payment_date: '2026-03-14' });
    expect(r.rows[1]).toMatchObject({ claim_ref: 'CL9', net_amount: 0, utr: null, approved_amount: 90000 });
  });
  it('claimed = total bill − discount − paid by patient, so a cut at approval shows', () => {
    const r = parsePaymentSheet(cellsToRows([
      ['Bill no', 'Payer category', 'Insurer / payer', 'Total bill', 'Discount', 'Paid by patient', 'Approved', 'Received from payer', 'TDS', 'Bill date'],
      ['B1', 'TPA / Insurance', 'Tata AIG', 100000, 0, 0, 80000, 78400, 1600, '01/10/2026'],
      ['B2', 'TPA / Insurance', 'Tata AIG', 375250, 45266, 9450, 320534, 320534, null, '01/10/2026'],
    ]));
    expect(r.rows[0]).toMatchObject({ claimed_amount: 100000, approved_amount: 80000 });
    expect(r.rows[1]).toMatchObject({ claimed_amount: 320534 });
  });
});

describe('lines read off a letter', () => {
  it('fills net from approved − TDS and drops lines with no claim or bill no', () => {
    const out = cleanLetterLines([
      { claim_ref: 'RC-1', approved_amount: '1,00,000', tds_amount: 2000, payment_date: '23/10/2026', payer_name: 'HDFC ERGO' },
      { patient_name: 'no ref', net_amount: 500 },
      'junk',
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ claim_ref: 'RC-1', net_amount: 98000, payment_date: '2026-10-23' });
  });
  it('makes amounts positive and clips long text so one line cannot block an upload', () => {
    const out = cleanLetterLines([{ claim_ref: 'RC-2', net_amount: 900, deduction_amount: '-500', deduction_reason: 'x'.repeat(900) }]);
    expect(out[0].deduction_amount).toBe(500);
    expect(out[0].deduction_reason).toHaveLength(300);
  });
  it('tolerates non-arrays', () => expect(cleanLetterLines({})).toEqual([]));
});

describe('PMJAY claim-paid sheet from TMS', () => {
  const TMS = ['Registration ID', 'Program ID', 'Beneficiary Name', 'Case Type', 'Preauth Initiated Date', 'Speciality Code', 'Category Details',
    'Procedure Code', 'Procedure Details', 'Hospital Name', 'Preauth Approved Amount', 'Claim Initiated Amount', 'Claim Approved Amount', 'Case Status',
    'Hospital Account Number', 'Hospital PAN Number', 'Hospital IFSC Number', 'TDS Amount', 'Claim Paid Amount', 'UTR', 'Payment Date'];
  const row = (id: string, cat: string, code: string, claimed: number, approved: number, status: string, tds: number, paid: number, utr: string) =>
    [id, 'P1M0ACSL8', 'Test Patient', 'SURGICAL', new Date(Date.UTC(2026, 9, 24, 10, 32, 37)), 'SU|SU', cat, code, 'DJ stenting  including cystoscopy|TURBT',
      'HEALTH1 SUPER SPECILAITY HOSPITAL ', claimed, claimed, approved, status, '0945694616', 'AAFCH8691E', 'KKBK0002582', tds, paid, utr, new Date(Date.UTC(2026, 10, 11))];
  const cells = [
    TMS,
    row('2026102210025087', 'Urology|Urology', 'SU033A|SU055A', 40040, 40040, 'Payment Accomplished', 801, 39239, 'AXISCN1531069395'),
    row('2026070610032013', 'Cardio-thoracic & Vascular surgery', 'SV001A', 344865, 254830, 'Claim CRC Insurance Rejected By CRC', 5097, 249733, 'UTIBR72026100600038009'),
    row('1020867220', 'Cardiology', 'MC011A', 91714, 91714, 'Payment Accomplished', 9171, 82543, 'PUNBQ26205495087'),
    row('2026040210047037', 'Urology', 'SU041A', 3300, 1650, 'Payment Accomplished', 33, 1617, 'AXISCN1'),
    row('2026040210047038', 'Urology', 'SU041A', 3300, 3300, 'Payment Accomplished', 66, 3234, 'AXISCN2'),
    row('2026102210025087', 'Urology', 'SU033A', 40040, 40040, 'Payment Accomplished', 801, 39239, 'AXISCN1531069395'),
    row('', 'Urology', 'SU033A', 100, 100, 'Payment Accomplished', 2, 98, 'X'),
  ];
  const rows = cellsToRows(cells);

  it('is recognised as a payment file, ahead of every other reader', () => {
    expect(isTmsSheet(rows)).toBe(true);
    expect(isPmjaySheet(rows)).toBe(false);
    expect(detectKind(rows, cells)).toBe('payments');
    expect(parsePaymentSheet(rows).rows[0].format).toBe('tms');
  });

  it('reads one line per case: case ID as text, claimed, approved, TDS, paid, UTR and dates', () => {
    const { rows: out, skipped } = parseTms(rows);
    expect(out).toHaveLength(5);
    expect(skipped).toBe(2); // the repeated case and the row with no case ID
    expect(out[0]).toMatchObject({ source: 'pmjay', format: 'tms', claim_ref: '2026102210025087', bill_no: null, patient_name: 'Test Patient',
      bill_date: '2026-10-24', claimed_amount: 40040, approved_amount: 40040, tds_amount: 801, net_amount: 39239, deduction_amount: 0,
      deduction_reason: null, utr: 'AXISCN1531069395', payment_date: '2026-11-11' });
    expect(out[2].claim_ref).toBe('1020867220');
  });

  it('joins repeated specialities and several procedures', () => {
    const { rows: out } = parseTms(rows);
    expect(out[0].speciality).toBe('Urology');
    expect(out[0].procedure_code).toBe('SU033A + SU055A');
    expect(out[0].procedure_name).toBe('DJ stenting including cystoscopy + TURBT');
  });

  it('takes claimed − approved as the deduction and keeps a rejected-appeal status as its remark', () => {
    const { rows: out } = parseTms(rows);
    expect(out[1]).toMatchObject({ deduction_amount: 90035, deduction_reason: 'Claim CRC Insurance Rejected By CRC', net_amount: 249733 });
    expect(out[3]).toMatchObject({ deduction_amount: 1650, deduction_reason: null });
  });

  it('marks which 16-digit case IDs are safe to match after an old sheet dropped the last digit', () => {
    const { rows: out } = parseTms(rows);
    expect(out[0].unique15).toBe(true);
    expect(out[2].unique15).toBe(false); // 10-digit ID: nothing was lost
    expect(out[3].unique15).toBe(false); // …7037 and …7038 share 15 digits
    expect(out[4].unique15).toBe(false);
  });

  it('reads dates that Excel hands over as day numbers (as the real download does)', () => {
    expect(sheetDate('46338')).toBe('2026-11-12');
    expect(sheetDate('46331.6771296296')).toBe('2026-11-05');
    expect(sheetDate('2026-11-12')).toBe('2026-11-12');
    expect(sheetDate('12/11/2026')).toBe('2026-11-12');
    const r = cellsToRows([TMS, ['2026110410056194', 'P1', 'Pt', 'MEDICAL', 46331.6771296296, 'MO', 'Medical Oncology', 'MO024A', 'Chemo', 'H', 15070, 15070, 15070,
      'Payment Accomplished', '0945694616', 'P', 'I', 301, 14769, 'AXISCN1531192485', 46338]]);
    expect(parseTms(r).rows[0]).toMatchObject({ bill_date: '2026-11-05', payment_date: '2026-11-12' });
  });

  it('a 16-digit case ID typed as a number still keeps its first 15 digits', () => {
    const r = cellsToRows([TMS, [2026102210025087, ...row('x', 'Urology', 'SU033A', 100, 100, 'Payment Accomplished', 2, 98, 'U').slice(1)]]);
    expect(parseTms(r).rows[0].claim_ref!.slice(0, 15)).toBe('202610221002508');
  });
});
