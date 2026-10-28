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

select t.check((select name = 'The Oriental Insurance' from clm_payers where id = clm_match_payer('Oriental Insurance Co. Ltd', 'Medi Assist TPA', null)), 'payer: insurer over TPA, "The" skipped');
select t.check((select name = 'Medi Assist TPA' from clm_payers where id = clm_match_payer(null, 'MEDI ASSIST INDIA TPA PVT LTD', null)), 'payer: TPA when no insurer named');
select t.check(clm_match_payer('Thermo corp', null, null) is null, 'payer: no false match on partial words');

-- ─── 4c. PMJAY case with several invoices (dialysis): paid once for the case ─
select t.check((select (r->>'matched')::int = 1 and (r->>'created')::int = 3
                from (select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'pmjay_week4.xlsx', $j$[
  {"source":"pmjay","claim_ref":"5550000000000001","claimed_amount":7260,"tds_amount":145.2,"net_amount":7114.8,"utr":"DIAL1","payment_date":"2026-10-25",
   "bills":[{"bill_no":"PM/D1","claimed_amount":2420,"bill_date":"2026-10-01"},{"bill_no":"PM/D2","claimed_amount":2420,"bill_date":"2026-10-04"},{"bill_no":"PM/D3","claimed_amount":2420,"bill_date":"2026-10-08"}]}
]$j$::jsonb) r) x), 'one payment for a 3-invoice case');
select t.check((select count(*) = 3 and bool_and(recon_status = 'settled') and sum(allocated) = 7114.8 and sum(tds) = 145.2
                from clm_v_receivable_balance where bill_no like 'PM/D%'), 'case payment spread over its invoices, each settled');
select t.check((select (r->>'duplicate')::int = 1 from (select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'again', $j$[
  {"source":"pmjay","claim_ref":"5550000000000001","claimed_amount":7260,"tds_amount":145.2,"net_amount":7114.8,"utr":"DIAL1","payment_date":"2026-10-25",
   "bills":[{"bill_no":"PM/D1","claimed_amount":2420},{"bill_no":"PM/D2","claimed_amount":2420},{"bill_no":"PM/D3","claimed_amount":2420}]}
]$j$::jsonb) r) x), 'case re-upload is a duplicate');
-- case paid for 2 of its 3 invoices: the third stays open as short
select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'pmjay_week5.xlsx', $j$[
  {"source":"pmjay","claim_ref":"5550000000000002","claimed_amount":45540,"tds_amount":607.2,"net_amount":29752.8,"utr":"DIAL2","payment_date":"2026-10-25",
   "bills":[{"bill_no":"PM/E1","claimed_amount":15180},{"bill_no":"PM/E2","claimed_amount":15180},{"bill_no":"PM/E3","claimed_amount":15180}]}
]$j$::jsonb);
select t.check((select string_agg(bill_no || ':' || recon_status, ',' order by bill_no) = 'PM/E1:settled,PM/E2:settled,PM/E3:open'
                from clm_v_receivable_balance where bill_no like 'PM/E%'), 'part-paid case: earlier invoices settled, last still due');

-- ─── 5. Lines with no reference are skipped; read-only users blocked ─
select t.check((select (r->>'skipped')::int = 1 from (select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'x', '[{"net_amount":10}]') r) x),
               'line with no claim or bill no is skipped');
select t.act_as('00000000-0000-0000-0000-0000000000f1');
select t.expect_error($$ select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'x', '[]') $$, 'Read-only');
select t.act_as('00000000-0000-0000-0000-0000000000d2');
select t.expect_error($$ select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'x', '[]') $$, 'No access');
select t.check((select count(*) = 0 from clm_v_exceptions), 'other hospital sees no mismatches');

-- ─── 6. Review fixes ────────────────────────────────────────────────
select t.act_as('00000000-0000-0000-0000-0000000000d1');

