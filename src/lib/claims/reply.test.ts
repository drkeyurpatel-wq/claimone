import { describe, expect, it } from 'vitest';
import { askedPapers, draftReply } from './reply';

const c = { patient_name: 'A. Shah', claim_number: 'CL-1', tpa_claim_number: 'MA123', policy_number: 'P9', admission_date: '2026-11-02', discharge_date: '2026-11-05' };

describe('query reply drafts', () => {
  it('finds the papers a query asks for', () => {
    expect(askedPapers('Kindly submit ICP, pharmacy bills and USG report').map((p) => p.code))
      .toEqual(['pharmacy_bills', 'imaging', 'indoor_papers']);
  });
  it('lists papers on file as enclosed and flags the ones still to get', () => {
    const d = draftReply({ query_text: 'Provide discharge summary and implant sticker' }, c,
      [{ doc_code: 'discharge_summary', document_name: 'DS.pdf' }]);
    expect(d.enclosed.map((p) => p.code)).toEqual(['discharge_summary']);
    expect(d.missing.map((p) => p.code)).toEqual(['implant']);
    expect(d.text).toContain('Ref: Claim MA123 — A. Shah, policy P9');
    expect(d.text).toContain('1. Discharge summary (signed)');
    expect(d.text).toContain('2. Implant invoice and sticker');
  });
  it('still writes a reply when the query names no known paper', () => {
    expect(draftReply({ query_text: 'Clarify line item 14' }, c, []).text).toContain('[Document requested]');
  });
});
