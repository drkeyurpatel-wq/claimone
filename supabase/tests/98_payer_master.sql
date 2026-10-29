-- ════════════════════════════════════════════════════════════════════
-- Payer master: add from the desk (reused when the name exists),
-- edit in Settings (admin / manager only), and repeat enhancements.
-- ════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
set client_min_messages = warning;
set role authenticated;

-- desk adds a new corporate; the same name in other spelling is reused
select t.act_as('00000000-0000-0000-0000-0000000000d1');
select clm_add_payer('Adani Ports Ltd', 'corporate') is not null;
select t.check((select type = 'corporate' and channel = 'direct' and tenant_id = 'a0000000-0000-0000-0000-000000000001'
                from clm_payers where name = 'Adani Ports Ltd'), 'new corporate saved for this hospital');
select t.check(clm_add_payer('  adani  PORTS ltd ', 'corporate') = (select id from clm_payers where name = 'Adani Ports Ltd'), 'same name reused');
select t.check(clm_add_payer('medi assist tpa', 'tpa') = (select id from clm_payers where code = 'medi_assist' and tenant_id is null), 'starter-list payer reused');
select clm_add_payer('Mukhyamantri Amrutum Plus', 'pmjay') is not null;
select t.check((select code ~ '^pmjay' and type = 'government' from clm_payers where name = 'Mukhyamantri Amrutum Plus'), 'a PMJAY payer gets a PMJAY code');
select t.expect_error($$ select clm_add_payer('ab', 'tpa') $$, 'full payer name');
select t.expect_error($$ select clm_add_payer('Some Payer', 'other') $$, 'payer category');

-- the desk cannot edit the list; a manager can
select t.expect_error($$ select clm_save_payer((select id from clm_payers where name = 'Adani Ports Ltd'), 'Adani Ports', 'corporate', true) $$, 'admin or manager');
select t.act_as('00000000-0000-0000-0000-0000000000a1');
select clm_save_payer((select id from clm_payers where name = 'Adani Ports Ltd'), 'Adani Ports & SEZ', 'corporate', false);
select t.check((select not is_active from clm_payers where name = 'Adani Ports & SEZ'), 'renamed and set inactive');
select t.expect_error($$ select clm_save_payer((select id from clm_payers where name = 'Adani Ports & SEZ'), 'Medi Assist TPA', 'corporate', true) $$, 'already has this name');
-- moving a payer into PMJAY gives it a PMJAY code (claim type follows)
select clm_save_payer((select id from clm_payers where name = 'Adani Ports & SEZ'), 'Adani Ports & SEZ', 'pmjay', true);
select t.check((select code ~ '^pmjay' and type = 'government' from clm_payers where name = 'Adani Ports & SEZ'), 'moved into PMJAY');
-- two hospital groups in this test database: the shared starter list is locked
select t.expect_error($$ select clm_save_payer((select id from clm_payers where code = 'medi_assist' and tenant_id is null), 'Medi Assist', 'tpa', true) $$, 'shared by all hospitals');

-- enhancement twice
select t.act_as('00000000-0000-0000-0000-0000000000d1');
insert into clm_claims (tenant_id, centre_id, payer_id, claim_type, patient_name, admission_ref, admitted_at, case_source)
values ('a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001',
        (select id from clm_payers where code = 'medi_assist' and tenant_id is null), 'cashless', 'Enhance Patient', 'IPS-EN1', now(), 'manual');
select clm_transition((select id from clm_claims where admission_ref = 'IPS-EN1'), 'preauth_pending', '{}'::jsonb, null);
select clm_transition((select id from clm_claims where admission_ref = 'IPS-EN1'), 'preauth_approved', '{"approved_amount":70000}'::jsonb, null);
select t.expect_error($$ select clm_record_enhancement((select id from clm_claims where admission_ref = 'IPS-EN1'), 80000) $$, 'only after');
select clm_transition((select id from clm_claims where admission_ref = 'IPS-EN1'), 'preauth_enhanced', '{"approved_amount":82000}'::jsonb, null);
select clm_record_enhancement((select id from clm_claims where admission_ref = 'IPS-EN1'), 95000, 'ICU extension');
select t.check((select approved_amount = 95000 and preauth_approved_amount = 95000 and status = 'preauth_enhanced'
                from clm_claims where admission_ref = 'IPS-EN1'), 'second enhancement raises the approval');
select t.check((select count(*) = 1 from clm_state_transitions where claim_id = (select id from clm_claims where admission_ref = 'IPS-EN1')
                and notes like 'Further enhancement approved — ₹95,000%'), 'second enhancement is in the history');
reset role;
select 'ALL PAYER MASTER TESTS PASSED' as result;
