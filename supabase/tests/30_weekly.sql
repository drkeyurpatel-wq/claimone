-- ════════════════════════════════════════════════════════════════════
-- Weekly payment upload: PMJAY sheet + settlement letters.
-- Runs after 20_receivables.sql (same database, same fixtures).
-- ════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
set client_min_messages = warning;
set role authenticated;
select t.act_as('00000000-0000-0000-0000-0000000000d1');

-- A bill the team already has on file (approved ₹1,00,000, claim CL-77/1)
insert into clm_receivables (id, tenant_id, centre_id, debtor_type, debtor_name, bill_no, claim_ref, bill_date, patient_name, expected_amount, source)
values ('e0000000-0000-0000-0000-000000000077', 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001',
        'tpa', 'Medi Assist', 'IPB126/2001', 'CL-77/1', '2026-09-01', 'Test Patient A', 100000, 'import');

-- ─── 1. PMJAY sheet: paid in full, paid less, paid more, not paid ───
select t.check((select (r->>'matched')::int = 3 and (r->>'created')::int = 4 and (r->>'unpaid')::int = 1
                from (select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'pmjay_week1.xlsx', $j$[
  {"source":"pmjay","bill_no":"PM/1","claim_ref":"1234567890123456","patient_name":"P One","claimed_amount":41250,"tds_amount":825,"net_amount":40425,"utr":"UTRA1","payment_date":"2026-10-20","bill_date":"2026-09-10"},
  {"source":"pmjay","bill_no":"PM/2","claim_ref":"1234567890123457","patient_name":"P Two","claimed_amount":41250,"tds_amount":658.36,"net_amount":32259.64,"utr":"UTRA1","payment_date":"2026-10-20","bill_date":"2026-09-11"},
  {"source":"pmjay","bill_no":"PM/3","claim_ref":"1234567890123458","patient_name":"P Three","claimed_amount":3300,"tds_amount":100,"net_amount":4900,"utr":"UTRA2","payment_date":"2026-10-20","bill_date":"2026-09-12"},
  {"source":"pmjay","bill_no":"PM/4","claim_ref":"1234567890123459","patient_name":"P Four","claimed_amount":60390,"net_amount":0,"bill_date":"2026-08-01"}
]$j$::jsonb) r) x), 'PMJAY sheet: 3 payments matched, 4 bills created, 1 unpaid');

select t.check((select recon_status = 'settled' from clm_v_receivable_balance where bill_no = 'PM/1'), 'paid in full is settled');
select t.check((select expected_amount = 5000 and recon_status = 'settled' from clm_v_receivable_balance where bill_no = 'PM/3'),
               'PMJAY paid above the claim: the paid amount is what was owed');
select t.check((select problem = 'short' and round(balance) = 8332 from clm_v_exceptions where bill_no = 'PM/2'),
               'paid less with no reason shows as a mismatch');
select t.check((select problem = 'overdue' and debtor_type = 'government' from clm_v_exceptions where bill_no = 'PM/4'),
               'unpaid PMJAY bill past 45 days is overdue');
select t.check((select count(*) = 2 from clm_v_exceptions where bill_no like 'PM/%'), 'only the 2 problems are listed');
select t.check((select count(*) = 2 from clm_receipts where source = 'advice' and reference = 'UTRA1'), 'one receipt per bill on a bulk UTR');

-- ─── 2. Uploading the same sheet next week changes nothing ──────────
select t.check((select (r->>'matched')::int = 0 and (r->>'duplicate')::int = 3 and (r->>'created')::int = 0
                from (select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'pmjay_week2.xlsx', $j$[
  {"source":"pmjay","bill_no":"PM/1","claim_ref":"1234567890123456","claimed_amount":41250,"tds_amount":825,"net_amount":40425,"utr":"UTRA1","payment_date":"2026-10-20"},
  {"source":"pmjay","bill_no":"PM/2","claim_ref":"1234567890123457","claimed_amount":41250,"tds_amount":658.36,"net_amount":32259.64,"utr":"UTRA1","payment_date":"2026-10-20"},
  {"source":"pmjay","bill_no":"PM/3","claim_ref":"1234567890123458","claimed_amount":3300,"tds_amount":100,"net_amount":4900,"utr":"UTRA2","payment_date":"2026-10-20"}
]$j$::jsonb) r) x), 're-upload: all 3 recognised as already done');
select t.check((select allocated = 40425 from clm_v_receivable_balance where bill_no = 'PM/1'), 'nothing counted twice');

