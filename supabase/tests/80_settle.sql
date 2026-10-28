-- ════════════════════════════════════════════════════════════════════
-- When the money on a case's bill is fully accounted for, the claim is
-- settled from it: final approved = received + TDS; deduction = claimed − that.
-- ════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
set client_min_messages = warning;
set role authenticated;
select t.act_as('00000000-0000-0000-0000-0000000000d1');
select clm_import_cases('a1000000-0000-0000-0000-000000000001', 'settle.xlsx',
  '[{"ip_no":"IPS-S1","patient_name":"Test S","sponsor":"TATA AIG"}]'::jsonb);

reset role;
alter table clm_claims disable trigger clm_claims_bu;
update clm_claims set claimed_amount = 42000, approved_amount = 40000, status = 'claim_partial', tpa_claim_number = 'CL-S1' where admission_ref = 'IPS-S1';
alter table clm_claims enable trigger clm_claims_bu;
select t.check((select expected_amount = 40000 from clm_receivables where claim_id = (select id from clm_claims where admission_ref = 'IPS-S1')),
               'approval put ₹40,000 on the book');
insert into clm_receipts (id, tenant_id, centre_id, source, value_date, amount, reference)
values ('e5000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'advice', '2026-10-28', 37000, 'UTR-S1');
insert into clm_allocations (tenant_id, receipt_id, receivable_id, amount, method)
select 'a0000000-0000-0000-0000-000000000001', 'e5000000-0000-0000-0000-000000000001', id, 37000, 'advice'
from clm_receivables where claim_id = (select id from clm_claims where admission_ref = 'IPS-S1');
insert into clm_adjustments (tenant_id, receivable_id, kind, amount, reason_text)
select tenant_id, id, 'tds', 800, 'TDS' from clm_receivables where claim_id = (select id from clm_claims where admission_ref = 'IPS-S1');
select t.check((select status = 'claim_partial' from clm_claims where admission_ref = 'IPS-S1'), 'still open while ₹2,200 is unexplained');

-- the desk gives the reason for the short payment, then accepts the cut → the claim settles itself
set role authenticated;
select t.act_as('00000000-0000-0000-0000-0000000000d1');
insert into clm_adjustments (tenant_id, receivable_id, kind, amount, category, reason_text)
select tenant_id, id, 'deduction', 2200, 'tariff_excess', 'above package' from clm_receivables
where claim_id = (select id from clm_claims where admission_ref = 'IPS-S1');
select t.check((select status = 'claim_partial' from clm_claims where admission_ref = 'IPS-S1'),
               'a ₹4,200 cut waits for a person to accept or fight it');
select clm_decide_cut((select id from clm_claims where admission_ref = 'IPS-S1'), 'accept', 'agreed with TPA');
select t.check((select status = 'settled' and settled_amount = 37000 and tds_amount = 800 and deduction_amount = 4200
                       and approved_amount = 40000 and settlement_utr = 'UTR-S1'
                from clm_claims where admission_ref = 'IPS-S1'), 'claim settled from the money: net 37,000, TDS 800, deduction 4,200');
select t.check((select approved_amount = 37800 and net_amount = approved_amount - tds_amount and deduction_amount = claimed_amount - approved_amount
                       and source = 'recon'
                from clm_settlements where claim_id = (select id from clm_claims where admission_ref = 'IPS-S1')),
               'settlement keeps deduction = claimed − approved and net = approved − TDS');
select t.check((select trigger_source = 'recon' from clm_state_transitions
                where claim_id = (select id from clm_claims where admission_ref = 'IPS-S1') and to_status = 'settled'), 'audit says it came from payments');

reset role;
select 'ALL SETTLE-FROM-PAYMENT TESTS PASSED' as result;
