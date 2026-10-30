-- ════════════════════════════════════════════════════════════════════
-- Desk tools: UTR compulsory, payer queries kept, dispute letters,
-- audit trail with names, money in the bank.
-- ════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
set client_min_messages = warning;
update clm_tenants set paper_gate = false where id = 'a0000000-0000-0000-0000-000000000001';

set role authenticated;
select t.act_as('00000000-0000-0000-0000-0000000000d1');
insert into clm_claims (tenant_id, centre_id, payer_id, claim_type, patient_name, admission_ref, admitted_at, estimated_amount, case_source)
select 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001',
       (select id from clm_payers where code = 'medi_assist' and tenant_id is null), 'cashless', p.n, p.ip, now(), 40000, 'manual'
from (values ('Desk Tools One', 'IPS-DT1'), ('Desk Tools Two', 'IPS-DT2')) p(n, ip);

-- queries: raised with text, replied with text; the reply keeps the first submission date
select clm_transition((select id from clm_claims where admission_ref = 'IPS-DT1'), 'claim_submitted', '{"claimed_amount":40000}'::jsonb, null);
reset role;
update clm_claims set submitted_at = '2026-10-01 12:00+05:30' where admission_ref = 'IPS-DT1';
set role authenticated;
select t.act_as('00000000-0000-0000-0000-0000000000d1');
select clm_transition((select id from clm_claims where admission_ref = 'IPS-DT1'), 'claim_query', '{}'::jsonb, 'Send ICP and lab reports');
select t.check((select q.query_text = 'Send ICP and lab reports' and q.status = 'open' and q.sla_deadline > now() + interval '47 hours'
                from clm_queries q join clm_claims c on c.id = q.claim_id where c.admission_ref = 'IPS-DT1'), 'query kept with its text and 48 h deadline');
select t.check((select is_query_pending from clm_claims where admission_ref = 'IPS-DT1'), 'case shows a pending query');
select clm_transition((select id from clm_claims where admission_ref = 'IPS-DT1'), 'claim_submitted', '{}'::jsonb, 'ICP and reports uploaded on portal');
select t.check((select q.status = 'responded' and q.response_text = 'ICP and reports uploaded on portal' and q.responded_at is not null
                from clm_queries q join clm_claims c on c.id = q.claim_id where c.admission_ref = 'IPS-DT1'), 'reply closes the query');
select t.check((select query_replied_at is not null and submitted_at = '2026-10-01 12:00+05:30' and not is_query_pending
                from clm_claims where admission_ref = 'IPS-DT1'), 'reply stamped, original submission date kept');

-- UTR compulsory on a typed payment
select clm_transition((select id from clm_claims where admission_ref = 'IPS-DT1'), 'claim_partial', '{"approved_amount":36000}'::jsonb, 'Non-payable items — consumables');
select t.expect_error($$ select clm_record_case_payment((select id from clm_claims where admission_ref = 'IPS-DT1'), 35280, 720, null, null) $$, 'UTR');
select t.expect_error($$ select clm_record_case_payment((select id from clm_claims where admission_ref = 'IPS-DT1'), 35280, 720, '  ', null) $$, 'UTR');
select clm_record_case_payment((select id from clm_claims where admission_ref = 'IPS-DT1'), 35280, 720, 'UTR-DT1', '2026-10-28');

-- a reversed entry can be typed again with the same figures (the corrected entry)
select t.expect_error($$ select clm_record_case_payment((select id from clm_claims where admission_ref = 'IPS-DT1'), 35280, 720, 'UTR-DT1', '2026-10-28') $$, 'already entered');
reset role;
update clm_allocations set reversed_at = now(), reverse_reason = 'test'
where receivable_id = (select r.id from clm_receivables r join clm_claims c on c.id = r.claim_id where c.admission_ref = 'IPS-DT1');
update clm_adjustments set reversed_at = now()
where receivable_id = (select r.id from clm_receivables r join clm_claims c on c.id = r.claim_id where c.admission_ref = 'IPS-DT1');
set role authenticated;
select t.act_as('00000000-0000-0000-0000-0000000000d1');
select clm_record_case_payment((select id from clm_claims where admission_ref = 'IPS-DT1'), 35280, 720, 'UTR-DT1', '2026-10-28');
select t.check((select allocated = 35280 and tds = 720 from clm_v_receivable_balance
                where claim_id = (select id from clm_claims where admission_ref = 'IPS-DT1')), 're-entered after reversal');

