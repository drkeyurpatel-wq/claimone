-- Tag patient-identifying columns so audits, exports and future masking can
-- find them by metadata instead of by guesswork.
comment on column clm_claims.patient_name        is 'PHI: patient name';
comment on column clm_claims.patient_phone       is 'PHI: patient mobile';
comment on column clm_claims.patient_uhid        is 'PHI: hospital patient id';
comment on column clm_claims.abha_id             is 'PHI: ABHA health id';
comment on column clm_claims.policy_number       is 'PII: insurance policy / card number';
comment on column clm_claims.policy_holder_name  is 'PII: policyholder name';
comment on column clm_claims.primary_diagnosis   is 'PHI: diagnosis';
comment on column clm_claims.icd_code            is 'PHI: diagnosis code';
comment on column clm_claims.procedure_name      is 'PHI: procedure';
comment on column clm_claims.admission_ref       is 'PHI: admission / IPD number';
comment on column clm_documents.file_path        is 'PHI: path to a clinical or identity document (private bucket)';
comment on column clm_documents.document_name    is 'PHI: may name the patient';
comment on column clm_queries.query_text         is 'PHI: payer query about the patient''s care';
comment on column clm_queries.response_text      is 'PHI: hospital reply about the patient''s care';
comment on column clm_notifications.recipient_phone is 'PHI: patient mobile';
comment on column clm_notifications.message_content is 'PHI: message sent to the patient';
