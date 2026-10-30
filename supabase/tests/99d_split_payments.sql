-- ════════════════════════════════════════════════════════════════════
-- Payments in parts: one patient paid by several transfers (PMJAY often).
-- The first part does not set the approval, later parts add up, the file
-- closes only when the whole amount is in, and a PMJAY case with several
-- invoices fills each invoice once across transfers.
-- ════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
set client_min_messages = warning;
update clm_tenants set paper_gate = false where id = 'a0000000-0000-0000-0000-000000000001';

set role authenticated;
select t.act_as('00000000-0000-0000-0000-0000000000d1');
insert into clm_claims (tenant_id, centre_id, payer_id, claim_type, patient_name, admission_ref, admitted_at, estimated_amount, case_source)
select 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001',
       (select id from clm_payers where code = 'medi_assist' and tenant_id is null), 'cashless', p.n, p.ip, now(), 100000, 'manual'
from (values ('Split One Patient', 'IPS-SP1'), ('Split Two Patient', 'IPS-SP2')) p(n, ip);
select clm_transition((select id from clm_claims where admission_ref = 'IPS-SP1'), 'claim_submitted', '{"claimed_amount":100000,"tpa_claim_number":"CL-SP1"}'::jsonb, null);
select clm_transition((select id from clm_claims where admission_ref = 'IPS-SP2'), 'claim_submitted', '{"claimed_amount":80000}'::jsonb, null);
select clm_transition((select id from clm_claims where admission_ref = 'IPS-SP2'), 'claim_approved', '{"approved_amount":80000}'::jsonb, null);

-- 1 · first part by letter, no approved amount on it: the claim is approved at what was claimed, not at the part
select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'part1.xlsx', $$[
  {"claim_ref":"CL-SP1","patient_name":"Split One Patient","net_amount":"40000","tds_amount":"0","utr":"UTR-SP1-A","payment_date":"2026-10-01"}
]$$::jsonb);
select t.check((select status = 'claim_approved' and approved_amount = 100000 from clm_claims where admission_ref = 'IPS-SP1'),
               'a part payment does not set the approval');
select t.check((select allocated = 40000 and balance = 60000 and recon_status = 'part_received' from clm_v_receivable_balance
                where claim_id = (select id from clm_claims where admission_ref = 'IPS-SP1')), 'first part booked, ₹60,000 awaited');

-- 2 · second and third parts (different UTRs) add up and close the file
select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'part2.xlsx', $$[
  {"claim_ref":"CL-SP1","patient_name":"Split One Patient","net_amount":"35000","utr":"UTR-SP1-B","payment_date":"2026-10-10"}
]$$::jsonb);
select t.check((select status = 'claim_approved' from clm_claims where admission_ref = 'IPS-SP1'), 'still open after two parts');
select t.check((select parts = 2 and received = 75000 from clm_v_case_banked
                where claim_id = (select id from clm_claims where admission_ref = 'IPS-SP1')), 'two parts counted');
-- re-uploading an earlier part changes nothing
select t.check((select (clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'part1-again.xlsx', $$[
  {"claim_ref":"CL-SP1","patient_name":"Split One Patient","net_amount":"40000","utr":"UTR-SP1-A","payment_date":"2026-10-01"}
]$$::jsonb)->>'duplicate')::int = 1), 'an earlier part uploaded again is ignored');
select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'part3.xlsx', $$[
  {"claim_ref":"CL-SP1","patient_name":"Split One Patient","net_amount":"25000","utr":"UTR-SP1-C","payment_date":"2026-10-20"}
]$$::jsonb);
select t.check((select status = 'settled' and settled_amount = 100000 and deduction_amount = 0 from clm_claims where admission_ref = 'IPS-SP1'),
               'closed when the last part makes up the whole');

-- 3 · parts typed on Master add up the same way
select clm_record_case_payment((select id from clm_claims where admission_ref = 'IPS-SP2'), 50000, 0, 'UTR-SP2-A', '2026-10-05');
select t.check((select status = 'claim_approved' from clm_claims where admission_ref = 'IPS-SP2'), 'typed part: file stays open');
select clm_record_case_payment((select id from clm_claims where admission_ref = 'IPS-SP2'), 30000, 0, 'UTR-SP2-B', '2026-10-15');
select t.check((select status = 'settled' and settled_amount = 80000 from clm_claims where admission_ref = 'IPS-SP2'),
               'typed second part closes the file');

-- 4 · PMJAY: one case, two invoices, paid in two transfers — each invoice is filled once
select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'pmjay1.xlsx', $$[
  {"source":"pmjay","claim_ref":"PM-SP9","payer_name":"PMJAY / MA (Gujarat)","net_amount":"9000","tds_amount":"1000","utr":"UTR-PM-A","payment_date":"2026-10-02",
   "bills":[{"bill_no":"INV-SP9-1","patient_name":"Pmjay Split","claimed_amount":"10000"},{"bill_no":"INV-SP9-2","patient_name":"Pmjay Split","claimed_amount":"10000"}]}
]$$::jsonb);
select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'pmjay2.xlsx', $$[
  {"source":"pmjay","claim_ref":"PM-SP9","payer_name":"PMJAY / MA (Gujarat)","net_amount":"9000","tds_amount":"1000","utr":"UTR-PM-B","payment_date":"2026-10-12",
   "bills":[{"bill_no":"INV-SP9-1","patient_name":"Pmjay Split","claimed_amount":"10000"},{"bill_no":"INV-SP9-2","patient_name":"Pmjay Split","claimed_amount":"10000"}]}
]$$::jsonb);
select t.check((select bool_and(abs(balance) <= 1) and count(*) = 2 and sum(allocated) = 18000 and bool_and(expected_amount = 10000)
                from clm_v_receivable_balance where bill_no in ('INV-SP9-1','INV-SP9-2')),
               'PMJAY second transfer fills the second invoice, not the first again');

reset role;
select 'ALL SPLIT PAYMENT TESTS PASSED' as result;
