import { describe, expect, it } from 'vitest';
import type { PdfItem } from './pdftext';
import { pdfLines } from './pdftext';
import { claimCredits, isKotakStatement, isPayerCredit, parseKotakStatement, statementCredits } from './kotak';

// The layout of a Kotak net-banking statement: pieces of text with their place on the page (made-up figures).
const line = (page: number, y: number, cells: [number, string][]): PdfItem[] => cells.map(([x, str]) => ({ page, x, y, str }));
const HEAD = (page: number, y: number) => line(page, y, [[44, '#'], [75, 'Date'], [124, 'Description'], [280, 'Chq/Ref. No.'], [355, 'Withdrawal (Dr.)'], [429, 'Deposit (Cr.)'], [498, 'Balance']]);
const statement: PdfItem[] = [
  ...line(1, 700, [[223, 'Account Statement']]),
  ...line(1, 680, [[38, '01 Oct 2026 - 31 Oct 2026']]),
  ...line(1, 660, [[38, 'Account No. 0945694616']]),
  ...HEAD(1, 450),
  ...line(1, 431, [[39, '-'], [70, '-'], [119, 'Opening Balance'], [275, '-'], [416, '-'], [485, '-'], [508, '-1,00,000.00']]),
  ...line(1, 417, [[39, '1'], [73, '01 Oct 2026'], [119, 'NEFT AXISCN1484005979 BAJAJ GENERAL'], [275, 'NEFTINW-1732847539'], [456, '68,722.00'], [508, '-31,278.00']]),
  ...line(1, 409, [[119, 'INSURANCE LTD']]),
  ...line(1, 396, [[39, '2'], [73, '01 Oct 2026'], [119, 'Loan Recovery For -2582TL0100000353'], [382, '5,56,315.00'], [508, '-5,87,593.00']]),
  ...line(1, 30, [[250, 'Page 1 of 2']]),
  ...HEAD(2, 760),
  ...line(2, 740, [[39, '3'], [73, '02 Oct 2026'], [119, 'RTGS YESBR12026100200010490 PAYTM PAYMENTS SERV'], [275, 'RTGSINW-0113689'], [450, '3,08,347.20'], [508, '-2,79,245.80']]),
  ...line(2, 720, [[39, '4'], [73, '03 Nov 2026'], [119, 'NEFT HDFCH00902833773 THE NEW INDIA ASSURANCE COM'], [275, 'NEFTINW-1740000001'], [456, '40,000.00'], [508, '-2,39,245.80']]),
  ...line(2, 700, [[39, '5'], [73, '04 Oct 2026'], [119, 'NEFT SBIN426100412345 UNITED INDIA INSURANCE COMP'], [275, 'NEFTINW-1740000002'], [456, '25,000.00'], [508, '-2,14,245.80']]),
];

describe('Kotak statement PDF', () => {
  it('is recognised by its headings, a letter is not', () => {
    expect(isKotakStatement(statement)).toBe(true);
    expect(isKotakStatement(line(1, 700, [[40, 'Settlement advice'], [40, 'Claim No. 123']]))).toBe(false);
  });

  it('groups pieces into lines, top to bottom', () => {
    expect(pdfLines(statement)[0].map((i) => i.str)).toEqual(['Account Statement']);
  });

  it('reads every row and decides in / out from the balance', () => {
    const st = parseKotakStatement(statement);
    expect(st).toMatchObject({ account: '0945694616', from: '2026-10-01', to: '2026-10-31', opening: -100000, closing: -214245.8, ties: true });
    expect(st.rows).toHaveLength(5);
    expect(st.rows[0]).toMatchObject({ n: 1, date: '2026-10-01', deposit: 68722, withdrawal: 0, ref: 'NEFTINW-1732847539',
      description: 'NEFT AXISCN1484005979 BAJAJ GENERAL INSURANCE LTD' });
    expect(st.rows[1]).toMatchObject({ deposit: 0, withdrawal: 556315 });
  });

  it('does not tie when a row is missing', () => {
    expect(parseKotakStatement(statement.filter((i) => !(i.page === 1 && i.y === 396))).ties).toBe(false);
  });

  it('credits carry the UTR from the narration', () => {
    const cr = statementCredits(parseKotakStatement(statement));
    expect(cr.map((c) => c.reference)).toEqual(['AXISCN1484005979', 'YESBR12026100200010490', 'HDFCH00902833773', 'SBIN426100412345']);
    expect(cr[0]).toMatchObject({ value_date: '2026-10-01', amount: 68722 });
  });

  it('keeps what verifies a payment, and new payer money; counts the rest', () => {
    const cr = statementCredits(parseKotakStatement(statement));
    const c = claimCredits(cr, new Set(['AXISCN1484005979']), '2026-11-01');
    expect(c.keep.map((x) => x.reference)).toEqual(['AXISCN1484005979', 'HDFCH00902833773']);
    expect(c).toMatchObject({ confirms: 1, confirmsAmount: 68722, older: 1, olderAmount: 25000, other: 1, otherAmount: 308347.2 });
  });

  it('knows a payer from other money', () => {
    expect(isPayerCredit('NEFT AXISCN1 BAJAJ GENERAL INSURANCE LTD')).toBe(true);
    expect(isPayerCredit('NEFT X PAY AND ACCOUNT MINISTRY OF')).toBe(true);
    expect(isPayerCredit('RTGS YESBR1 PAYTM PAYMENTS SERV')).toBe(false);
    expect(isPayerCredit('Loan Disbursement')).toBe(false);
  });
});
