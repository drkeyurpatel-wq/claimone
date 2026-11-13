-- ════════════════════════════════════════════════════════════════════
-- The PMJAY claim-paid sheet from TMS: every case on it is closed in full
-- (payment, TDS, deduction), old-sheet case IDs that lost their last digit
-- are matched and corrected, nothing is counted twice, and a deduction on
-- a file from 1 Nov needs a reason.
-- ════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
set client_min_messages = warning;
update clm_tenants set paper_gate = false, reason_from = date '2026-11-01' where id = 'a0000000-0000-0000-0000-000000000001';
set role authenticated;
select t.act_as('00000000-0000-0000-0000-0000000000d1');

-- Master: three PMJAY patients, claims submitted
select clm_import_pmjay('a1000000-0000-0000-0000-000000000001', 'desk.xlsx', $$[
  {"ip_no":"IPS-TM1","patient_name":"Tms One","case_no":"2026110110000011","case_status":"Claims Submitted","doctor":"DR A","admitted_on":"2026-11-01","discharged_on":"2026-11-02","nabh_amount":91714,"non_nabh_amount":86634},
  {"ip_no":"IPS-TM2","patient_name":"Tms Two","case_no":"2026110110000022","case_status":"Claims Submitted","doctor":"DR B","admitted_on":"2026-11-01","discharged_on":"2026-11-03","nabh_amount":50000,"non_nabh_amount":45000},
  {"ip_no":"IPS-TM3","patient_name":"Tms Three","case_no":"2026110110000033","case_status":"Claims Submitted","doctor":"DR B","admitted_on":"2026-11-01","discharged_on":"2026-11-03","nabh_amount":30000,"non_nabh_amount":27000}
]$$::jsonb);

-- the old settlement sheet: a short-paid case whose 16-digit ID lost its last digit, and a three-invoice case not yet paid
select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'old.xlsx', $$[
  {"source":"pmjay","payer_name":"PMJAY / MA (Gujarat)","claim_ref":"2026040210047030","bill_no":"INV-OLD1","patient_name":"Old One","bill_date":"2026-04-12","claimed_amount":"309390","net_amount":"160776","tds_amount":"17864","utr":"AXISOLD1","payment_date":"2026-05-13"},
  {"source":"pmjay","payer_name":"PMJAY / MA (Gujarat)","claim_ref":"1003746011","net_amount":"0","tds_amount":"0",
   "bills":[{"bill_no":"INV-D1","patient_name":"Dialysis Pt","claimed_amount":"2420"},{"bill_no":"INV-D2","patient_name":"Dialysis Pt","claimed_amount":"2420"},{"bill_no":"INV-D3","patient_name":"Dialysis Pt","claimed_amount":"2420"}]}
]$$::jsonb);
select t.check((select balance = 130750 and recon_status = 'part_received' from clm_v_receivable_balance where bill_no = 'INV-OLD1'), 'old sheet: the cut sits as money owed');

create temp table res(r jsonb);
create temp table sheet(j jsonb);
insert into sheet values ($$[
  {"source":"pmjay","claim_ref":"2026110110000011","patient_name":"Tms One","bill_date":"2026-11-01","claimed_amount":91714,"approved_amount":91714,"tds_amount":1834,"net_amount":89880,"utr":"AXISCN0001","payment_date":"2026-11-12","speciality":"Cardiology","procedure_code":"MC011A","procedure_name":"PTCA","unique15":true},
  {"source":"pmjay","claim_ref":"2026110110000022","patient_name":"Tms Two","bill_date":"2026-11-01","claimed_amount":50000,"approved_amount":40000,"tds_amount":800,"net_amount":39200,"utr":"AXISCN0002","payment_date":"2026-11-12","speciality":"Urology","procedure_code":"SU033A + SU055A","procedure_name":"DJ stenting + TURBT","unique15":true},
  {"source":"pmjay","claim_ref":"2026110110000033","patient_name":"Tms Three","bill_date":"2026-11-01","claimed_amount":30000,"approved_amount":29500,"tds_amount":590,"net_amount":28910,"utr":"AXISCN0003","payment_date":"2026-11-12","speciality":"Urology","procedure_code":"SU041A","procedure_name":"Cystolithotripsy","unique15":true},
  {"source":"pmjay","claim_ref":"2026040210047037","patient_name":"Old One","bill_date":"2026-04-02","claimed_amount":309390,"approved_amount":178640,"tds_amount":17864,"net_amount":160776,"utr":"AXISOLD1","payment_date":"2026-05-13","deduction_reason":"Claim CRC Insurance Rejected By CRC","speciality":"Cardio-thoracic & Vascular surgery","procedure_code":"SV001A","procedure_name":"CABG","unique15":true},
  {"source":"pmjay","claim_ref":"1003746011","patient_name":"Dialysis Pt","bill_date":"2025-01-25","claimed_amount":6600,"approved_amount":6600,"tds_amount":132,"net_amount":6468,"utr":"AXISCN0005","payment_date":"2025-03-04","speciality":"Nephrology","procedure_code":"MG072A","procedure_name":"Haemodialysis","unique15":true},
  {"source":"pmjay","claim_ref":"1019999999","patient_name":"History Pt","bill_date":"2025-12-01","claimed_amount":15070,"approved_amount":15070,"tds_amount":1507,"net_amount":13563,"utr":"AXISCN0006","payment_date":"2025-12-28","speciality":"Medical Oncology","procedure_code":"MO024A","procedure_name":"Chemo","unique15":true},
  {"source":"pmjay","claim_ref":"","patient_name":"No Id","net_amount":100,"tds_amount":0}
]$$);
insert into res select clm_apply_pmjay_tms('a1000000-0000-0000-0000-000000000001', 'tms.xlsx', (select j from sheet));
select t.check((select r->>'matched' = '5' and r->>'duplicate' = '1' and r->>'created' = '1' and r->>'fixed' = '1' and r->>'skipped' = '1' from res), 'counts: ' || (select r::text from res));

