-- ════════════════════════════════════════════════════════════════════
-- Review fixes (0027–0029): a switched-off payer stays off, letter
-- approval only inside an upload, one-step reversal of a payment entry.
-- ════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
set client_min_messages = warning;
set role authenticated;
select t.act_as('00000000-0000-0000-0000-0000000000d1');

-- 1 · a payer switched off is not switched back on from the admission form
select clm_add_payer('Review Fix Corporate Ltd', 'corporate');
reset role;
update clm_payers set is_active = false where name = 'Review Fix Corporate Ltd';
set role authenticated;
select t.act_as('00000000-0000-0000-0000-0000000000d1');
select t.expect_error($$select clm_add_payer('Review Fix Corporate Ltd', 'corporate')$$, 'switched off');
select t.check((select not is_active from clm_payers where name = 'Review Fix Corporate Ltd'), 'payer stays switched off');

-- 2 · approving from a letter is not a direct API call
insert into clm_claims (tenant_id, centre_id, payer_id, claim_type, patient_name, admission_ref, admitted_at, case_source)
select 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001',
       (select id from clm_payers where code = 'medi_assist' and tenant_id is null), 'cashless', 'Review Fix Patient', 'IPS-RF1', now(), 'manual';
select clm_transition((select id from clm_claims where admission_ref = 'IPS-RF1'), 'claim_submitted', '{"claimed_amount":20000}'::jsonb, null);
select t.check((select not clm_approve_from_letter((select id from clm_claims where admission_ref = 'IPS-RF1'), '{"approved_amount":"20000"}'::jsonb)),
               'direct call does not approve');
select t.check((select status = 'claim_submitted' from clm_claims where admission_ref = 'IPS-RF1'), 'claim still submitted');

-- 3 · reversing a payment entry takes its TDS with it, in one step
select clm_transition((select id from clm_claims where admission_ref = 'IPS-RF1'), 'claim_approved', '{"approved_amount":20000}'::jsonb, null);
select clm_record_case_payment((select id from clm_claims where admission_ref = 'IPS-RF1'), 9000, 1000, 'UTR-RF1', '2026-10-20');
select clm_reverse_payment((select a.id from clm_allocations a join clm_receivables r on r.id = a.receivable_id
                            join clm_claims c on c.id = r.claim_id where c.admission_ref = 'IPS-RF1' and a.reversed_at is null), 'Typed wrong');
select t.check((select allocated = 0 and tds = 0 and balance = 20000 from clm_v_receivable_balance
                where claim_id = (select id from clm_claims where admission_ref = 'IPS-RF1')), 'payment and TDS both reversed');
select t.expect_error($$select clm_reverse_payment((select a.id from clm_allocations a join clm_receivables r on r.id = a.receivable_id
                            join clm_claims c on c.id = r.claim_id where c.admission_ref = 'IPS-RF1' limit 1), 'again')$$, 'already reversed');

reset role;
select 'ALL REVIEW FIX TESTS PASSED' as result;
