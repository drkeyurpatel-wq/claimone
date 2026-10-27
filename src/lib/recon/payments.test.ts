import { describe, expect, it } from 'vitest';
import { cellsToRows, cleanLetterLines, isPmjaySheet, parsePaymentSheet, parsePmjay, summarise } from './payments';

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

  it('an unpaid row has no UTR or payment date', () => {
    const { rows: out } = parsePmjay(rows);
    expect(out[1]).toMatchObject({ net_amount: 0, utr: null, payment_date: null, claimed_amount: 60390 });
    expect(summarise(out)).toEqual({ lines: 2, paid: 1, paidAmount: 3985, tds: 443, unpaid: 1 });
  });

  it('routes other sheets to the letter reader', () => {
    const tpa = cellsToRows([['Claim No', 'Patient Name', 'Approved', 'TDS', 'Deduction', 'Deduction Reason', 'Net Paid', 'UTR', 'Payment Date'],
      ['CL-1', 'Test C', 100000, 2000, 3000, 'Room rent', 95000, 'UTR1', '22/10/2026']]);
    const { rows: out } = parsePaymentSheet(tpa, 'Medi Assist');
    expect(out[0]).toMatchObject({ source: 'letter', claim_ref: 'CL-1', net_amount: 95000, deduction_reason: 'Room rent', payment_date: '2026-10-22', payer_name: 'Medi Assist' });
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
  it('tolerates non-arrays', () => expect(cleanLetterLines({})).toEqual([]));
});
