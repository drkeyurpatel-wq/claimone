import { describe, expect, it } from 'vitest';
import { detectKind, isBankStatement } from './detect';

describe('detectKind', () => {
  it('bank statements, in the usual net-banking layouts', () => {
    expect(isBankStatement([['Kotak Mahindra Bank'], [], ['Sl. No.', 'Transaction Date', 'Value Date', 'Description', 'Chq / Ref No.', 'Debit', 'Credit', 'Balance']])).toBe(true);
    expect(isBankStatement([['Date', 'Narration', 'Chq./Ref.No.', 'Value Dt', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance']])).toBe(true);
    expect(isBankStatement([['Txn Date', 'Particulars', 'Amount', 'Dr / Cr']])).toBe(true);
    expect(detectKind([['Value Date', 'Description', 'Credit']])).toBe('bank');
  });
  it('the PMJAY case sheet and the PMJAY payment sheet', () => {
    expect(detectKind([['NO', 'CASE NO', 'PATIENT NAME', 'CARD NUMBER', 'NABH', 'NO NABH', 'IP NO']])).toBe('pmjay_cases');
    expect(detectKind([['Invoice No.', 'Inv. Date', 'IP No.', 'Patient Name', 'Letter No.', 'Claim Paid Amount', 'UTR']])).toBe('payments');
  });
  it('a settlement letter with a date and narration is not a bank statement', () => {
    expect(detectKind([['Claim No', 'Patient Name', 'UTR', 'Date', 'Remarks', 'Credit']])).toBe('payments');
    expect(detectKind([['Claim Number', 'Net Paid', 'UTR No', 'Payment Date']])).toBe('payments');
  });
});
