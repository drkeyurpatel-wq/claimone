-- ════════════════════════════════════════════════════════════════════
-- ClaimOne — starter data
-- Platform-wide payers and default document rules (tenant_id = null).
-- These are a starting point: the Health1 billing head should confirm
-- each payer's list and add hospital or payer-specific rules on top.
-- ════════════════════════════════════════════════════════════════════

-- ─── Payers ──────────────────────────────────────────────────────────
insert into clm_payers (tenant_id, code, name, type, is_nhcx_live) values
  -- Government schemes
  (null, 'pmjay_gujarat',  'PMJAY / MA (Gujarat)',              'government', false),
  (null, 'pmjay_rajasthan','MAA Yojana / PMJAY (Rajasthan)',    'government', false),
  (null, 'cghs',           'CGHS',                               'government', false),
  (null, 'echs',           'ECHS',                               'government', false),
  -- TPAs
  (null, 'medi_assist',    'Medi Assist TPA',                    'tpa', false),
  (null, 'mdindia',        'MDIndia Health Insurance TPA',       'tpa', false),
  (null, 'paramount',      'Paramount Health Services TPA',      'tpa', false),
  (null, 'health_india',   'Health India Insurance TPA',         'tpa', false),
  (null, 'vidal',          'Vidal Health TPA',                   'tpa', false),
  (null, 'fhpl',           'Family Health Plan TPA',             'tpa', false),
  (null, 'heritage',       'Heritage Health TPA',                'tpa', false),
  (null, 'raksha',         'Raksha Health Insurance TPA',        'tpa', false),
  (null, 'ericson',        'Ericson TPA',                        'tpa', false),
  (null, 'safeway',        'Safeway Insurance TPA',              'tpa', false),
  (null, 'good_health',    'Good Health Insurance TPA',          'tpa', false),
  (null, 'park_mediclaim', 'Park Mediclaim TPA',                 'tpa', false),
  -- Insurers (direct settlement)
  (null, 'star_health',    'Star Health and Allied Insurance',   'insurer', false),
  (null, 'niva_bupa',      'Niva Bupa Health Insurance',         'insurer', false),
  (null, 'care_health',    'Care Health Insurance',              'insurer', false),
  (null, 'hdfc_ergo',      'HDFC ERGO General Insurance',        'insurer', false),
  (null, 'icici_lombard',  'ICICI Lombard General Insurance',    'insurer', false),
  (null, 'bajaj_allianz',  'Bajaj Allianz General Insurance',    'insurer', false),
  (null, 'aditya_birla',   'Aditya Birla Health Insurance',      'insurer', false),
  (null, 'tata_aig',       'Tata AIG General Insurance',         'insurer', false),
  (null, 'sbi_general',    'SBI General Insurance',              'insurer', false),
  (null, 'manipal_cigna',  'ManipalCigna Health Insurance',      'insurer', false),
  (null, 'reliance_general','Reliance General Insurance',        'insurer', false),
  -- PSU insurers
  (null, 'new_india',      'The New India Assurance',            'psu', false),
  (null, 'united_india',   'United India Insurance',             'psu', false),
  (null, 'oriental',       'The Oriental Insurance',             'psu', false),
  (null, 'national',       'National Insurance',                 'psu', false)
on conflict do nothing;

-- ─── Default document rules ─────────────────────────────────────────
-- stage: preauth = cashless request, final = cashless final bill,
--        reimbursement = patient-paid claim
-- PMJAY / MA pre-auth and claims are filed in the scheme's TMS
update clm_payers set channel = 'tms' where code like 'pmjay%';

insert into clm_doc_rules (tenant_id, payer_id, claim_type, stage, doc_code, doc_label, is_mandatory, min_amount, sort_order) values
  -- Pre-authorisation (all cashless types)
  (null, null, null, 'preauth', 'preauth_form',     'Pre-authorisation form (signed)',     true,  null, 10),
  (null, null, null, 'preauth', 'id_proof',         'Patient photo ID',                    true,  null, 20),
  (null, null, null, 'preauth', 'policy_card',      'Insurance / TPA / scheme card',       true,  null, 30),
  (null, null, null, 'preauth', 'clinical_notes',   'Admission clinical notes',            true,  null, 40),
  (null, null, null, 'preauth', 'investigations',   'Supporting investigation reports',    false, null, 50),
  (null, null, null, 'preauth', 'cost_estimate',    'Itemised cost estimate',              false, null, 60),

  -- Final cashless claim
  (null, null, null, 'final', 'discharge_summary',  'Signed discharge summary',            true,  null, 10),
  (null, null, null, 'final', 'final_bill',         'Itemised final bill',                 true,  null, 20),
  (null, null, null, 'final', 'icp',                'Indoor case papers',                  true,  null, 30),
  (null, null, null, 'final', 'investigations',     'Investigation reports',               true,  null, 40),
  (null, null, null, 'final', 'preauth_approval',   'Pre-auth approval letter',            true,  null, 50),
  (null, null, null, 'final', 'ot_notes',           'OT / procedure notes',                false, null, 60),
  (null, null, null, 'final', 'implant_invoice',    'Implant invoice + sticker',           true,  50000, 70),
  (null, null, null, 'final', 'pharmacy_bills',     'Pharmacy bills',                      false, null, 80),

  -- Reimbursement
  (null, null, null, 'reimbursement', 'claim_form',        'Signed claim form (Part A/B)',  true, null, 10),
  (null, null, null, 'reimbursement', 'discharge_summary', 'Signed discharge summary',      true, null, 20),
  (null, null, null, 'reimbursement', 'final_bill',        'Itemised final bill',           true, null, 30),
  (null, null, null, 'reimbursement', 'payment_receipt',   'Payment receipts',              true, null, 40),
  (null, null, null, 'reimbursement', 'bank_details',      'Cancelled cheque / NEFT form',  true, null, 50),
  (null, null, null, 'reimbursement', 'investigations',    'Investigation reports',         true, null, 60),

  -- PMJAY additions (scheme-specific; billing head to confirm against TMS)
  (null, null, 'pmjay', 'preauth', 'pmjay_card',     'PMJAY / MA card',                     true, null, 15),
  (null, null, 'pmjay', 'preauth', 'admission_photo','Patient photo at admission',          true, null, 35),
  (null, null, 'pmjay', 'final',   'discharge_photo','Patient photo at discharge',          true, null, 15),
  (null, null, 'pmjay', 'final',   'feedback_form',  'Beneficiary feedback form',           true, null, 85);
