-- ════════════════════════════════════════════════════════════════════
-- NHCX case details and payer routing.
-- ════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
set client_min_messages = warning;
set role authenticated;
select t.act_as('00000000-0000-0000-0000-0000000000d1');

-- the eCW import fills gender and age
select clm_import_cases('a1000000-0000-0000-0000-000000000001', 'ecw5.xlsx',
  '[{"ip_no":"IPS-N1","patient_name":"Test N","sponsor":"TATA AIG","gender":"female","age_years":"54"}]'::jsonb);
select t.check((select patient_gender = 'female' and patient_age_years = 54 from clm_claims where admission_ref = 'IPS-N1'), 'gender and age from eCW');
select t.expect_error($$ update clm_claims set treating_doctor_hpr_id = '1234' where admission_ref = 'IPS-N1' $$, 'check');
update clm_claims set treating_doctor_hpr_id = '71-8422-5818-7201', member_id = 'M1', treatment_type = 'surgical' where admission_ref = 'IPS-N1';

-- only an admin sets how a payer is reached
select t.expect_error($$ select clm_set_payer_route((select id from clm_payers where code = 'tata_aig'), 'portal', '1000003538@hcx', true) $$, 'Only an admin');
reset role;
update clm_user_profiles set role = 'admin' where user_id = '00000000-0000-0000-0000-0000000000a1';
set role authenticated;
select t.act_as('00000000-0000-0000-0000-0000000000a1');
select t.expect_error($$ select clm_set_payer_route((select id from clm_payers where code = 'tata_aig'), 'portal', '', true) $$, 'NHCX code');
select clm_set_payer_route((select id from clm_payers where code = 'tata_aig'), 'portal', '1000003538@hcx', true);
select t.check((select is_nhcx_live and nhcx_code = '1000003538@hcx' from clm_payers where code = 'tata_aig'), 'payer now on NHCX');
reset role;
update clm_user_profiles set role = 'manager' where user_id = '00000000-0000-0000-0000-0000000000a1';

select 'ALL NHCX CASE TESTS PASSED' as result;
