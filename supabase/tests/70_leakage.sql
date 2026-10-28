-- ════════════════════════════════════════════════════════════════════
-- Leakage counts every source: itemised settlement lines, a cut at
-- approval, and a short payment given a reason — never the same rupee twice.
-- ════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
set client_min_messages = warning;
set role authenticated;
select t.act_as('00000000-0000-0000-0000-0000000000d1');
create temp table before as select coalesce(sum(amount), 0) s from clm_v_leakage;

select clm_import_cases('a1000000-0000-0000-0000-000000000001', 'leak.xlsx',
  '[{"ip_no":"IPS-L1","patient_name":"Test L","sponsor":"TATA AIG","doctor":"Dr Leak"}]'::jsonb);

-- approved ₹2,000 less than claimed, reason typed with the decision
reset role;
alter table clm_claims disable trigger clm_claims_bu;
update clm_claims set claimed_amount = 42000, approved_amount = 40000, status = 'claim_partial' where admission_ref = 'IPS-L1';
alter table clm_claims enable trigger clm_claims_bu;
update clm_state_transitions set notes = 'Room rent capped' where claim_id = (select id from clm_claims where admission_ref = 'IPS-L1') and to_status = 'claim_partial';
set role authenticated;

select t.check((select sum(amount) - (select s from before) = 2000 from clm_v_leakage), 'cut at approval counted');
select t.check((select category = 'room_rent_cap' and is_preventable and doctor_name = 'Dr Leak' from clm_v_leakage
                where payer_name like 'Tata%' and month = date_trunc('month', now())::date), 'reason read from the note');

-- then paid ₹2,200 short of the approval, reason given on the Payment stage
insert into clm_adjustments (tenant_id, receivable_id, kind, amount, category, reason_text)
select tenant_id, id, 'deduction', 2200, 'tariff_excess', 'above package' from clm_receivables
where claim_id = (select id from clm_claims where admission_ref = 'IPS-L1');
select t.check((select sum(amount) - (select s from before) = 4200 from clm_v_leakage), 'short payment counted too');

-- itemised settlement lines replace both, never added on top
insert into clm_disallowances (tenant_id, claim_id, kind, category, amount, reason_text)
select tenant_id, id, 'deduction', 'non_payable', 4200, 'itemised' from clm_claims where admission_ref = 'IPS-L1';
select t.check((select sum(amount) - (select s from before) = 4200 from clm_v_leakage), 'no double counting');

reset role;
select 'ALL LEAKAGE TESTS PASSED' as result;