-- not in the bank until a bank credit carries it
select t.check((select banked = 0 and received = 35280 from clm_v_case_banked
                where claim_id = (select id from clm_claims where admission_ref = 'IPS-DT1')), 'typed payment: not yet in the bank');
reset role;
insert into clm_receipts (tenant_id, centre_id, source, bank_account, value_date, amount, reference, narration)
values ('a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'bank', 'Kotak 0945', '2026-10-28', 35280, 'UTR-DT1', 'NEFT MEDI ASSIST UTR-DT1');
set role authenticated;
select t.act_as('00000000-0000-0000-0000-0000000000d1');
select t.check((select banked = 35280 from clm_v_case_banked
                where claim_id = (select id from clm_claims where admission_ref = 'IPS-DT1')), 'bank credit with the same UTR: in the bank');

-- dispute letters: only for a disputed deduction; the follow-up runs from the letter
select t.expect_error($$ select clm_record_dispute_letter((select id from clm_claims where admission_ref = 'IPS-DT1'), 1) $$, 'disputed first');
select clm_decide_cut((select id from clm_claims where admission_ref = 'IPS-DT1'), 'fight', 'Consumables are part of the package');
select clm_record_dispute_letter((select id from clm_claims where admission_ref = 'IPS-DT1'), 1);
select t.check((select dispute_level = 1 and dispute_sent_at is not null from clm_claims where admission_ref = 'IPS-DT1'), 'letter 1 recorded');
select clm_record_dispute_letter((select id from clm_claims where admission_ref = 'IPS-DT1'), 2);
select clm_record_dispute_letter((select id from clm_claims where admission_ref = 'IPS-DT1'), 1);
select t.check((select dispute_level = 2 from clm_claims where admission_ref = 'IPS-DT1'), 'level never goes back down');

-- audit trail: edits, payments and letters, each with the person's name
update clm_claims set discharge_date = '2026-10-20', estimated_amount = 45000 where admission_ref = 'IPS-DT2';
update clm_claims set patient_name = 'Desk Tools Two Corrected' where admission_ref = 'IPS-DT2';
select t.check((select count(*) = 3 from clm_v_timeline v join clm_claims c on c.id = v.claim_id
                where c.admission_ref = 'IPS-DT2' and v.event_type = 'field_changed' and v.actor_name is not null), 'edits logged with the name');
select t.check((select bool_and(v.event_text not like '%Desk Tools%') from clm_v_timeline v join clm_claims c on c.id = v.claim_id
                where c.admission_ref = 'IPS-DT2'), 'patient name not copied into the history');
select t.check((select count(*) = 2 from clm_v_timeline v join clm_claims c on c.id = v.claim_id
                where c.admission_ref = 'IPS-DT1' and v.event_type = 'payment' and v.event_text like '%35,280%UTR-DT1%' and v.actor_name is not null),
               'both entries in the history with UTR and name');
select t.check((select count(*) = 1 from clm_v_timeline v join clm_claims c on c.id = v.claim_id
                where c.admission_ref = 'IPS-DT1' and v.event_type = 'payment_reversed'), 'the reversal is in the history');
select t.check((select count(*) = 3 from clm_v_timeline v join clm_claims c on c.id = v.claim_id
                where c.admission_ref = 'IPS-DT1' and v.event_type = 'dispute_letter'), 'letters in the history');
select t.check((select count(*) >= 1 from clm_v_timeline v join clm_claims c on c.id = v.claim_id
                where c.admission_ref = 'IPS-DT1' and v.event_text like 'Deduction disputed%'), 'dispute decision in the history');

-- a viewer cannot record a letter
select t.act_as('00000000-0000-0000-0000-0000000000f1');
select t.expect_error($$ select clm_record_dispute_letter((select id from clm_claims where admission_ref = 'IPS-DT1'), 2) $$, 'read-only');
reset role;
select 'ALL DESK TOOLS TESTS PASSED' as result;
