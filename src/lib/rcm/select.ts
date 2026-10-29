// Columns a case screen and the NHCX send route read (shared by client and server).
export const CASE_SELECT =
  'id, tenant_id, centre_id, payer_id, claim_number, claim_type, status, patient_name, patient_uhid, admission_ref, ' +
  'treating_doctor_name, department_name, admission_date, discharge_date, admitted_at, discharged_at, intimated_at, ' +
  'estimated_amount, claimed_amount, approved_amount, settled_amount, bill_no, bill_amount, discount_amount, patient_paid, sponsor_name, bed_category, ' +
  'tpa_claim_number, tpa_preauth_number, preauth_submitted_at, submitted_at, is_query_pending, case_source, created_at, updated_at, status_changed_at, ' +
  'cut_decision, cut_note, cut_decided_at, preauth_approved_amount, ' +
  'patient_phone, patient_gender, patient_age_years, member_id, treating_doctor_hpr_id, treatment_type, policy_number, abha_id, ' +
  'icd_code, primary_diagnosis, package_code, package_name, procedure_name, ' +
  'clm_payers!clm_claims_payer_id_fkey(id, code, name, type, channel, is_nhcx_live, nhcx_code)';