-- 1 · paid in full: the Master file closes and leaves for the Archive
select t.check((select status = 'settled' and settled_amount = 89880 and tds_amount = 1834 and deduction_amount = 0 from clm_claims where admission_ref = 'IPS-TM1'), 'paid in full: settled');
select t.check((select v.balance = 0 and r.speciality = 'Cardiology' and r.procedure_code = 'MC011A' from clm_v_receivable_balance v join clm_receivables r on r.id = v.id
                where v.claim_id = (select id from clm_claims where admission_ref = 'IPS-TM1')), 'nothing owed; speciality and procedure kept');

-- 2 · paid ₹10,000 short: the cut is booked, nothing shows as owed, and the file waits for a reason
select t.check((select status = 'claim_partial' and approved_amount = 40000 from clm_claims where admission_ref = 'IPS-TM2'), 'cut of ₹10,000 waits for a decision');
select t.check((select balance = 0 and allocated = 39200 and tds = 800 from clm_v_receivable_balance
                where claim_id = (select id from clm_claims where admission_ref = 'IPS-TM2')), 'not counted as outstanding');
select t.expect_error($$ select clm_decide_cut((select id from clm_claims where admission_ref = 'IPS-TM2'), 'accept') $$, 'deduction reason');
select t.expect_error($$ select clm_decide_cut((select id from clm_claims where admission_ref = 'IPS-TM2'), 'accept', null, 'other') $$, 'write the deduction reason');
select t.expect_error($$ select clm_decide_cut((select id from clm_claims where admission_ref = 'IPS-TM2'), 'accept', null, 'made_up') $$, 'from the list');
select clm_decide_cut((select id from clm_claims where admission_ref = 'IPS-TM2'), 'accept', null, 'multi_procedure');
select t.check((select status = 'settled' and cut_category = 'multi_procedure' and deduction_amount = 10000 from clm_claims where admission_ref = 'IPS-TM2'), 'accepted with a reason: closed');

-- 3 · a cut under ₹1,000 closes by itself, with the reason still to enter
select t.check((select status = 'settled' from clm_claims where admission_ref = 'IPS-TM3'), 'small cut: closed');
select t.check((select count(*) = 1 from clm_v_deduction_lines where claim_ref = '2026110110000033') and
               (select category = 'unspecified' and amount = 500 and speciality = 'Urology' and doctor_name = 'DR B' and file_date = '2026-11-03'
                from clm_v_deduction_lines where claim_ref = '2026110110000033'), 'small cut listed once, with no reason');
select t.expect_error($$ select clm_set_deduction_reason(null, (select id from clm_claims where admission_ref = 'IPS-TM3'), 'other', ' ') $$, 'write the deduction reason');
select clm_set_deduction_reason(null, (select id from clm_claims where admission_ref = 'IPS-TM3'), 'other', 'Guide wire not paid');
select t.check((select category = 'other' and reason_text = 'Guide wire not paid' from clm_v_deduction_lines where claim_ref = '2026110110000033'), 'reason entered later');
select t.check((select count(*) = 1 and sum(amount) = 10000 and min(category) = 'multi_procedure' from clm_v_deduction_lines where claim_ref = '2026110110000022'), 'accepted cut listed once with its reason');

-- 4 · old sheet, last digit lost: matched, ID corrected, the cut booked, the payment not counted again
select t.check((select claim_ref = '2026040210047037' and balance = 0 and allocated = 160776 and deduction = 130750 and recon_status = 'settled'
                from clm_v_receivable_balance where bill_no = 'INV-OLD1'), 'old short-paid case cleared');
