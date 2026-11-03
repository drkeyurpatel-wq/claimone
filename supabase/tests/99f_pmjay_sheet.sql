-- ════════════════════════════════════════════════════════════════════
-- PMJAY desk sheet → Master: NABH is the claim, NO NABH kept aside,
-- status moves forward only, a paid row books the payment once.
-- ════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
set client_min_messages = warning;
update clm_tenants set paper_gate = false where id = 'a0000000-0000-0000-0000-000000000001';
set role authenticated;
select t.act_as('00000000-0000-0000-0000-0000000000d1');

create temp table res(r jsonb);
insert into res select clm_import_pmjay('a1000000-0000-0000-0000-000000000001', 'nov.xlsx', $$[
  {"ip_no":"IPS-PJ1","patient_name":"Pmjay One","case_no":"2026102910013158","card_no":"PZDC3DP68","case_status":"Claims Submitted","doctor":"DR.SUNIL GURMUKHANI","admitted_on":"2026-10-29","discharged_on":"2026-11-02","category":"Cardiology","procedure":"PTCA(MC011A-PTCA)","nabh_amount":91714,"non_nabh_amount":86634},
  {"ip_no":"IPS-PJ2","patient_name":"Pmjay Two","case_no":"PJ2","case_status":"Claims Submitted","admitted_on":"2026-10-28","discharged_on":"2026-11-02","nabh_amount":0,"non_nabh_amount":0},
  {"ip_no":"IPS-PJ3","patient_name":"Pmjay Three","case_no":"PJ3","admitted_on":"2026-11-02","nabh_amount":4427.5,"non_nabh_amount":4025},
  {"ip_no":"IPS-PJ4","patient_name":"Pmjay Four","case_no":"PJ4","case_status":"Claim Paid","admitted_on":"2026-10-20","discharged_on":"2026-10-25","nabh_amount":50000,"non_nabh_amount":45000,"utr":"UTRPJ4","paid_on":"2026-11-01","paid_amount":48000,"deduction":2000},
  {"ip_no":"","patient_name":"nobody"}
]$$::jsonb);

select t.check((select r->>'created' = '4' and r->>'skipped' = '1' and r->>'paid' = '1' and jsonb_array_length(r->'problems') = 1 from res), 'counts');
select t.check((select r->'problems'->0->>'ip' = 'IPS-PJ2' from res), 'zero-amount row reported');
select t.check((select bool_and(case_source = 'pmjay' and claim_type = 'pmjay') from clm_claims where admission_ref like 'IPS-PJ%'), 'kept as PMJAY sheet cases');
select t.check((select status = 'claim_submitted' and claimed_amount = 91714 and non_nabh_amount = 86634 and estimated_amount = 91714
                  and package_code = 'MC011A' and tpa_claim_number = '2026102910013158' and member_id = 'PZDC3DP68'
                  and submitted_at::date = '2026-11-02' and treating_doctor_name = 'DR.SUNIL GURMUKHANI'
                from clm_claims where admission_ref = 'IPS-PJ1'), 'NABH is the claim, NO NABH kept');
select t.check((select status = 'draft' from clm_claims where admission_ref = 'IPS-PJ2'), 'no amount: left as is');
select t.check((select status = 'draft' and estimated_amount = 4427.5 from clm_claims where admission_ref = 'IPS-PJ3'), 'blank status: not sent yet');
-- paid ₹48,000 after the scheme cut ₹2,000: approved ₹48,000 against the ₹50,000 claim; the ₹2,000 cut
-- waits for Accept / Dispute like any other payer's cut of ₹1,000 or more
select t.check((select status = 'claim_partial' and approved_amount = 48000 and claimed_amount = 50000 from clm_claims where admission_ref = 'IPS-PJ4'), 'paid: approved at the final amount, cut waits');
select t.check((select count(*) = 1 from clm_remittance_lines l join clm_receivables v on v.id = l.receivable_id
                join clm_claims c on c.id = v.claim_id where c.admission_ref = 'IPS-PJ4' and l.utr = 'UTRPJ4' and l.net_amount = 48000), 'payment booked');

