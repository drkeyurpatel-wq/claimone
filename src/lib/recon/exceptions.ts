/**
 * The mismatch list on the weekly page: helpers kept pure so they can be tested.
 */
import type { ExceptionRow } from './api';

/** Short payments under this many rupees are treated as rounding and can be closed in one click. */
export const SMALL_DIFF = 100;

const cell = (v: unknown) => {
  let s = v == null ? '' : String(v);
  // a cell starting with = + - @ would run as a formula in Excel
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};
/** Long numbers (16-digit PMJAY case IDs, UTRs) must stay text in Excel. */
const text = (v: string | null) => (v ? `="${v.replace(/"/g, '')}"` : '""');

export function csvOf(rows: ExceptionRow[], amountLabel: string): string {
  const head = ['Patient', 'UHID', 'Bill no', 'Claim / case ID', 'Bill date', 'Payer', 'Billed', 'Received', amountLabel, 'Days'];
  const lines = rows.map((r) => [
    cell(r.patient_name), text(r.uhid), text(r.bill_no), text(r.claim_ref), cell(r.bill_date), cell(r.debtor_name),
    cell(r.expected_amount), cell(Math.round((r.allocated + r.tds + r.deduction) * 100) / 100), cell(Math.abs(r.balance)), cell(r.age_days),
  ].join(','));
  return '﻿' + [head.map(cell).join(','), ...lines].join('\r\n');
}