-- ─── 3. TPA letter for a bill on file, matched by claim no ──────────
select t.check((select (r->>'matched')::int = 1 and (r->>'created')::int = 0
                from (select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'letter.pdf', $j$[
  {"source":"letter","payer_name":"Medi Assist","claim_ref":"cl 77-1","approved_amount":100000,"tds_amount":2000,"deduction_amount":3000,"deduction_reason":"Room rent capping","net_amount":95000,"utr":"MAUTR9","payment_date":"2026-10-22"}
]$j$::jsonb) r) x), 'letter matched to the bill by claim no (spacing/punctuation ignored)');
select t.check((select recon_status = 'settled' and deduction = 3000 and tds = 2000 from clm_v_receivable_balance where id = 'e0000000-0000-0000-0000-000000000077'),
               'letter with a reason settles the bill');
select t.check((select category = 'room_rent_cap' from clm_adjustments where receivable_id = 'e0000000-0000-0000-0000-000000000077' and kind = 'deduction'),
               'deduction reason is categorised');

-- ─── 4. Letter for a bill not on file creates it ────────────────────
select t.check((select (r->>'created')::int = 1 and (r->>'matched')::int = 1
                from (select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'letter2.pdf', $j$[
  {"source":"letter","payer_name":"HDFC ERGO","tpa_name":"Health India","claim_ref":"RC-NEW-1","bill_no":"IPB126/3000","patient_name":"P Five","claimed_amount":50000,"approved_amount":45000,"tds_amount":900,"deduction_amount":5000,"net_amount":44100,"utr":"HDF1","payment_date":"2026-10-23"}
]$j$::jsonb) r) x), 'new bill created from a letter');
select t.check((select debtor_name = 'HDFC ERGO General Insurance' and expected_amount = 50000 and problem = 'short' and balance = 5000
                from clm_v_exceptions where bill_no = 'IPB126/3000'),
               'deduction with no reason stays on the mismatch list');

-- ─── 4b. Bank credit already in: the letter uses it, no second receipt ─
insert into clm_receipts (tenant_id, centre_id, source, bank_account, value_date, amount, reference, narration)
values ('a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'bank', 'AXIS-1', '2026-10-24', 30000, 'BULKUTR1', 'NEFT BULKUTR1 PMJAY');
select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'pmjay_week3.xlsx', $j$[
  {"source":"pmjay","bill_no":"PM/10","claim_ref":"9990000000000001","claimed_amount":10000,"tds_amount":200,"net_amount":9800,"utr":"bulkutr1","payment_date":"2026-10-24"},
  {"source":"pmjay","bill_no":"PM/11","claim_ref":"9990000000000002","claimed_amount":20600,"tds_amount":400,"net_amount":20200,"utr":"BULKUTR1","payment_date":"2026-10-24"}
]$j$::jsonb);
select t.check((select unallocated = 0 from clm_v_receipt_balance where reference = 'BULKUTR1' and source = 'bank')
               and (select count(*) = 0 from clm_receipts where source = 'advice' and upper(reference) = 'BULKUTR1'),
               'bulk bank credit is used for both bills; no extra receipts');

-- ─── 5. Lines with no reference are skipped; read-only users blocked ─
select t.check((select (r->>'skipped')::int = 1 from (select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'x', '[{"net_amount":10}]') r) x),
               'line with no claim or bill no is skipped');
select t.act_as('00000000-0000-0000-0000-0000000000f1');
select t.expect_error($$ select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'x', '[]') $$, 'Read-only');
select t.act_as('00000000-0000-0000-0000-0000000000d2');
select t.expect_error($$ select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'x', '[]') $$, 'No access');
select t.check((select count(*) = 0 from clm_v_exceptions), 'other hospital sees no mismatches');

reset role;
select 'ALL WEEKLY UPLOAD TESTS PASSED' as result;
