-- ════════════════════════════════════════════════════════════════════
-- An uploaded settlement letter fills the row by itself: it finds a
-- Master patient that has no bill yet, marks the claim approved from the
-- letter, books the payment and closes the file.
-- ════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
set client_min_messages = warning;
update clm_tenants set paper_gate = false where id = 'a0000000-0000-0000-0000-000000000001';

set role authenticated;
select t.act_as('00000000-0000-0000-0000-0000000000d1');
insert into clm_claims (tenant_id, centre_id, payer_id, claim_type, patient_name, admission_ref, admitted_at, estimated_amount, case_source)
select 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001',
       (select id from clm_payers where code = 'medi_assist' and tenant_id is null), 'cashless', p.n, p.ip, now(), 40000, 'manual'
from (values ('Approve One Patient', 'IPS-AP1'), ('Approve Two Patient', 'IPS-AP2'),
             ('Approve Three Patient', 'IPS-AP3'), ('Approve Four Patient', 'IPS-AP4')) p(n, ip);

select clm_transition((select id from clm_claims where admission_ref = 'IPS-AP1'), 'claim_submitted', '{"claimed_amount":40000,"tpa_claim_number":"CL-AP1"}'::jsonb, null);
select clm_transition((select id from clm_claims where admission_ref = 'IPS-AP2'), 'claim_submitted', '{"claimed_amount":30000}'::jsonb, null);
select clm_transition((select id from clm_claims where admission_ref = 'IPS-AP4'), 'claim_submitted', '{"claimed_amount":50000}'::jsonb, null);
select clm_transition((select id from clm_claims where admission_ref = 'IPS-AP4'), 'claim_approved', '{"approved_amount":50000}'::jsonb, null);
select t.check((select count(*) = 0 from clm_receivables r join clm_claims c on c.id = r.claim_id where c.admission_ref in ('IPS-AP1','IPS-AP2','IPS-AP3')),
               'no bill on the book before the letter');

select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'letters.xlsx', $$[
  {"claim_ref":"CL AP1","patient_name":"Approve One Patient","approved_amount":"40000","net_amount":"39200","tds_amount":"800","utr":"UTR-AP1","payment_date":"2026-10-28","payer_name":"Medi Assist"},
  {"claim_ref":"XYZ-999","ip_no":"IPS-AP2","patient_name":"Mr. Approve Two Patient","claimed_amount":"30000","approved_amount":"28000","deduction_amount":"2000","deduction_reason":"Non payable consumables","net_amount":"27440","tds_amount":"560","utr":"UTR-AP2","payment_date":"2026-10-28"},
  {"claim_ref":"C-3","patient_name":"APPROVE THREE PATIENT","net_amount":"10000","utr":"UTR-AP3","payment_date":"2026-10-28"},
  {"claim_ref":"C-4","patient_name":"Approve Four Patient","approved_amount":"45000","net_amount":"45000","utr":"UTR-AP4","payment_date":"2026-10-28"}
]$$::jsonb);

-- by the payer's claim no. (spacing ignored): approved in full → paid → closed
select t.check((select status = 'settled' and approved_amount = 40000 and settled_amount = 39200 and deduction_amount = 0
                from clm_claims where admission_ref = 'IPS-AP1'), 'letter approved and closed a Master patient with no bill');
select t.check((select count(*) = 1 from clm_state_transitions s join clm_claims c on c.id = s.claim_id
                where c.admission_ref = 'IPS-AP1' and s.to_status = 'claim_approved' and s.trigger_source = 'recon'),
               'the approval is in the history as from the letter');
-- by IP no.: approved less than claimed → the ₹2,000 cut waits for Accept / Fight
select t.check((select status = 'claim_partial' and approved_amount = 28000 and claimed_amount = 30000 and tpa_claim_number = 'XYZ-999'
                from clm_claims where admission_ref = 'IPS-AP2'), 'partial approval taken from the letter, claim no. filled in');
select t.check((select allocated = 27440 and tds = 560 from clm_v_receivable_balance
                where claim_id = (select id from clm_claims where admission_ref = 'IPS-AP2')), 'payment and TDS booked on the case');
-- by name, never sent on Master (draft): submitted + approved from what was paid
select t.check((select status = 'settled' and approved_amount = 10000 and claimed_amount = 10000 and submitted_at is not null
                from clm_claims where admission_ref = 'IPS-AP3'), 'draft case submitted, approved and closed from the letter');
-- already approved by the desk: the desk's figure stands
select t.check((select approved_amount = 50000 and status = 'claim_approved' from clm_claims where admission_ref = 'IPS-AP4'),
               'an approval the desk already marked is not changed');

-- the same letter uploaded again changes nothing
select t.check((select (clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'letters-again.xlsx', $$[
  {"claim_ref":"CL AP1","patient_name":"Approve One Patient","approved_amount":"40000","net_amount":"39200","tds_amount":"800","utr":"UTR-AP1","payment_date":"2026-10-28"}
]$$::jsonb)->>'duplicate')::int = 1), 'second upload of the same letter is ignored');
select t.check((select settled_amount = 39200 from clm_claims where admission_ref = 'IPS-AP1'), 'still ₹39,200 after the second upload');

-- a letter with the paper gate on still books the money; the desk marks the approval
insert into clm_claims (tenant_id, centre_id, payer_id, claim_type, patient_name, admission_ref, admitted_at, case_source)
select 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001',
       (select id from clm_payers where code = 'medi_assist' and tenant_id is null), 'cashless', 'Approve Five Patient', 'IPS-AP5', now(), 'manual';
reset role;
update clm_tenants set paper_gate = true where id = 'a0000000-0000-0000-0000-000000000001';
set role authenticated;
select t.act_as('00000000-0000-0000-0000-0000000000d1');
select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'gate.xlsx', $$[
  {"claim_ref":"C-5","patient_name":"Approve Five Patient","net_amount":"5000","utr":"UTR-AP5","payment_date":"2026-10-28"}
]$$::jsonb);
select t.check((select status = 'draft' from clm_claims where admission_ref = 'IPS-AP5'), 'gate on: status left to the desk');
reset role;
update clm_tenants set paper_gate = false where id = 'a0000000-0000-0000-0000-000000000001';
select 'ALL LETTER APPROVAL TESTS PASSED' as result;