select t.check((select count(*) = 1 from clm_allocations a join clm_receivables r on r.id = a.receivable_id where r.bill_no = 'INV-OLD1'), 'payment not doubled');
select t.check((select reason_text = 'Claim CRC Insurance Rejected By CRC' and category = 'unspecified' from clm_v_deduction_lines where claim_ref = '2026040210047037'), 'the sheet status is kept as the reason text');
select clm_set_deduction_reason((select adjustment_id from clm_v_deduction_lines where claim_ref = '2026040210047037'), null, 'package_mismatch');
select t.check((select category = 'package_mismatch' and is_preventable from clm_v_deduction_lines where claim_ref = '2026040210047037'), 'reason set on an old-sheet deduction');

-- 5 · one case, three invoices: all three cleared by the one payment, at what TMS says was claimed
select t.check((select count(*) = 3 and sum(balance) = 0 and sum(allocated) = 6468 and sum(tds) = 132 and sum(expected_amount) = 6600
                from clm_v_receivable_balance where bill_no like 'INV-D%'), 'three invoices cleared');

-- 6 · a case ClaimOne never had: kept as paid history, dated from the pre-auth
select t.check((select balance = 0 and bill_date = '2025-12-01' and claim_id is null and last_receipt_date = '2025-12-28'
                from clm_v_receivable_balance where claim_ref = '1019999999'), 'history case created, paid');

-- 7 · the same sheet next week changes nothing
create temp table before as select (select count(*) from clm_allocations) a, (select count(*) from clm_adjustments) j, (select count(*) from clm_receivables) r,
                                  (select sum(amount) from clm_allocations where reversed_at is null) amt;
truncate res;
insert into res select clm_apply_pmjay_tms('a1000000-0000-0000-0000-000000000001', 'tms-next-week.xlsx', (select j from sheet));
select t.check((select r->>'matched' = '0' and r->>'duplicate' = '6' and r->>'created' = '0' and r->>'fixed' = '0' from res), 'second upload: all known — ' || (select r::text from res));
select t.check((select b.a = (select count(*) from clm_allocations) and b.j = (select count(*) from clm_adjustments) and b.r = (select count(*) from clm_receivables)
                  and b.amt = (select sum(amount) from clm_allocations where reversed_at is null) from before b), 'nothing doubled');

-- 8 · a deduction being disputed is left exactly as it is
select clm_import_pmjay('a1000000-0000-0000-0000-000000000001', 'desk2.xlsx', $$[
  {"ip_no":"IPS-TM4","patient_name":"Tms Four","case_no":"2026110110000044","case_status":"Claim Paid","doctor":"DR A","admitted_on":"2026-11-01","discharged_on":"2026-11-02","nabh_amount":60000,"non_nabh_amount":55000,"utr":"AXISCN0044","paid_on":"2026-11-10","paid_amount":40000,"deduction":20000}
]$$::jsonb);
select clm_decide_cut((select id from clm_claims where admission_ref = 'IPS-TM4'), 'fight', 'Second procedure was done in a separate sitting', 'multi_procedure');
truncate res;
insert into res select clm_apply_pmjay_tms('a1000000-0000-0000-0000-000000000001', 'tms3.xlsx', $$[
  {"source":"pmjay","claim_ref":"2026110110000044","patient_name":"Tms Four","claimed_amount":60000,"approved_amount":40000,"tds_amount":0,"net_amount":40000,"utr":"AXISCN0044","payment_date":"2026-11-10","unique15":true}
]$$::jsonb);
select t.check((select r->>'disputed' = '1' from res), 'disputed case counted');
select t.check((select status = 'disputed' and balance = 20000 from clm_v_receivable_balance where claim_id = (select id from clm_claims where admission_ref = 'IPS-TM4')), 'the dispute stands: ₹20,000 still owed');
select t.check((select count(*) = 1 from clm_v_deduction_lines where claim_ref = '2026110110000044' and kind = 'fighting' and category = 'multi_procedure'), 'disputed cut listed with its reason');

-- 9 · two cases on the sheet sharing their first 15 digits: no guessing
truncate res;
insert into res select clm_apply_pmjay_tms('a1000000-0000-0000-0000-000000000001', 'tms4.xlsx', $$[
  {"source":"pmjay","claim_ref":"2026040210047038","patient_name":"Other Pt","bill_date":"2026-04-02","claimed_amount":1000,"approved_amount":1000,"tds_amount":20,"net_amount":980,"utr":"AXISCN0099","payment_date":"2026-05-01","unique15":false}
]$$::jsonb);
select t.check((select r->>'created' = '1' and r->>'fixed' = '0' from res), 'ambiguous ID: its own bill');

-- MIS: every deduction carries speciality, procedure, consultant and centre
select t.check((select count(*) >= 4 and bool_and(centre_name <> '—') from clm_v_deduction_lines), 'deduction lines listed');

-- a viewer cannot upload or set a reason
select t.act_as('00000000-0000-0000-0000-0000000000f1');
select t.expect_error($$ select clm_apply_pmjay_tms('a1000000-0000-0000-0000-000000000001', 'x', '[]'::jsonb) $$, 'read-only');
reset role;
select 'ALL PMJAY TMS TESTS PASSED' as result;
