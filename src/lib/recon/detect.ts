/**
 * One upload box for every money file: say which kind a spreadsheet is from its headers.
 * bank: a bank statement (credits become receipts, matched to bills)
 * pmjay_cases: the PMJAY desk's case sheet (cases on Master)
 * payments: a settlement letter / PMJAY payment sheet / Bills master (payments onto bills)
 */
import type { Cell } from './payments';
import { isPmjaySheet as isPmjayPaySheet } from './payments';
import { isPmjaySheet as isPmjayCaseSheet } from '@/lib/rcm/pmjay';

export type FileKind = 'bank' | 'pmjay_cases' | 'payments';

const norm = (h: unknown) => String(h ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

/** A bank statement: a date column, a narration column and a credit column (or amount + Dr/Cr), and no claim or bill column. */
export function isBankStatement(rows: string[][]): boolean {
  for (const r of rows.slice(0, 25)) {
    const H = r.map(norm);
    const has = (...xs: string[]) => H.some((h) => xs.some((x) => h === x || h.startsWith(`${x} `) || h.endsWith(` ${x}`)));
    const date = has('DATE', 'VALUE DATE', 'TXN DATE', 'TRANSACTION DATE');
    const text = has('NARRATION', 'DESCRIPTION', 'PARTICULARS', 'REMARKS');
    const money = has('CREDIT', 'DEPOSIT', 'DEPOSITS', 'CR AMOUNT', 'CREDIT AMOUNT') || (has('AMOUNT') && has('DR CR', 'DR / CR', 'TYPE'));
    const claimish = has('CLAIM NO', 'BILL NO', 'PATIENT NAME', 'IP NO', 'INVOICE NO', 'CLAIM NUMBER');
    if (date && text && money && !claimish) return true;
  }
  return false;
}

export function detectKind(rows: string[][], cells?: Cell[][]): FileKind {
  if (isPmjayPaySheet(rows)) return 'payments';
  if (isPmjayCaseSheet((cells ?? rows) as Cell[][])) return 'pmjay_cases';
  if (isBankStatement(rows)) return 'bank';
  return 'payments';
}
