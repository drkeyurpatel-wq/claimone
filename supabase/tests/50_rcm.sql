-- ════════════════════════════════════════════════════════════════════
-- RCM: eCW cases, sponsor mapping, workspaces, NHCX log and callback.
-- ════════════════════════════════════════════════════════════════════
\set ON_ERROR_STOP 1
set client_min_messages = warning;
set role authenticated;
select t.act_as('00000000-0000-0000-0000-0000000000d1');

-- ─── 1. Import: credit cases in, cash out, unknown names reported ────
select t.check((select (r->>'created')::int = 3 and (r->>'cash')::int = 1 and (r->>'skipped')::int = 2
                        and r->'unknown_sponsors' = '["CASHLESS"]'::jsonb and (r->>'bills')::int = 1)
  , 'first import: 3 cases, 1 cash, 1 unknown sponsor, 1 bad row, 1 bill')
from (select clm_import_cases('a1000000-0000-0000-0000-000000000001', 'ecw.xlsx', $$[
  {"ip_no":"IPS-T1","patient_name":"Test One","sponsor":"MEDI  ASSIST","admitted_at":"2026-10-20T10:00:00+05:30","estimated_amount":"150000"},
  {"ip_no":"IPS-T2","patient_name":"Test Two","sponsor":"PMJAY","admitted_at":"2026-10-18T10:00:00+05:30",
   "discharged_at":"2026-10-22T18:00:00+05:30","bill_no":"IPB-T2","bill_date":"2026-10-22","bill_amount":"60000","net_amount":"60000","paid_amount":"0"},
  {"ip_no":"IPS-T3","patient_name":"Test Three","sponsor":"CASH"},
  {"ip_no":"IPS-T4","patient_name":"Test Four","sponsor":"Cashless"},
  {"ip_no":"IPS-T5","patient_name":"Test Five","sponsor":"PGVCL"},
  {"ip_no":"","patient_name":"No IP","sponsor":"PMJAY"}
]$$::jsonb) r) x;

select t.check((select claim_type = 'pmjay' and status = 'draft' and claimed_amount = 60000 and case_source = 'ecw'
                from clm_claims where admission_ref = 'IPS-T2'), 'PMJAY case is a draft with its bill as the claim');
select t.check((select c.code = 'pmjay_gujarat' from clm_claims x join clm_payers c on c.id = x.payer_id where admission_ref = 'IPS-T2'),
               'PMJAY goes to the centre''s state scheme');
select t.check((select claim_type = 'corporate' from clm_claims where admission_ref = 'IPS-T5'), 'PGVCL is a corporate case');
select t.check((select expected_amount = 60000 and claim_id is not null and debtor_type = 'government'
                from clm_receivables where bill_no = 'IPB-T2'), 'the PMJAY bill is on the receivables book, tied to its case');

-- ─── 2. Re-import: same IP updates, never duplicates or moves status ─
-- (status set directly here; the submission gate has its own tests)
reset role;
alter table clm_claims disable trigger clm_claims_bu;
update clm_claims set status = 'preauth_pending' where admission_ref = 'IPS-T1';
alter table clm_claims enable trigger clm_claims_bu;
set role authenticated;
select t.check((select (r->>'created')::int = 0 and (r->>'updated')::int = 1)
  , 're-import updates the case')
from (select clm_import_cases('a1000000-0000-0000-0000-000000000001', 'ecw2.xlsx', $$[
  {"ip_no":"ips-t1","patient_name":"Test One","sponsor":"Medi Assist","discharged_at":"2026-10-24T12:00:00+05:30",
   "bill_no":"IPB-T1","bill_amount":"180000","discount_amount":"5000","net_amount":"175000","paid_amount":"10000"}
]$$::jsonb) r) x;
select t.check((select count(*) = 1 from clm_claims where upper(admission_ref) = 'IPS-T1'), 'one case per admission');
select t.check((select status = 'preauth_pending' and claimed_amount = 165000 and discharge_date = '2026-10-24'
                from clm_claims where admission_ref = 'IPS-T1'), 'discharge and bill filled in; status untouched; claim = net − paid by patient');
select t.check((select expected_amount = 165000 from clm_receivables where bill_no = 'IPB-T1'), 'bill added once discharged');
-- the bill is not added twice
select clm_import_cases('a1000000-0000-0000-0000-000000000001', 'ecw3.xlsx', $$[
  {"ip_no":"IPS-T1","patient_name":"Test One","sponsor":"Medi Assist","bill_no":"IPB-T1","net_amount":"175000","paid_amount":"10000"}]$$::jsonb);
select t.check((select count(*) = 1 from clm_receivables where bill_no = 'IPB-T1'), 'bill not duplicated');

