import { describe, test, expect } from 'vitest';
import { parseCsv, parseAmount, parseDate, extractReference, parseBankStatement, parseCashlessTracker, parseAdvice, parsePatientDues } from './parse';
import { proposeMatches, classifyShort, subsetSum, payerTokens, type OpenReceivable, type OpenReceipt } from './match';

describe('values', () => {
  test('Indian amounts, "-" and "50K Due"', () => {
    expect(parseAmount('1,05,000')).toBe(105000);
    expect(parseAmount('₹ 2,29,026.50')).toBe(229026.5);
    expect(parseAmount('-')).toBeNull();
    expect(parseAmount('50K Due')).toBe(50000);
    expect(parseAmount('12,345.00 Cr')).toBe(12345);
  });
  test('dates are day-first', () => {
    expect(parseDate('05/06/2026')).toBe('2026-06-05');
    expect(parseDate('29-09-2026')).toBe('2026-09-29');
    expect(parseDate('7 Oct 2026')).toBe('2026-10-07');
    expect(parseDate('31/02/2026')).toBeNull();
    expect(parseDate('2026-10-01')).toBe('2026-10-01');
  });
  test('bank narration → transfer reference', () => {
    expect(extractReference('NEFT HDFCH01122534620 HDFC ERGO GENERAL\tNEFTINW-1614370242')).toBe('HDFCH01122534620');
    expect(extractReference('RTGS HDFCR52026070780245289 THE ORIENTAL')).toBe('HDFCR52026070780245289');
    expect(extractReference('NEFT AXISCN1407091371 THE NEW INDIA ASSURANCE COM')).toBe('AXISCN1407091371');
    expect(extractReference('IFT-NATIONAL INSURANCE COMPANY')).toBeNull();
  });
  test('CSV with quotes, commas and newlines', () => {
    expect(parseCsv('a,"b, c","d ""e"""\r\n1,"2\n3",4\n')).toEqual([['a', 'b, c', 'd "e"'], ['1', '2\n3', '4']]);
  });
});

describe('importers', () => {
  test('bank statement keeps credits only and extracts the UTR', () => {
    const csv = parseCsv([
      'Kotak Mahindra Bank,,,,,,',
      'Sl. No.,Transaction Date,Value Date,Description,Chq / Ref No.,Debit,Credit,Balance',
      '1,11/07/2026,11/07/2026,NEFT HDFCH01122534620 HDFC ERGO GENERAL,,,"4,05,611.00","10,00,000.00"',
      '2,11/07/2026,11/07/2026,CHQ PAID VENDOR,000123,"50,000.00",,"9,50,000.00"',
      '3,15/07/2026,15/07/2026,IFT-NATIONAL INSURANCE COMPANY,,,"1,97,188.00","11,47,188.00"',
    ].join('\n'));
    const { rows } = parseBankStatement(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ value_date: '2026-07-11', amount: 405611, reference: 'HDFCH01122534620' });
    expect(rows[1].reference).toBeNull();
  });

  test('cashless tracker tab stops at the reimbursement block', () => {
    const csv = parseCsv([
      'Sr. No.,IP NO.,PATIENT NAME,DOCTOR NAME,BILL NO.,DISCHARGE DATE,INSURANCE COMPANY,TPA NAME,POLICY NO,CLAIM NO,BILL DATE,TOTAL BILL AMT,IC APPROVAL AMT.,DISCOUNT AMT,PAID BY PATIENT,NET BILL AMT,IC TO HOSP AMT,IC TO HOSP DATE, TPA UTR Details',
      '1,IPS126954,GITABEN PANKAJKUMAR PATEL,DR MOHAL BANKER,IPB126/1483,30/06/2026,HDFC ERGO,HDFC ERGO,2805206771381401,RC-HS26-15769732_1,30/06/2026,"425,773","406,196","19,577",0,"406,196",405611,11/07/2026,NEFT HDFCH01122534620 HDFC ERGO GENERAL',
      '2,IPS126939,RIDDHI VORA,DR KRUNAL SOLANKI,IPB126/1498,30/06/2026,ORIENTAL,MD INDIA,x,MD10539494,30/06/2026,"68,092","51,475","16,617",0,"51,475",,,',
      ',,,,,,,,,,TOTAL,,,,,,,,',
      'HEALTH1- REIMBURSEMENT  CASE,,,,,,,,,,,,,,,,,,',
      'Sr. No.,IP NO.,PATIENT NAME,DOCTOR NAME,BILL NO.,DISCHARGE DATE,INSURANCE COMPANY,TPA NAME,BILL DATE,BILL AMT,,,,,,,,,',
      '1,IPS126639,JAYOTSANABEN PRAJAPATI,DR KALPESH C PATEL,IPB126/1026,04/06/2026,CARE HEALTH,CARE HEALTH,04/06/2026,383366,,,,,,,,,',
    ].join('\n'));
    const { rows } = parseCashlessTracker(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ bill_no: 'IPB126/1483', approved: 406196, received: 405611, recorded_utr: 'HDFCH01122534620', bill_date: '2026-06-30' });
    expect(rows[1].received).toBeNull();
  });

  test('settlement advice needs a net column', () => {
    const { rows } = parseAdvice(parseCsv('Claim No,UTR No,Approved,TDS,Deduction,Deduction Reason,Net Paid\nMD10539494,HDFCH0111,51475,1030,2000,Non-payable consumables,48445\n'));
    expect(rows[0]).toMatchObject({ claim_ref: 'MD10539494', tds_amount: 1030, deduction_amount: 2000, net_amount: 48445 });
    expect(() => parseAdvice(parseCsv('Claim No,UTR\nX,Y\n'))).toThrow(/Net/);
  });

  test('patient dues list', () => {
    const { rows } = parsePatientDues(parseCsv('SR,IP NO.,PATIENT NAME,DOCTOR NAME,AMOUNT,DOD,REMARK\n2,IPS126821,AASHISH SONI,DR KATHAN TALSANIA,600000,25/06/2026,C/O DR KATHAN TALSANIA\n'));
    expect(rows[0]).toMatchObject({ amount: 600000, bill_date: '2026-06-25', care_of: 'C/O DR KATHAN TALSANIA' });
  });
});

