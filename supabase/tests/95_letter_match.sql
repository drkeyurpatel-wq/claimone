-- ════════════════════════════════════════════════════════════════════
-- A payment letter whose claim no. differs from the one typed on the case
-- still lands on the case's bill when exactly one unpaid case bill fits the patient.
-- ════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
set client_min_messages = warning;
set role authenticated;
select t.act_as('00000000-0000-0000-0000-0000000000d1');
select clm_import_cases('a1000000-0000-0000-0000-000000000001', 'm.xlsx', '[{"ip_no":"IPS-M1","patient_name":"Mrs. Test Matchname","sponsor":"MEDI ASSIST"}]'::jsonb);
reset role;
alter table clm_claims disable trigger clm_claims_bu;
update clm_claims set claimed_amount = 44000, approved_amount = 44000, status = 'claim_approved', tpa_claim_number = '123436534562' where admission_ref = 'IPS-M1';
alter table clm_claims enable trigger clm_claims_bu;
set role authenticated;

select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'letter.xlsx',
  '[{"source":"letter","claim_ref":"DEMO-CLM-X","patient_name":"TEST MATCHNAME","approved_amount":42000,"tds_amount":840,"deduction_amount":2000,"deduction_reason":"Non-payable items","net_amount":41160,"utr":"UTR-M1","payment_date":"2026-10-28"}]'::jsonb);
select t.check((select status = 'settled' and settled_amount = 41160 and deduction_amount = 2000 from clm_claims where admission_ref = 'IPS-M1'),
               'letter found the case by patient and closed it');
select t.check((select count(*) = 0 from clm_receivables where claim_ref = 'DEMO-CLM-X'), 'no stray bill made');

-- a letter for nobody we know makes a bill that owes approved + deduction, not a false "paid more"
select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'letter2.xlsx',
  '[{"source":"letter","claim_ref":"CL-UNKNOWN","patient_name":"Somebody Else Entirely","approved_amount":10000,"tds_amount":200,"deduction_amount":500,"deduction_reason":"Non-payable items","net_amount":9800,"utr":"UTR-M2","payment_date":"2026-10-28"}]'::jsonb);
select t.check((select expected_amount = 10500 and recon_status = 'settled' from clm_v_receivable_balance where claim_ref = 'CL-UNKNOWN'),
               'unknown letter bill owes approved + deduction and balances');

reset role;
select 'ALL LETTER MATCH TESTS PASSED' as result;
