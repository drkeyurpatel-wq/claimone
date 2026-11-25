import { describe, expect, it } from 'vitest';
import { closeRefusal, mobile10, parseCommand, statusLine } from './assistant';
import { nextStep } from '@/lib/rcm/worklist';

describe('whatsapp commands', () => {
  it('reads the commands staff type', () => {
    expect(parseCommand('Status IP/2611/0042')).toEqual({ kind: 'status', ref: 'IP/2611/0042' });
    expect(parseCommand('close 26110042')).toEqual({ kind: 'close', ref: '26110042' });
    expect(parseCommand('YES')).toEqual({ kind: 'yes' });
    expect(parseCommand('due')).toEqual({ kind: 'due' });
    expect(parseCommand('How are we doing this month?')).toEqual({ kind: 'month' });
    expect(parseCommand('MA-883412')).toEqual({ kind: 'status', ref: 'MA-883412' });
    expect(parseCommand('please call me')).toBeNull();
  });
  it('closes only settled files', () => {
    expect(closeRefusal('settled')).toBeNull();
    expect(closeRefusal('claim_submitted')).toContain('only a settled file');
  });
  it('writes a status line', () => {
    const now = new Date('2026-11-20T12:00:00+05:30');
    const c = { patient_name: 'R. Kumar', claim_number: 'CL-9', admission_ref: 'IP42', tpa_claim_number: null, status: 'claim_submitted' as const, approved_amount: null, settled_amount: null, payer: 'HDFC ERGO' };
    const s = nextStep({ status: 'claim_submitted', claim_type: 'cashless', submitted_at: '2026-11-18T12:00:00+05:30', updated_at: '2026-11-18T12:00:00+05:30', created_at: '2026-11-10T12:00:00+05:30' }, now);
    expect(statusLine(c, s, now)).toContain('*R. Kumar* (IP42, HDFC ERGO)\nClaim submitted\nNext: Awaiting claim decision');
  });
  it('keeps the 10-digit mobile', () => expect(mobile10('919876543210')).toBe('9876543210'));
});
