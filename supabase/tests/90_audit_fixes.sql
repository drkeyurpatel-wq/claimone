-- ════════════════════════════════════════════════════════════════════
-- Audit fixes: letter deductions vs approval cuts, due clocks, IST dates,
-- disputes that get paid, and paper tick boxes.
-- ════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
set client_min_messages = warning;
set role authenticated;
select t.act_as('00000000-0000-0000-0000-0000000000d1');

-- 1. IST dates: a discharge at 02:00 IST is that day, not the day before
select clm_import_cases('a1000000-0000-0000-0000-000000000001', 'a1.xlsx', $$[
  {"ip_no":"IPS-A1","patient_name":"Test A1","sponsor":"TATA AIG","admitted_at":"2026-10-04T23:00:00+05:30",
   "discharged_at":"2026-10-05T02:00:00+05:30","bill_no":"IPB-A1","net_amount":"100000","paid_amount":"0"}]$$::jsonb);
select t.check((select discharge_date = '2026-10-05' and admission_date = '2026-10-04' from clm_claims where admission_ref = 'IPS-A1'), 'dates in IST');

-- 2. the same file again changes nothing and does not restart the due clock
reset role;
update clm_claims set status_changed_at = now() - interval '10 days', updated_at = now() - interval '10 days' where admission_ref = 'IPS-A1';
set role authenticated;
select t.check((select (r->>'updated')::int = 0) , 'nothing new, nothing updated')
from (select clm_import_cases('a1000000-0000-0000-0000-000000000001', 'a1.xlsx', $$[
  {"ip_no":"IPS-A1","patient_name":"Test A1","sponsor":"TATA AIG","discharged_at":"2026-10-05T02:00:00+05:30","bill_no":"IPB-A1","net_amount":"100000","paid_amount":"0"}]$$::jsonb) r) x;
select t.check((select status_changed_at < now() - interval '9 days' from clm_claims where admission_ref = 'IPS-A1'), 'due clock kept');

create temp table leak0 as select coalesce(sum(amount), 0) s from clm_v_leakage;
-- 3. approved ₹80,000 of ₹1,00,000; the letter says ₹20,000 deducted, TDS ₹8,000, ₹72,000 paid
reset role;
alter table clm_claims disable trigger clm_claims_bu;
update clm_claims set claimed_amount = 100000, approved_amount = 80000, status = 'claim_partial', tpa_claim_number = 'CL-A1' where admission_ref = 'IPS-A1';
alter table clm_claims enable trigger clm_claims_bu;
set role authenticated;
select t.check((select status_changed_at > now() - interval '1 minute' from clm_claims where admission_ref = 'IPS-A1'), 'status change stamps the clock');
select t.check((select expected_amount = 80000 from clm_receivables where bill_no = 'IPB-A1'), 'approval set the bill to ₹80,000');
select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'letter.pdf',
  '[{"source":"letter","claim_ref":"CL-A1","approved_amount":80000,"claimed_amount":100000,"tds_amount":8000,"deduction_amount":20000,"deduction_reason":"Room rent","net_amount":72000,"utr":"UTR-A1","payment_date":"2026-10-20"}]'::jsonb);
select t.check((select recon_status = 'settled' and deduction = 0 and balance = 0 from clm_v_receivable_balance where bill_no = 'IPB-A1'),
               'the approval cut is not booked again — bill settles, not "paid more"');
select t.check((select status = 'settled' and deduction_amount = 20000 from clm_claims where admission_ref = 'IPS-A1'), 'claim settled, deduction ₹20,000 once');
select t.check((select sum(amount) - (select s from leak0) = 20000 from clm_v_leakage), 'leakage counts ₹20,000 once');

-- 4. a disputed bill that is later paid in full is settled
select clm_import_cases('a1000000-0000-0000-0000-000000000001', 'a2.xlsx', $$[
  {"ip_no":"IPS-A2","patient_name":"Test A2","sponsor":"PMJAY","discharged_at":"2026-10-06T12:00:00+05:30","bill_no":"IPB-A2","net_amount":"5000","paid_amount":"0"}]$$::jsonb);
update clm_receivables set status = 'disputed', notes = 'x' where bill_no = 'IPB-A2';
select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'pm.xlsx',
  '[{"source":"letter","bill_no":"IPB-A2","net_amount":5000,"utr":"UTR-A2","payment_date":"2026-10-21"}]'::jsonb);
select t.check((select recon_status = 'settled' from clm_v_receivable_balance where bill_no = 'IPB-A2'), 'paid in full ends the dispute');

-- 5. paper tick boxes: tick passes the gate, untick takes it back, file optional
select clm_import_cases('a1000000-0000-0000-0000-000000000001', 'a3.xlsx', '[{"ip_no":"IPS-A3","patient_name":"Test A3","sponsor":"TATA AIG","estimated_amount":"30000"}]'::jsonb);
select clm_tick_document((select id from clm_claims where admission_ref = 'IPS-A3'), d.doc_code, d.doc_label, true)
from clm_unmet_mandatory_docs((select id from clm_claims where admission_ref = 'IPS-A3'), 'preauth') d;
select t.check((select count(*) = 0 from clm_unmet_mandatory_docs((select id from clm_claims where admission_ref = 'IPS-A3'), 'preauth')), 'ticks satisfy the papers');
select t.check((select bool_and(attested and file_path is null and status = 'valid' and verified_by = '00000000-0000-0000-0000-0000000000d1')
                from clm_documents where claim_id = (select id from clm_claims where admission_ref = 'IPS-A3')), 'tick recorded with who ticked');
select clm_tick_document((select id from clm_claims where admission_ref = 'IPS-A3'), 'id_proof', 'Patient photo ID', false);
select t.check((select count(*) = 1 from clm_unmet_mandatory_docs((select id from clm_claims where admission_ref = 'IPS-A3'), 'preauth')), 'untick takes it back');
select t.expect_error($$ insert into clm_documents (claim_id, doc_code, document_name, file_path) select id, 'x', 'x', null from clm_claims where admission_ref = 'IPS-A3' $$, 'file_or_tick');
select t.act_as('00000000-0000-0000-0000-0000000000f1');
select t.expect_error($$ select clm_tick_document((select id from clm_claims where admission_ref = 'IPS-A3'), 'id_proof', 'x', true) $$, 'Read-only');

reset role;
select 'ALL AUDIT FIX TESTS PASSED' as result;
