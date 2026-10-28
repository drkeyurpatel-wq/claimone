/**
 * A ClaimOne case → the NHCX library's pre-auth / claim input.
 * Returns the list of details still missing (in desk words) instead of
 * sending an incomplete request the payer would reject.
 */
import type { Claim } from '@/lib/claims/types';
import type { ClaimInput, PreauthInput, ProviderInput } from '@/lib/nhcx/types';

export type NhcxCase = Claim;
export type NhcxKind = 'preauth' | 'claim';

const ICD10 = /^[A-TV-Z][0-9][0-9AB](\.[0-9A-TV-Z]{1,4})?$/i;
const HPR = /^\d{2}-\d{4}-\d{4}-\d{4}$/;
const ist = (s: string) => (s.length === 10 ? `${s}T00:00:00+05:30` : s);

export function nhcxMissing(c: NhcxCase, kind: NhcxKind, amountOverride?: number): string[] {
  const m: string[] = [];
  if (!c.clm_payers?.nhcx_code) m.push('Insurer NHCX code (Payers page)');
  if (!c.patient_uhid) m.push('UHID');
  if (!c.patient_gender) m.push('Gender');
  if (c.patient_age_years == null) m.push('Age');
  if (!c.policy_number) m.push('Policy no.');
  if (!c.member_id) m.push('Member / card ID');
  if (!c.icd_code || !ICD10.test(c.icd_code.trim())) m.push('ICD-10 code');
  if (!c.primary_diagnosis) m.push('Diagnosis');
  if (!c.treating_doctor_name) m.push('Doctor');
  if (!c.treating_doctor_hpr_id || !HPR.test(c.treating_doctor_hpr_id.trim())) m.push("Doctor's HPR ID (12-3456-7890-1234)");
  if (!c.admitted_at && !c.admission_date) m.push('Admission date');
  if (kind === 'preauth' && !(Number(amountOverride ?? c.estimated_amount) > 0)) m.push('Estimate');
  if (kind === 'claim') {
    if (!(Number(amountOverride ?? c.claimed_amount ?? c.bill_amount) > 0)) m.push('Final bill amount');
    if (!c.discharged_at && !c.discharge_date) m.push('Discharge date');
  }
  return m;
}

export function caseToNhcx(c: NhcxCase, kind: NhcxKind, provider: ProviderInput, amountOverride?: number):
  { input: PreauthInput | ClaimInput | null; missing: string[] } {
  const missing = nhcxMissing(c, kind, amountOverride);
  if (missing.length) return { input: null, missing };
  const surgical = c.treatment_type === 'surgical';
  const amount = amountOverride ?? Number(kind === 'preauth' ? c.estimated_amount : c.claimed_amount ?? c.bill_amount);
  const code = c.package_code || (surgical ? 'SURGICAL' : 'MEDICAL');
  const display = c.package_name || c.procedure_name || (surgical ? 'Surgical management' : 'Medical management');
  const admitted = ist(c.admitted_at ?? c.admission_date!);
  const discharged = c.discharged_at ?? (c.discharge_date ? ist(c.discharge_date) : undefined);
  const input: PreauthInput | ClaimInput = {
    caseNumber: c.claim_number,
    provider,
    patient: {
      uhid: c.patient_uhid!, name: c.patient_name, gender: c.patient_gender!, ageYears: c.patient_age_years!,
      mobile: c.patient_phone?.replace(/\D/g, '').slice(-10) || undefined, abhaNumber: c.abha_id || undefined,
    },
    coverage: {
      payerCode: c.clm_payers!.nhcx_code!, payerName: c.clm_payers!.name, policyNumber: c.policy_number!, memberId: c.member_id!,
      memberIdType: c.claim_type === 'pmjay' ? 'PMJAY' : 'MB',
    },
    encounter: { admissionDate: admitted, dischargeDate: kind === 'claim' ? discharged : undefined },
    diagnoses: [{ icd10Code: c.icd_code!.trim().toUpperCase(), display: c.primary_diagnosis!, type: kind === 'claim' ? 'discharge' : 'provisional', onAdmission: true }],
    procedures: c.package_code || c.procedure_name ? [{ code, display, procedureType: surgical ? 'surgical' : 'medical' }] : undefined,
    items: [{
      code: kind === 'claim' && !c.package_code ? 'BILL' : code,
      display: kind === 'claim' && !c.package_code ? 'Final hospital bill' : display,
      categoryCode: surgical ? 'SG' : 'MG', categoryDisplay: surgical ? 'General Surgery' : 'General Medicine',
      quantity: 1, unitPrice: amount, amount,
      programCode: c.claim_type === 'pmjay' ? { code: 'AB-PMJAY', display: 'Ayushman Bharat PM-JAY' } : undefined,
    }],
    practitioners: [{ name: c.treating_doctor_name!, hprId: c.treating_doctor_hpr_id!.trim() }],
    ...(kind === 'claim' && c.tpa_preauth_number ? { preAuthRef: c.tpa_preauth_number } : {}),
  };
  return { input, missing: [] };
}

/** What we store about a reply: decision, amounts, reference — never patient details. */
export function replySummary(result: unknown): Record<string, unknown> {
  const r = (result ?? {}) as Record<string, unknown>;
  const pick = (k: string) => (r[k] == null ? undefined : r[k]);
  const out: Record<string, unknown> = {
    outcome: r.kind === 'communication-request' ? 'query' : r.kind === 'payment-notice' ? 'paid' : pick('decision') ?? pick('outcome'),
    approved_amount: pick('approvedAmount'), claimed_amount: pick('claimedAmount'), deduction_amount: pick('deductionAmount'),
    reference: pick('preAuthRef') ?? pick('utr'),
    net_amount: pick('netAmount'), tds_amount: pick('tdsAmount'), payment_date: pick('paymentDate'),
    // the payer's query, so the desk can answer it
    message: typeof r.text === 'string' ? r.text.slice(0, 1000) : undefined,
    deductions: Array.isArray(r.deductions)
      ? (r.deductions as { amount?: number; reason?: string }[]).slice(0, 20).map((d) => ({ amount: d.amount, reason: (d.reason ?? '').slice(0, 120) }))
      : undefined,
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}