-- 6a. a case that gains an invoice next week is the same payment; the new invoice is created and stays due
select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'w1', $j$[
  {"source":"pmjay","claim_ref":"7770000000000001","claimed_amount":4840,"tds_amount":96.8,"net_amount":4743.2,"utr":"U77","payment_date":"2026-10-20",
   "bills":[{"bill_no":"Q1","claimed_amount":2420},{"bill_no":"Q2","claimed_amount":2420}]}]$j$::jsonb);
select t.check((select (r->>'duplicate')::int = 1 and (r->>'created')::int = 1 and (r->>'unpaid')::int = 1
                from (select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'w2', $j$[
  {"source":"pmjay","claim_ref":"7770000000000001","claimed_amount":4840,"tds_amount":96.8,"net_amount":4743.2,"utr":"u77","payment_date":"2026-10-20",
   "bills":[{"bill_no":"Q2","claimed_amount":2420},{"bill_no":"Q1","claimed_amount":2420}]},
  {"source":"pmjay","claim_ref":"7770000000000001","claimed_amount":2420,"net_amount":0,"bills":[{"bill_no":"Q3","claimed_amount":2420}]}]$j$::jsonb) r) x),
  'case re-sent with rows reordered + a new unpaid invoice: payment not repeated, new invoice created');
select t.check((select sum(amount) = 4743.2 from clm_receipts where upper(reference) = 'U77'), 'case cash counted once');
select t.check((select recon_status = 'open' and balance = 2420 from clm_v_receivable_balance where bill_no = 'Q3'), 'new invoice still due');

-- 6b. same payment from a PDF and later from the TPA Excel (claim no written differently, no bill no)
select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'letter.pdf', $j$[
  {"source":"letter","payer_name":"HDFC ERGO","claim_ref":"CLM/2026/991","bill_no":"IPB-55","claimed_amount":50000,"tds_amount":1000,"net_amount":49000,"utr":"HDFC991","payment_date":"2026-10-21"}]$j$::jsonb);
select t.check((select (r->>'duplicate')::int = 1 from (select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'tpa.xlsx', $j$[
  {"source":"letter","payer_name":"HDFC ERGO","claim_ref":"CLM2026991","claimed_amount":50000,"tds_amount":1000,"net_amount":49000,"utr":"hdfc991","payment_date":"2026-10-21"}]$j$::jsonb) r) x),
  'PDF then Excel of the same payment: second is a duplicate');
select t.check((select allocated = 49000 and recon_status = 'settled' from clm_v_receivable_balance where bill_no = 'IPB-55'), 'bill paid once');

-- 6c. letter first, bank statement later: the credit is tied to the letter, not left as new money
insert into clm_receipts (tenant_id, centre_id, source, bank_account, value_date, amount, reference, narration)
values ('a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'bank', 'KOTAK', '2026-10-22', 49000, 'HDFC991', 'NEFT HDFC991 HDFC ERGO');
select t.check((select unallocated = 0 from clm_v_receipt_balance where source = 'bank' and reference = 'HDFC991'),
               'bank credit arriving after the letter shows as already used');
select t.check((select bank_confirmed_on = '2026-10-22' from clm_receipts where source = 'advice' and upper(reference) = 'HDFC991'),
               'letter marked as seen in the bank');

-- 6d. payer from a letter: whole name, not the first word
select t.check((select string_agg(coalesce((select name from clm_payers where id = clm_match_payer(null, v, null)), '—'), ' | ' order by o)
                = 'Vidal Health TPA | Heritage Health TPA | Raksha Health Insurance TPA | Health India Insurance TPA | Star Health and Allied Insurance'
                from (values (1, 'VIDAL HEALTH TPA PVT LTD'), (2, 'Heritage Health TPA'), (3, 'Raksha Health Insurance TPA Pvt Ltd'),
                             (4, 'Health India Insurance TPA Services'), (5, 'Star Health')) x(o, v)),
               'TPAs named "… Health" are told apart');

reset role;
select 'ALL WEEKLY UPLOAD TESTS PASSED' as result;
