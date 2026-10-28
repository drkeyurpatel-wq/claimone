import { describe, expect, it } from 'vitest';
import { csvOf } from './exceptions';
import type { ExceptionRow } from './api';

const row = (over: Partial<ExceptionRow>): ExceptionRow => ({
  receivable_id: 'x', debtor_type: 'government', debtor_name: 'PMJAY / MA (Gujarat)', patient_name: 'Test A', uhid: 'H1S-1',
  bill_no: 'IPB126/5', claim_ref: '2026050410019520', bill_date: '2026-05-05', expected_amount: 41250, allocated: 32259.64,
  tds: 658.36, deduction: 0, balance: 8332, age_days: 40, last_receipt_date: null, problem: 'short', ...over,
});

describe('mismatch download', () => {
  it('keeps case IDs as text and neutralises formula-looking cells', () => {
    const csv = csvOf([row({ patient_name: '=HYPERLINK("x")' })], 'Short by');
    expect(csv.startsWith('﻿"Patient"')).toBe(true);
    expect(csv).toContain('="2026050410019520"');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('"32918"');
    expect(csv).toContain('"8332"');
  });
});
