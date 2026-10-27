-- ════════════════════════════════════════════════════════════════════
-- Receivables & reconciliation rules. Runs after 10_rules.sql (same
-- database, same fixtures).
-- ════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
set client_min_messages = warning;
set role authenticated;

-- ─── 1. Approved claims become receivables ──────────────────────────
select t.act_as('00000000-0000-0000-0000-0000000000d1');
select t.check((select expected_amount = 42000 and debtor_type = 'insurer' and source = 'claim'
                from clm_receivables where claim_id = 'c0000000-0000-0000-0000-000000000001'),
               'part-approved claim created a receivable for the approved amount');

-- ─── 2. Import receivables and a bank receipt ───────────────────────
insert into clm_receivables (id, tenant_id, centre_id, debtor_type, payer_id, debtor_name, bill_no, claim_ref, bill_date, patient_name, expected_amount, source)
select 'e0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001',
       'insurer', id, 'HDFC ERGO', 'IPB126/1483', 'RC-HS26-15769732_1', '2026-06-30', 'Gitaben Patel', 406196, 'import'
from clm_payers where code = 'hdfc_ergo';
insert into clm_receivables (id, tenant_id, centre_id, debtor_type, debtor_name, bill_no, bill_date, patient_name, care_of, expected_amount, source)
values ('e0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001',
        'patient', 'Aashish Soni', 'CR-IPS126821', '2026-06-25', 'Aashish Soni', 'C/O Dr Kathan Talsania', 600000, 'import');

select t.expect_error($$ insert into clm_receivables (tenant_id, centre_id, debtor_type, debtor_name, bill_no, bill_date, expected_amount)
  values ('a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'insurer', 'X', 'IPB126/1483', '2026-06-30', 1) $$,
  'duplicate key');

insert into clm_receipts (id, tenant_id, centre_id, source, bank_account, value_date, amount, reference, narration)
values ('f0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001',
        'bank', 'KOTAK-0945694616', '2026-07-11', 405611, 'HDFCH01122534620', 'NEFT HDFCH01122534620 HDFC ERGO GENERAL');
select t.expect_error($$ insert into clm_receipts (tenant_id, centre_id, source, bank_account, value_date, amount, reference, narration)
  values ('a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'bank', 'KOTAK-0945694616', '2026-07-11', 405611,
          'HDFCH01122534620', 'NEFT HDFCH01122534620 HDFC ERGO GENERAL') $$, 'duplicate key');

-- ─── 3. Match, with the short-payment explained ─────────────────────
select t.expect_error($$ select clm_confirm_matches('[{"receipt_id":"f0000000-0000-0000-0000-000000000001","receivable_id":"e0000000-0000-0000-0000-000000000001","amount":405611,"method":"utr","adjustments":[{"kind":"deduction","amount":585}]}]') $$,
  'deduction|category');
select clm_confirm_matches('[{"receipt_id":"f0000000-0000-0000-0000-000000000001","receivable_id":"e0000000-0000-0000-0000-000000000001","amount":405611,"method":"utr","adjustments":[{"kind":"deduction","amount":585,"category":"non_payable","reason_text":"Consumables not payable per settlement letter"}]}]');
select t.check((select recon_status = 'settled' and balance = 0 and allocated = 405611 and deduction = 585
                from clm_v_receivable_balance where id = 'e0000000-0000-0000-0000-000000000001'),
               'receipt + explained deduction settle the receivable');
select t.check((select unallocated = 0 from clm_v_receipt_balance where id = 'f0000000-0000-0000-0000-000000000001'),
               'receipt fully used');

-- A receipt cannot be used twice
select t.expect_error($$ insert into clm_allocations (receipt_id, receivable_id, amount, method)
  values ('f0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000002', 1000, 'manual') $$, 'left to allocate');

-- ─── 4. Reverse, never edit ─────────────────────────────────────────
select t.expect_error($$ update clm_allocations set amount = 1 where receipt_id = 'f0000000-0000-0000-0000-000000000001' $$, 'cannot be edited');
update clm_allocations set reversed_at = now(), reverse_reason = 'Wrong claim' where receipt_id = 'f0000000-0000-0000-0000-000000000001';
select t.check((select recon_status = 'part_received' and balance = 405611 from clm_v_receivable_balance where id = 'e0000000-0000-0000-0000-000000000001'),
               'reversal puts the money back (deduction stays)');
select t.check((select reversed_by = '00000000-0000-0000-0000-0000000000d1' from clm_allocations where receipt_id = 'f0000000-0000-0000-0000-000000000001'),
               'reversal is stamped with who did it');
select t.expect_error($$ update clm_allocations set reversed_at = now() where receipt_id = 'f0000000-0000-0000-0000-000000000001' $$, 'Already reversed');

-- ─── 5. Write-off needs a manager and a reason ──────────────────────
select t.expect_error($$ insert into clm_adjustments (receivable_id, kind, amount, reason_text)
  values ('e0000000-0000-0000-0000-000000000002', 'write_off', 600000, 'Waived') $$, 'Only a manager');
select t.act_as('00000000-0000-0000-0000-0000000000a1');
select t.expect_error($$ insert into clm_adjustments (receivable_id, kind, amount)
  values ('e0000000-0000-0000-0000-000000000002', 'write_off', 600000) $$, 'reason');
insert into clm_adjustments (receivable_id, kind, amount, reason_text)
values ('e0000000-0000-0000-0000-000000000002', 'write_off', 100000, 'Waived on MD approval');
select t.check((select balance = 500000 and write_off = 100000 from clm_v_receivable_balance where id = 'e0000000-0000-0000-0000-000000000002'),
               'write-off reduces what the patient owes');
select t.expect_error($$ insert into clm_adjustments (receivable_id, kind, amount, reason_text)
  values ('e0000000-0000-0000-0000-000000000002', 'refund_due', 500, 'x') $$, 'check');

-- ─── 6. Roles and tenants ───────────────────────────────────────────
select t.act_as('00000000-0000-0000-0000-0000000000f1');
select t.expect_error($$ select clm_confirm_matches('[]') $$, 'Read-only');
select t.act_as('00000000-0000-0000-0000-0000000000d2');
select t.check((select count(*) from clm_v_receivable_balance) = 0 and (select count(*) from clm_v_receipt_balance) = 0,
               'other hospital sees no receivables or receipts');
select t.expect_error($$ insert into clm_allocations (receipt_id, receivable_id, amount, method)
  values ('f0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000002', 10, 'manual') $$, 'row-level security|different hospitals');

-- ─── 7. Re-importing a tracker row updates it (PostgREST upsert target) ─
select t.act_as('00000000-0000-0000-0000-0000000000d1');
insert into clm_receivables (tenant_id, centre_id, debtor_type, debtor_name, bill_no, bill_date, expected_amount, source)
values ('a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'insurer', 'HDFC ERGO', 'IPB126/1483', '2026-06-30', 406500, 'import')
on conflict (tenant_id, centre_id, debtor_type, bill_no) do update set expected_amount = excluded.expected_amount;
select t.check((select count(*) = 1 and max(expected_amount) = 406500 from clm_receivables where bill_no = 'IPB126/1483'), 'upsert updates in place');

reset role;
select 'ALL RECEIVABLES TESTS PASSED' as result;
