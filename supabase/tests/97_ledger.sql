-- ════════════════════════════════════════════════════════════════════
-- Ledger mode: with the paper gate off a file moves on dates and amounts
-- alone; a typed-in payment books like a letter line, and the cut then
-- waits for Accept / Fight exactly as for an uploaded letter.
-- ════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
set client_min_messages = warning;
update clm_tenants set paper_gate = false where id = 'a0000000-0000-0000-0000-000000000001';

set role authenticated;
select t.act_as('00000000-0000-0000-0000-0000000000d1');
insert into clm_claims (tenant_id, centre_id, payer_id, claim_type, patient_name, admission_ref, admitted_at, estimated_amount, case_source)
select 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001',
       (select id from clm_payers where code = 'medi_assist' and tenant_id is null), 'cashless', p.n, p.ip, now(), 50000, 'manual'
from (values ('Ledger One Patient', 'IPS-LG1'), ('Ledger Two Patient', 'IPS-LG2'), ('Ledger Three Patient', 'IPS-LG3')) p(n, ip);

-- L1: the whole journey with no paper ticked
select clm_transition((select id from clm_claims where admission_ref = 'IPS-LG1'), 'preauth_pending', '{"tpa_preauth_number":"PA-L1"}'::jsonb, null);
select t.check((select status = 'preauth_pending' and preauth_submitted_at is not null from clm_claims where admission_ref = 'IPS-LG1'),
               'pre-auth sent without papers when the gate is off');
select clm_transition((select id from clm_claims where admission_ref = 'IPS-LG1'), 'preauth_approved', '{"approved_amount":50000}'::jsonb, null);
select t.check((select preauth_approved_amount = 50000 from clm_claims where admission_ref = 'IPS-LG1'), 'pre-auth approval kept on its own');
update clm_claims set discharged_at = now(), discharge_date = current_date where admission_ref = 'IPS-LG1';
select clm_transition((select id from clm_claims where admission_ref = 'IPS-LG1'), 'claim_submitted', '{"claimed_amount":52000,"tpa_claim_number":"CL-L1"}'::jsonb, null);
select t.expect_error($$ select clm_record_case_payment((select id from clm_claims where admission_ref = 'IPS-LG1'), 49000, 1000, 'UTR-L1', null) $$,
                      'approved amount before the payment');
select clm_transition((select id from clm_claims where admission_ref = 'IPS-LG1'), 'claim_partial', '{"approved_amount":50000}'::jsonb, 'Non payable items — consumables');

-- a viewer cannot type a payment; zero is refused
select t.act_as('00000000-0000-0000-0000-0000000000f1');
select t.expect_error($$ select clm_record_case_payment((select id from clm_claims where admission_ref = 'IPS-LG1'), 49000, 1000, 'UTR-L1', null) $$, 'read-only');
select t.act_as('00000000-0000-0000-0000-0000000000d1');
select t.expect_error($$ select clm_record_case_payment((select id from clm_claims where admission_ref = 'IPS-LG1'), 0, 0, null, null) $$, 'amount received');

select clm_record_case_payment((select id from clm_claims where admission_ref = 'IPS-LG1'), 49000, 1000, 'UTR-L1', '2026-10-28');
select t.check((select allocated = 49000 and tds = 1000 and balance = 0 from clm_v_receivable_balance
                where claim_id = (select id from clm_claims where admission_ref = 'IPS-LG1')), 'typed payment booked with TDS');
select t.check((select status = 'claim_partial' from clm_claims where admission_ref = 'IPS-LG1'), '₹2,000 cut waits for Accept / Fight');
select t.expect_error($$ select clm_record_case_payment((select id from clm_claims where admission_ref = 'IPS-LG1'), 49000, 1000, 'UTR-L1', '2026-10-28') $$,
                      'already entered');

-- fight, then the insurer pays the balance → closes in full
select clm_decide_cut((select id from clm_claims where admission_ref = 'IPS-LG1'), 'fight', 'Items are payable as per the policy terms');
select t.check((select balance = 2000 and recon_status = 'disputed' from clm_v_receivable_balance
                where claim_id = (select id from clm_claims where admission_ref = 'IPS-LG1')), 'fighting: ₹2,000 due');
select clm_record_case_payment((select id from clm_claims where admission_ref = 'IPS-LG1'), 2000, 0, 'UTR-L1B', '2026-11-12');
select t.check((select preauth_approved_amount = 50000 and approved_amount = 50000 from clm_claims where admission_ref = 'IPS-LG1'), 'claim approval did not move the pre-auth figure');
select t.check((select status = 'settled' and deduction_amount = 0 and settled_amount = 51000 from clm_claims where admission_ref = 'IPS-LG1'),
               'won: settled in full from typed payments');

-- L2: paid ₹500 short of the approval → accept with a reason → closes
select clm_transition((select id from clm_claims where admission_ref = 'IPS-LG2'), 'claim_submitted', '{"claimed_amount":30000}'::jsonb, null);
select clm_transition((select id from clm_claims where admission_ref = 'IPS-LG2'), 'claim_approved', '{"approved_amount":30000}'::jsonb, null);
select clm_record_case_payment((select id from clm_claims where admission_ref = 'IPS-LG2'), 29500, 0, 'UTR-L2', null);
select t.check((select status = 'claim_approved' from clm_claims where admission_ref = 'IPS-LG2'), 'short payment keeps the file open');
select clm_decide_cut((select id from clm_claims where admission_ref = 'IPS-LG2'), 'accept', 'Consumables', 'non_payable');
select t.check((select status = 'settled' and deduction_amount = 500 from clm_claims where admission_ref = 'IPS-LG2'), 'accepted short payment closes');

-- the gate, when switched on, still blocks a pre-auth with no papers
reset role;
update clm_tenants set paper_gate = true where id = 'a0000000-0000-0000-0000-000000000001';
set role authenticated;
select t.act_as('00000000-0000-0000-0000-0000000000d1');
select t.expect_error($$ select clm_transition((select id from clm_claims where admission_ref = 'IPS-LG3'), 'preauth_pending', '{}'::jsonb, null) $$,
                      'Submission blocked');
reset role;
update clm_tenants set paper_gate = false where id = 'a0000000-0000-0000-0000-000000000001';
select 'ALL LEDGER TESTS PASSED' as result;
