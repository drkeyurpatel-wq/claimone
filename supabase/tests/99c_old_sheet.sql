-- ════════════════════════════════════════════════════════════════════
-- Old Excel sheet → Master: cases kept apart (case_source 'sheet'),
-- normal status rules, payments booked, cut rules apply.
-- ════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
set client_min_messages = warning;
update clm_tenants set paper_gate = false where id = 'a0000000-0000-0000-0000-000000000001';
set role authenticated;
select t.act_as('00000000-0000-0000-0000-0000000000d1');

create temp table res(ip text, r text);
insert into res
select x->>'ip', clm_import_sheet_case('a1000000-0000-0000-0000-000000000001', x) from jsonb_array_elements($$[
  {"ip":"IPS-OS1","name":"Old Sheet One","payer_code":"medi_assist","discharge":"2026-03-01","bill_no":"IPB/OS1","bill_date":"2026-03-01","claim_no":"MA-OS1","total":90000,"discount":0,"patient_paid":0,"approved":90000,"received":90000,"pay_date":"2026-03-10","utr":"UTROS1","sheet_status":"Settled"},
  {"ip":"IPS-OS2","name":"Old Sheet Two","payer_code":"hdfc_ergo","discharge":"2026-03-02","bill_no":"IPB/OS2","total":50000,"discount":0,"patient_paid":0,"approved":50000,"received":49500,"pay_date":"2026-03-12","utr":"UTROS2","sheet_status":"Settled"},
  {"ip":"IPS-OS3","name":"Old Sheet Three","payer_code":"tata_aig","discharge":"2026-03-03","bill_no":"IPB/OS3","total":80000,"discount":0,"patient_paid":0,"approved":80000,"received":70000,"tds":0,"pay_date":"2026-03-15","utr":"UTROS3","sheet_status":"Settled"},
  {"ip":"IPS-OS4","name":"Old Sheet Four","payer_code":"oriental","discharge":"2026-10-01","bill_no":"IPB/OS4","total":60000,"discount":2000,"patient_paid":0,"approved":55000,"sheet_status":"Unpaid","remarks":"Ratnafin-financed"},
  {"ip":"IPS-OS5","name":"Old Sheet Five","payer_code":"nobody","discharge":"2026-10-01","total":1000,"approved":1000,"sheet_status":"Unpaid"},
  {"ip":"IPS-OS1","name":"Old Sheet One again","payer_code":"medi_assist","discharge":"2026-03-01","total":1,"approved":1,"sheet_status":"Unpaid"}
]$$::jsonb) x;

select t.check((select string_agg(ip || '=' || r, ',' order by ip, r) from res) =
               'IPS-OS1=exists,IPS-OS1=loaded,IPS-OS2=loaded,IPS-OS3=loaded,IPS-OS4=loaded,IPS-OS5=unknown payer nobody', 'results per row');
select t.check((select bool_and(case_source = 'sheet') from clm_claims where admission_ref like 'IPS-OS%'), 'kept apart as old-sheet cases');
-- paid in full → closed, with the bill no. on the book and the submission date from the bill
select t.check((select c.status = 'settled' and c.tpa_claim_number = 'MA-OS1' and c.submitted_at::date = '2026-03-01' and r.bill_no = 'IPB/OS1'
                from clm_claims c join clm_receivables r on r.claim_id = c.id where c.admission_ref = 'IPS-OS1'), 'settled in full');
-- ₹500 short on a settled bill: let go, closes
select t.check((select status = 'settled' from clm_claims where admission_ref = 'IPS-OS2'), 'short under ₹1,000 closes');
-- ₹10,000 short: waits for Accept / Dispute
select t.check((select status = 'claim_approved' from clm_claims where admission_ref = 'IPS-OS3'), 'short ₹10,000 waits for a decision');
select t.check((select balance = 10000 from clm_v_receivable_balance where claim_id = (select id from clm_claims where admission_ref = 'IPS-OS3')), '₹10,000 still due');
-- unpaid, approved below the claim: partial approval, owed
select t.check((select status = 'claim_partial' and claimed_amount = 58000 and approved_amount = 55000 and notes = 'Ratnafin-financed'
                from clm_claims where admission_ref = 'IPS-OS4'), 'approval cut recorded, remarks kept');
