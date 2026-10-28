-- ════════════════════════════════════════════════════════════════════
-- A cut of ₹1,000 or more waits for "Accept the cut" or "Fight it".
-- Fighting keeps it as money due; smaller cuts close on their own.
-- ════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
set client_min_messages = warning;
set role authenticated;
select t.act_as('00000000-0000-0000-0000-0000000000d1');
select clm_import_cases('a1000000-0000-0000-0000-000000000001', 'cut.xlsx',
  '[{"ip_no":"IPS-C1","patient_name":"Cut One Patient","sponsor":"MEDI ASSIST"},
    {"ip_no":"IPS-C2","patient_name":"Cut Two Patient","sponsor":"MEDI ASSIST"},
    {"ip_no":"IPS-C3","patient_name":"Cut Three Patient","sponsor":"MEDI ASSIST"}]'::jsonb);
reset role;
alter table clm_claims disable trigger clm_claims_bu;
update clm_claims set claimed_amount = 42000, approved_amount = 42000, status = 'claim_approved', tpa_claim_number = 'CL-' || admission_ref
where admission_ref in ('IPS-C1','IPS-C2','IPS-C3');
alter table clm_claims enable trigger clm_claims_bu;
set role authenticated;

-- C1: letter pays ₹2,000 less (non billable) → waits
select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'cut1.xlsx',
  '[{"source":"letter","claim_ref":"CL-IPS-C1","patient_name":"Cut One Patient","approved_amount":40000,"tds_amount":800,"deduction_amount":2000,"deduction_reason":"Non billable item","net_amount":39200,"utr":"UTR-C1","payment_date":"2026-10-28"}]'::jsonb);
select t.check((select status = 'claim_approved' and cut_decision is null from clm_claims where admission_ref = 'IPS-C1'), 'C1 waits for a decision');
select t.check((select category = 'non_payable' from clm_adjustments a join clm_receivables r on r.id = a.receivable_id
                join clm_claims c on c.id = r.claim_id where c.admission_ref = 'IPS-C1' and a.kind = 'deduction'), '"non billable" is non-payable');

-- a viewer cannot decide; another hospital cannot see it; a fight needs a reason
select t.act_as('00000000-0000-0000-0000-0000000000f1');
select t.expect_error($$ select clm_decide_cut((select id from clm_claims where admission_ref = 'IPS-C1'), 'accept') $$, 'not allowed');
select t.act_as('00000000-0000-0000-0000-0000000000d2');
select t.expect_error($$ select clm_decide_cut('00000000-0000-0000-0000-00000000c0de', 'accept') $$, 'unknown claim');
select t.act_as('00000000-0000-0000-0000-0000000000d1');
select t.expect_error($$ select clm_decide_cut((select id from clm_claims where admission_ref = 'IPS-C1'), 'fight', '  ') $$, 'why the cut is wrong');

-- fight: deduction reversed, bill owes the full claim, disputed, file open
select clm_decide_cut((select id from clm_claims where admission_ref = 'IPS-C1'), 'fight', 'Items are payable as per tariff');
select t.check((select balance = 2000 and recon_status = 'disputed' and deduction = 0
                from clm_v_receivable_balance where claim_id = (select id from clm_claims where admission_ref = 'IPS-C1')),
               'fighting: ₹2,000 still due, disputed');
select t.check((select status = 'claim_approved' and cut_decision = 'fought' from clm_claims where admission_ref = 'IPS-C1'), 'file stays open');
select t.check((select coalesce(sum(amount), 0) = 2000 from clm_v_leakage where kind = 'fighting' and centre_id = 'a1000000-0000-0000-0000-000000000001'),
               'leakage shows ₹2,000 being fought');

-- the insurer pays the ₹2,000 → dispute clears, file closes with no deduction
select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'cut1b.xlsx',
  '[{"source":"letter","claim_ref":"CL-IPS-C1","patient_name":"Cut One Patient","approved_amount":2000,"net_amount":2000,"utr":"UTR-C1B","payment_date":"2026-10-29"}]'::jsonb);
select t.check((select status = 'settled' and deduction_amount = 0 and settled_amount = 41200 from clm_claims where admission_ref = 'IPS-C1'),
               'won: settled in full');
select t.check((select coalesce(sum(amount), 0) = 0 from clm_v_leakage where kind = 'fighting' and centre_id = 'a1000000-0000-0000-0000-000000000001'),
               'nothing left being fought');

-- C2: fight, then give up and accept → closes with the deduction
select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'cut2.xlsx',
  '[{"source":"letter","claim_ref":"CL-IPS-C2","patient_name":"Cut Two Patient","approved_amount":40000,"tds_amount":800,"deduction_amount":2000,"deduction_reason":"Room rent capping","net_amount":39200,"utr":"UTR-C2","payment_date":"2026-10-28"}]'::jsonb);
select clm_decide_cut((select id from clm_claims where admission_ref = 'IPS-C2'), 'fight', 'Room was as per eligibility');
-- the insurer's next letter repeats the cut: not booked while we fight
select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'cut2b.xlsx',
  '[{"source":"letter","claim_ref":"CL-IPS-C2","patient_name":"Cut Two Patient","approved_amount":0,"deduction_amount":2000,"deduction_reason":"Room rent capping","net_amount":0,"payment_date":"2026-10-29"}]'::jsonb);
select t.check((select balance = 2000 and recon_status = 'disputed' from clm_v_receivable_balance
                where claim_id = (select id from clm_claims where admission_ref = 'IPS-C2')), 'repeated cut not booked while fighting');
select clm_decide_cut((select id from clm_claims where admission_ref = 'IPS-C2'), 'accept', 'Insurer refused the appeal', 'room_rent_cap');
select t.check((select status = 'settled' and deduction_amount = 2000 and settled_amount = 39200 from clm_claims where admission_ref = 'IPS-C2'),
               'gave up: settled with the ₹2,000 deduction');
select t.check((select coalesce(sum(amount), 0) >= 2000 from clm_v_leakage where kind = 'deduction' and category = 'room_rent_cap'),
               'accepted cut counts as leakage');

-- C3: ₹500 cut closes on its own
select clm_apply_payments('a1000000-0000-0000-0000-000000000001', 'cut3.xlsx',
  '[{"source":"letter","claim_ref":"CL-IPS-C3","patient_name":"Cut Three Patient","approved_amount":41500,"tds_amount":830,"deduction_amount":500,"deduction_reason":"Consumables","net_amount":40670,"utr":"UTR-C3","payment_date":"2026-10-28"}]'::jsonb);
select t.check((select status = 'settled' and deduction_amount = 500 from clm_claims where admission_ref = 'IPS-C3'), 'small cut closes by itself');

reset role;
select 'ALL CUT DECISION TESTS PASSED' as result;
