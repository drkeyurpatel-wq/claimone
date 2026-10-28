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
