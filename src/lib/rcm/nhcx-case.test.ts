import { describe, expect, it } from 'vitest';
import { buildPreauthBundle, buildClaimSubmissionBundle } from '@/lib/nhcx';
import { caseToNhcx, nhcxMissing, replySummary, type NhcxCase } from './nhcx-case';

const provider = { hfrId: 'IN2410000123', name: 'Health1 Shilaj', participantCode: '1000004446@hcx' };
const full = {
  claim_number: 'CLM-SHJ-2610-0001', claim_type: 'cashless', patient_name: 'Test Patient', patient_uhid: 'H1S-1', patient_phone: '+91 90000 00000',
  patient_gender: 'female', patient_age_years: 54, policy_number: 'POL-1', member_id: 'MEM-1', icd_code: 'i63.9', primary_diagnosis: 'Ischaemic stroke',
  treating_doctor_name: 'Dr Test', treating_doctor_hpr_id: '71-8422-5818-7201', admitted_at: '2026-10-27T10:00:00+05:30', estimated_amount: 250000,
  treatment_type: 'medical', clm_payers: { id: 'p', code: 'x', name: 'Test Insurer', type: 'insurer', nhcx_code: '1518@hcx', is_nhcx_live: true },
} as unknown as NhcxCase;

describe('case → NHCX', () => {
  it('lists missing details in desk words instead of sending', () => {
    const m = nhcxMissing({ ...full, member_id: null, icd_code: 'stroke', treating_doctor_hpr_id: '123' } as NhcxCase, 'preauth');
    expect(m).toEqual(['Member / card ID', 'ICD-10 code', "Doctor's HPR ID (12-3456-7890-1234)"]);
  });
  it('a final claim also needs the bill and discharge', () => {
    expect(nhcxMissing(full, 'claim')).toEqual(['Final bill amount', 'Discharge date']);
  });
  it('builds a valid pre-auth bundle with the library', () => {
    const { input, missing } = caseToNhcx(full, 'preauth', provider);
    expect(missing).toEqual([]);
    expect(input?.diagnoses[0].icd10Code).toBe('I63.9');
    expect(input?.items[0]).toMatchObject({ unitPrice: 250000, categoryCode: 'MG' });
    const b = buildPreauthBundle(input!);
    expect(b.resourceType).toBe('Bundle');
  });
  it('builds a final claim carrying the pre-auth reference', () => {
    const c = { ...full, claimed_amount: 230000, discharged_at: '2026-10-30T12:00:00+05:30', tpa_preauth_number: 'PA-9' } as NhcxCase;
    const { input } = caseToNhcx(c, 'claim', provider);
    expect(input).toMatchObject({ preAuthRef: 'PA-9', items: [{ code: 'BILL', unitPrice: 230000 }] });
    expect(buildClaimSubmissionBundle(input!).resourceType).toBe('Bundle');
  });
  it('keeps only the decision and amounts from a reply', () => {
    const s = replySummary({ kind: 'claim-response', decision: 'partially_approved', approvedAmount: 200000, claimedAmount: 230000, deductionAmount: 30000,
      deductions: [{ amount: 30000, reason: 'Room rent' }], items: [{ secret: 'x' }], preAuthRef: 'PA-9' });
    expect(s).toEqual({ outcome: 'partially_approved', approved_amount: 200000, claimed_amount: 230000, deduction_amount: 30000, reference: 'PA-9',
      deductions: [{ amount: 30000, reason: 'Room rent' }] });
    expect(replySummary({ kind: 'communication-request', text: 'Send the MRI report', attachmentCount: 0 })).toEqual({ outcome: 'query', message: 'Send the MRI report' });
  });
});