-- follow-up clocks run from the bill, not from the load
select t.check((select status_changed_at::date = '2026-10-01' from clm_claims where admission_ref = 'IPS-OS4'), 'clock from the bill date');
select t.check((select status_changed_at::date = '2026-03-10' from clm_claims where admission_ref = 'IPS-OS1'), 'settled on the payment date');
-- history says where it came from
select t.check((select count(*) >= 3 from clm_v_timeline v join clm_claims c on c.id = v.claim_id
                where c.admission_ref = 'IPS-OS1' and v.source = 'sheet'), 'history marks the old sheet');
select t.check((select count(*) = 1 from clm_v_timeline v join clm_claims c on c.id = v.claim_id
                where c.admission_ref = 'IPS-OS1' and v.event_type = 'payment' and v.notes = 'From the old Excel sheet'), 'payment from the old sheet');
-- a bill already on the book (loaded earlier, with its payment) is linked, not copied; the payment is not booked twice
reset role;
insert into clm_receivables (tenant_id, centre_id, debtor_type, payer_id, debtor_name, bill_no, ip_no, patient_name, billed_amount, expected_amount, source, bill_date)
values ('a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'tpa',
        (select id from clm_payers where code = 'medi_assist' and tenant_id is null), 'Medi Assist TPA', 'IPB/OS6', 'IPS-OS6', 'OLD SHEET SIX', 40000, 40000, 'import', '2026-04-01');
insert into clm_receipts (tenant_id, centre_id, source, bank_account, value_date, amount, reference, narration)
values ('a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'bank', 'Kotak 0945', '2026-04-10', 39400, 'UTROS6', 'NEFT UTROS6');
insert into clm_allocations (tenant_id, receipt_id, receivable_id, amount, method)
values ('a0000000-0000-0000-0000-000000000001', (select id from clm_receipts where reference = 'UTROS6'), (select id from clm_receivables where bill_no = 'IPB/OS6'), 39400, 'utr');
set role authenticated;
select t.act_as('00000000-0000-0000-0000-0000000000d1');
select t.check(clm_import_sheet_case('a1000000-0000-0000-0000-000000000001', $${"ip":"IPS-OS6","name":"Old Sheet Six","payer_code":"medi_assist","discharge":"2026-04-01","bill_no":"IPB / OS6","total":40000,"approved":40000,"received":39400,"pay_date":"2026-04-10","utr":"UTROS6","sheet_status":"Settled"}$$::jsonb) = 'loaded', 'linked row loads');
select t.check((select count(*) = 1 from clm_receivables r join clm_claims c on c.id = r.claim_id where c.admission_ref = 'IPS-OS6'), 'one bill: the existing one');
select t.check((select count(*) = 1 from clm_allocations a join clm_receivables r on r.id = a.receivable_id where r.bill_no = 'IPB/OS6' and a.reversed_at is null), 'payment not booked twice');
select t.check((select status = 'settled' and settled_amount = 39400 from clm_claims where admission_ref = 'IPS-OS6'), '₹600 short let go, closed');
-- a second patient on the same bill no. gets a bill of its own
select t.check(clm_import_sheet_case('a1000000-0000-0000-0000-000000000001', $${"ip":"IPS-OS7","name":"Old Sheet Seven","payer_code":"medi_assist","discharge":"2026-04-01","bill_no":"IPB/OS6","total":20000,"approved":20000,"sheet_status":"Unpaid"}$$::jsonb) = 'loaded', 'same bill no., other patient');
select t.check((select r.bill_no = 'IPB/OS6 (IPS-OS7)' from clm_receivables r join clm_claims c on c.id = r.claim_id where c.admission_ref = 'IPS-OS7'), 'its bill no. made unique');

-- a viewer cannot load
select t.act_as('00000000-0000-0000-0000-0000000000f1');
select t.expect_error($$ select clm_import_sheet_case('a1000000-0000-0000-0000-000000000001', '{"ip":"X1"}'::jsonb) $$, 'read-only');
reset role;
select 'ALL OLD SHEET TESTS PASSED' as result;