-- ─── 3. Teaching a sponsor name ──────────────────────────────────────
select clm_map_sponsor('Cashless', (select id from clm_payers where code = 'medi_assist'), true);
select t.check((select (r->>'created')::int = 1) , 'mapped sponsor now imports')
from (select clm_import_cases('a1000000-0000-0000-0000-000000000001', 'ecw4.xlsx',
  '[{"ip_no":"IPS-T4","patient_name":"Test Four","sponsor":"CASHLESS"}]'::jsonb) r) x;
select t.expect_error($$ select clm_map_sponsor('cashless', null, false) $$, 'ask a manager');
select t.expect_error($$ select clm_map_sponsor('Something', null, true) $$, 'Pick the payer');

-- ─── 4. Access ───────────────────────────────────────────────────────
select t.act_as('00000000-0000-0000-0000-0000000000d2');
select t.check((select count(*) = 0 from clm_claims where case_source = 'ecw'), 'other hospital sees no cases');
select t.expect_error($$ select clm_import_cases('a1000000-0000-0000-0000-000000000001', 'x', '[]') $$, 'No access');
select t.check((select count(*) = 0 from clm_sponsor_map where tenant_id is not null), 'other hospital does not see our sponsor names');
select t.act_as('00000000-0000-0000-0000-0000000000b0');
select t.expect_error($$ select clm_import_cases('a1000000-0000-0000-0000-000000000001', 'x', '[]') $$, 'Read-only');

-- ─── 5. NHCX log ─────────────────────────────────────────────────────
select t.act_as('00000000-0000-0000-0000-0000000000d1');
insert into clm_nhcx_messages (tenant_id, centre_id, claim_id, direction, api_call, action, api_call_id, correlation_id, recipient_code, payload)
select 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', id, 'out', 'preauth', 'request',
       'call-1', 'corr-1', 'payer@hcx', 'eyJ.jwe'
from clm_claims where admission_ref = 'IPS-T1';
update clm_nhcx_messages set status = 'sent', http_status = 202 where api_call_id = 'call-1';
select t.expect_error($$ update clm_nhcx_messages set payload = 'x' where api_call_id = 'call-1' $$, 'cannot be changed');
select t.expect_error($$ insert into clm_nhcx_messages (tenant_id, centre_id, direction, api_call, action, api_call_id, correlation_id)
  values ('a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', 'in', 'preauth', 'on_submit', 'fake', 'corr-1') $$,
  'row-level security');
select t.expect_error($$ select * from clm_nhcx_secrets $$, 'permission denied');
select t.expect_error($$ select clm_set_nhcx_secret('a1000000-0000-0000-0000-000000000001', repeat('s', 40)) $$, 'Only an admin');

reset role;
update clm_centres set nhcx_participant_code = 'shj@hcx' where id = 'a1000000-0000-0000-0000-000000000001';
update clm_user_profiles set role = 'admin' where user_id = '00000000-0000-0000-0000-0000000000a1';
set role authenticated;
select t.act_as('00000000-0000-0000-0000-0000000000a1');
select clm_set_nhcx_secret('a1000000-0000-0000-0000-000000000001', repeat('s', 40));
reset role;
update clm_user_profiles set role = 'manager' where user_id = '00000000-0000-0000-0000-0000000000a1';

-- the callback route has no user: anon with the shared secret
grant usage on schema t to anon;
grant execute on function t.expect_error(text, text) to anon;
set role anon;
select t.expect_error($$ select clm_nhcx_receive(repeat('x', 40), '{"recipient_code":"shj@hcx","api_call":"preauth","action":"on_submit","api_call_id":"in-1","correlation_id":"corr-1"}') $$, 'Not recognised');
select clm_nhcx_receive(repeat('s', 40), '{"recipient_code":"shj@hcx","sender_code":"payer@hcx","api_call":"preauth","action":"on_submit",
  "api_call_id":"in-1","correlation_id":"corr-1","summary":{"outcome":"approved","approved_amount":150000}}');
-- the same callback twice is stored once
select clm_nhcx_receive(repeat('s', 40), '{"recipient_code":"shj@hcx","api_call":"preauth","action":"on_submit","api_call_id":"in-1","correlation_id":"corr-1"}');
select t.expect_error($$ select * from clm_nhcx_messages $$, 'permission denied');
select t.expect_error($$ select clm_import_cases('a1000000-0000-0000-0000-000000000001', 'x', '[]') $$, 'permission denied');
reset role;
select t.check((select count(*) = 1 and bool_and(claim_id is not null) and bool_and(summary->>'outcome' = 'approved')
                from clm_nhcx_messages where direction = 'in'), 'reply stored once and tied to the case');
select t.check((select status = 'accepted' from clm_nhcx_messages where api_call_id = 'call-1'), 'request marked answered');

select 'ALL RCM TESTS PASSED' as result;