const rv = (o: Partial<OpenReceivable> & { id: string }): OpenReceivable => ({
  debtor_name: 'HDFC ERGO', payer_id: null, claim_ref: null, bill_no: null, patient_name: null,
  bill_date: '2026-06-30', balance: 100000, recorded_utr: null, ...o,
});
const rc = (o: Partial<OpenReceipt> & { id: string }): OpenReceipt => ({
  value_date: '2026-07-15', unallocated: 100000, reference: null, narration: 'NEFT X HDFC ERGO GENERAL', payer_id: null, ...o,
});

describe('matching', () => {
  test('short payments are classified like the report', () => {
    expect(classifyShort(406196, 406190)).toBe('exact');
    expect(classifyShort(100000, 98000)).toBe('tds');
    expect(classifyShort(94615, 4615)).toBe('part');
    expect(classifyShort(271152, 218880)).toBe('deduction');
    expect(classifyShort(300000, 308880)).toBe('over');
  });

  test('payer tokens ignore generic words', () => {
    expect(payerTokens('HDFC ERGO General Insurance')).toEqual(['HDFC']);
    expect(payerTokens('The New India Assurance')).toEqual(['NEW INDIA']);
    expect(payerTokens('Oriental Insurance')).toEqual(['ORIENTAL']);
  });

  test('settlement advice wins and carries TDS and deduction', () => {
    const res = proposeMatches(
      [rv({ id: 'b1', claim_ref: 'MD10539494', balance: 51475, debtor_name: 'Oriental Insurance' })],
      [rc({ id: 'r1', reference: 'HDFCH0111', unallocated: 48445, narration: 'NEFT HDFCH0111 THE ORIENTAL' })],
      [{ id: 'a1', utr: 'HDFCH0111', claim_ref: 'md10539494', bill_no: null, patient_name: null, tds_amount: 1030, deduction_amount: 2000, deduction_reason: 'Consumables', net_amount: 48445 }],
    );
    expect(res.proposals).toHaveLength(1);
    expect(res.proposals[0]).toMatchObject({ method: 'advice', confidence: 'high', amount: 48445, residual: 0, remittance_line_id: 'a1' });
    expect(res.proposals[0].adjustments.map((a) => a.kind)).toEqual(['tds', 'deduction']);
  });

  test('UTR recorded on the bill matches; ₹585 short stays visible', () => {
    const res = proposeMatches([rv({ id: 'b1', recorded_utr: 'HDFCH01122534620', balance: 406196 })],
      [rc({ id: 'r1', reference: 'HDFCH01122534620', unallocated: 405611 })]);
    expect(res.proposals[0]).toMatchObject({ method: 'utr', confidence: 'high', amount: 405611, residual: 585 });
  });

  test('one UTR paying three New India bills (bulk) pays each in full', () => {
    const bills = [rv({ id: 'a', recorded_utr: 'AXISCN1474902576', balance: 100000, debtor_name: 'New India Assurance' }),
      rv({ id: 'b', recorded_utr: 'AXISCN1474902576', balance: 52684, debtor_name: 'New India Assurance' }),
      rv({ id: 'c', recorded_utr: 'AXISCN1474902576', balance: 100000, debtor_name: 'New India Assurance' })];
    const res = proposeMatches(bills, [rc({ id: 'r', reference: 'AXISCN1474902576', unallocated: 252684 })]);
    expect(res.proposals.map((p) => p.amount)).toEqual([100000, 52684, 100000]);
    expect(res.proposals.every((p) => p.confidence === 'high')).toBe(true);
  });

  test('amount match needs the payer in the narration and a single candidate', () => {
    const bills = [rv({ id: 'x', balance: 75150, debtor_name: 'Oriental Insurance' }), rv({ id: 'y', balance: 75150, debtor_name: 'HDFC ERGO' })];
    const res = proposeMatches(bills, [rc({ id: 'r', unallocated: 75150, narration: 'NEFT HDFCH01055116215 THE ORIENTAL INSURANCE CO L' })]);
    expect(res.proposals).toHaveLength(1);
    expect(res.proposals[0]).toMatchObject({ receivable_id: 'x', method: 'amount', confidence: 'medium' });
  });

  test('amount net of 2% TDS still matches and books the TDS', () => {
    const res = proposeMatches([rv({ id: 'x', balance: 100000 })], [rc({ id: 'r', unallocated: 98000 })]);
    expect(res.proposals[0].adjustments).toEqual([{ kind: 'tds', amount: 2000 }]);
    expect(res.proposals[0].residual).toBe(0);
  });

  test('two equal candidates → ambiguous, nothing proposed', () => {
    const res = proposeMatches([rv({ id: 'x', balance: 14000 }), rv({ id: 'y', balance: 14000 })], [rc({ id: 'r', unallocated: 14000 })]);
    expect(res.proposals).toHaveLength(0);
    expect(res.ambiguous[0].candidates.sort()).toEqual(['x', 'y']);
  });

  test('a receipt dated before the bill is never matched to it', () => {
    const res = proposeMatches([rv({ id: 'x', balance: 5000, bill_date: '2026-08-01' })], [rc({ id: 'r', unallocated: 5000, value_date: '2026-07-01' })]);
    expect(res.proposals).toHaveLength(0);
    expect(res.unmatchedReceipts).toEqual(['r']);
  });

  test('bulk receipt without a recorded UTR found by subset sum', () => {
    const bills = [rv({ id: 'a', balance: 11520 }), rv({ id: 'b', balance: 54400 }), rv({ id: 'c', balance: 75150 }), rv({ id: 'd', balance: 9000 })];
    const res = proposeMatches(bills, [rc({ id: 'r', unallocated: 86670 })]);
    expect(res.proposals.map((p) => p.receivable_id).sort()).toEqual(['a', 'c']);
    expect(res.proposals.every((p) => p.method === 'bulk')).toBe(true);
  });

  test('subsetSum returns null when nothing fits', () => {
    expect(subsetSum([100, 200, 300], 1000)).toBeNull();
  });

  test('a receipt is never allocated beyond its amount', () => {
    const bills = [rv({ id: 'a', recorded_utr: 'U1', balance: 70000 }), rv({ id: 'b', recorded_utr: 'U1', balance: 70000 })];
    const res = proposeMatches(bills, [rc({ id: 'r', reference: 'U1', unallocated: 100000 })]);
    expect(res.proposals.reduce((s, p) => s + p.amount, 0)).toBe(100000);
    expect(res.proposals.every((p) => p.confidence === 'medium')).toBe(true);
  });
});