-- upload again, later in the month: moves forward, nothing doubled, never moves back
truncate res;
insert into res select clm_import_pmjay('a1000000-0000-0000-0000-000000000001', 'nov.xlsx', $$[
  {"ip_no":"ips-pj1","patient_name":"Pmjay One","case_status":"Claim Approved","nabh_amount":91714,"non_nabh_amount":86634},
  {"ip_no":"IPS-PJ3","patient_name":"Pmjay Three","case_status":"Claims Submitted","discharged_on":"2026-11-03","nabh_amount":4427.5,"non_nabh_amount":4025},
  {"ip_no":"IPS-PJ4","patient_name":"Pmjay Four","case_status":"Claims Submitted","nabh_amount":50000,"non_nabh_amount":45000,"utr":"UTRPJ4","paid_on":"2026-11-01","paid_amount":48000,"deduction":2000}
]$$::jsonb);
select t.check((select r->>'created' = '0' and r->>'paid' = '0' from res), 'second upload adds nothing new');
select t.check((select status = 'claim_approved' and approved_amount = 91714 from clm_claims where admission_ref = 'IPS-PJ1'), 'approved at NABH');
select t.check((select status = 'claim_submitted' and discharge_date = '2026-11-03' from clm_claims where admission_ref = 'IPS-PJ3'), 'submitted on re-upload');
select t.check((select status <> 'claim_submitted' from clm_claims where admission_ref = 'IPS-PJ4'), 'never moved back');
select t.check((select count(*) = 1 from clm_remittance_lines l join clm_receivables v on v.id = l.receivable_id
                join clm_claims c on c.id = v.claim_id where c.admission_ref = 'IPS-PJ4'), 'payment not doubled');

-- the PMJAY case ID is the key: a corrected IP no. on the sheet still finds the case by its case ID
select t.check((clm_import_pmjay('a1000000-0000-0000-0000-000000000001', 'nov.xlsx', $$[
  {"ip_no":"IPS-PJ1-X","patient_name":"Pmjay One","case_no":" 2026102910013158 ","case_status":"Claim Approved","nabh_amount":91714}
]$$::jsonb))->>'created' = '0', 'found by case ID');
-- one case ID belongs to one case
select t.check((clm_import_pmjay('a1000000-0000-0000-0000-000000000001', 'nov.xlsx', $$[
  {"ip_no":"IPS-PJ3","patient_name":"Pmjay Three","case_no":"2026102910013158","nabh_amount":4427.5}
]$$::jsonb))->'problems'->0->>'problem' like 'Case ID 2026102910013158 is on another IP%', 'case ID on another IP refused');
select t.check((clm_import_pmjay('a1000000-0000-0000-0000-000000000001', 'nov.xlsx', $$[
  {"ip_no":"IPS-PJ4","patient_name":"Pmjay Four","case_no":"OTHER1","nabh_amount":50000}
]$$::jsonb))->'problems'->0->>'problem' like 'This IP no. already has case ID PJ4%', 'IP with a different case ID refused');
select t.check((select tpa_claim_number = 'PJ4' from clm_claims where admission_ref = 'IPS-PJ4'), 'case ID unchanged');
reset role;
select t.expect_error($$ update clm_claims set tpa_claim_number = 'PJ4' where admission_ref = 'IPS-PJ1' $$, 'duplicate');
set role authenticated;
select t.act_as('00000000-0000-0000-0000-0000000000d1');
-- a missing case ID is reported (payments match on it)
select t.check((clm_import_pmjay('a1000000-0000-0000-0000-000000000001', 'nov.xlsx', $$[
  {"ip_no":"IPS-PJ5","patient_name":"Pmjay Five","nabh_amount":1000}
]$$::jsonb))->'problems'->0->>'problem' like 'No PMJAY case ID%', 'missing case ID reported');
-- the bill carries the case ID, so a settlement file finds it
select t.check((select claim_ref = '2026102910013158' from clm_receivables where claim_id = (select id from clm_claims where admission_ref = 'IPS-PJ1')), 'bill carries the case ID');
-- a case ID corrected on Master after approval reaches the bill
update clm_claims set tpa_claim_number = '2026102910099999' where admission_ref = 'IPS-PJ1';
select t.check((select claim_ref = '2026102910099999' from clm_receivables where claim_id = (select id from clm_claims where admission_ref = 'IPS-PJ1')), 'corrected case ID on the bill');
-- a PMJAY case added by hand with its case ID is found by the sheet
insert into clm_claims (tenant_id, centre_id, payer_id, claim_type, patient_name, admission_ref, tpa_claim_number, case_source, claim_number)
values ('a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001',
        (select id from clm_payers where code = 'pmjay_gujarat' and tenant_id is null), 'pmjay', 'Pmjay Six', 'IPS-PJ6', 'CASE6', 'manual', 'pending');
select t.check((clm_import_pmjay('a1000000-0000-0000-0000-000000000001', 'nov.xlsx', $$[
  {"ip_no":"IPS-PJ6","patient_name":"Pmjay Six","case_no":"case6","case_status":"Claims Submitted","nabh_amount":5000}
]$$::jsonb))->>'created' = '0', 'hand-added case found by case ID');
select t.check((select status = 'claim_submitted' and claimed_amount = 5000 from clm_claims where admission_ref = 'IPS-PJ6'), 'hand-added case moved');

-- a viewer cannot load
select t.act_as('00000000-0000-0000-0000-0000000000f1');
select t.expect_error($$ select clm_import_pmjay('a1000000-0000-0000-0000-000000000001', 'x', '[]'::jsonb) $$, 'read-only');
reset role;
select 'ALL PMJAY SHEET TESTS PASSED' as result;
