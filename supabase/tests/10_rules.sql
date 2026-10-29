-- ════════════════════════════════════════════════════════════════════
-- ClaimOne — database rule tests
-- Run against a fresh database after 00_supabase_stub.sql, the
-- migrations and seed.sql:
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/10_rules.sql
-- Every check raises on failure, so a clean run means every rule held.
-- ════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP 1
set client_min_messages = warning;

create schema t;
grant usage on schema t to authenticated;

-- Run a statement and require it to fail with a matching message.
create function t.expect_error(p_sql text, p_pattern text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm !~* p_pattern then
      raise exception 'Expected error matching "%", got "%"', p_pattern, sqlerrm;
    end if;
    return;
  end;
  raise exception 'Expected error matching "%", but statement succeeded: %', p_pattern, p_sql;
end $$;

create function t.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'CHECK FAILED: %', p_what; end if;
end $$;

grant execute on all functions in schema t to authenticated;

create function t.act_as(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p_user::text, false)
$$;
grant execute on function t.act_as(uuid) to authenticated;

-- ─── Fixtures (as superuser) ────────────────────────────────────────
insert into clm_tenants (id, code, name) values
  ('a0000000-0000-0000-0000-000000000001', 'health1', 'Health1'),
  ('b0000000-0000-0000-0000-000000000001', 'other',   'Other Hospital');
insert into clm_centres (id, tenant_id, code, name) values
  ('a1000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'shj', 'Shilaj'),
  ('a1000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'mod', 'Modasa'),
  ('b1000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'oth', 'Other');
-- these rule tests run with the paper gate on (0020: it is off by default)
update clm_tenants set paper_gate = true;
insert into auth.users (id) values
  ('00000000-0000-0000-0000-0000000000d1'), ('00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000f1'), ('00000000-0000-0000-0000-0000000000b0'),
  ('00000000-0000-0000-0000-0000000000d2');
insert into clm_user_profiles (user_id, tenant_id, full_name, role, centre_ids) values
  ('00000000-0000-0000-0000-0000000000d1', 'a0000000-0000-0000-0000-000000000001', 'Desk Shilaj', 'desk', array['a1000000-0000-0000-0000-000000000001'::uuid]),
  ('00000000-0000-0000-0000-0000000000a1', 'a0000000-0000-0000-0000-000000000001', 'Manager',     'manager', null),
  ('00000000-0000-0000-0000-0000000000f1', 'a0000000-0000-0000-0000-000000000001', 'Viewer',      'viewer', null),
  ('00000000-0000-0000-0000-0000000000b0', 'a0000000-0000-0000-0000-000000000001', 'Bot Shilaj',  'bot', array['a1000000-0000-0000-0000-000000000001'::uuid]),
  ('00000000-0000-0000-0000-0000000000d2', 'b0000000-0000-0000-0000-000000000001', 'Desk Other',  'desk', null);

-- An unused payer (scorecard must show 0, not 1)
insert into clm_payers (tenant_id, code, name, type)
values ('a0000000-0000-0000-0000-000000000001', 'unused_payer', 'Unused Payer', 'tpa');

set role authenticated;

-- ─── 1. Creating a claim ────────────────────────────────────────────
select t.act_as('00000000-0000-0000-0000-0000000000d1');

insert into clm_claims (id, tenant_id, centre_id, payer_id, claim_type, status, patient_name, estimated_amount, claim_number)
select 'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
       'a1000000-0000-0000-0000-000000000001', id, 'cashless', 'settled', 'Arjun Shah', 120000, 'IGNORED'
from clm_payers where code = 'hdfc_ergo';

select t.check((select status from clm_claims where id = 'c0000000-0000-0000-0000-000000000001') = 'draft',
               'new claims always start as draft, whatever the client sends');
select t.check((select claim_number from clm_claims where id = 'c0000000-0000-0000-0000-000000000001') ~ '^CLM-SHJ-\d{4}-0001$',
               'claim number is generated per centre');
select t.check((select count(*) from clm_state_transitions where claim_id = 'c0000000-0000-0000-0000-000000000001') = 1,
               'creation is logged once');

-- desk user scoped to Shilaj cannot create at Modasa
select t.expect_error($$
  insert into clm_claims (tenant_id, centre_id, payer_id, claim_type, patient_name, claim_number)
  select 'a0000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000002', id, 'cashless', 'X', 'x'
  from clm_payers where code = 'hdfc_ergo' $$, 'row-level security');

-- ─── 2. Tenant isolation ────────────────────────────────────────────
select t.act_as('00000000-0000-0000-0000-0000000000d2');
select t.check((select count(*) from clm_claims) = 0, 'other hospital sees none of Health1''s claims');
select t.check((select count(*) from clm_unmet_mandatory_docs('c0000000-0000-0000-0000-000000000001', 'preauth')) = 0,
               'gate function leaks nothing across tenants');
select t.check((select count(*) from clm_centres) = 1, 'other hospital sees only its own centre');

-- ─── 3. Submission gate ─────────────────────────────────────────────
select t.act_as('00000000-0000-0000-0000-0000000000d1');
select t.expect_error($$ update clm_claims set status = 'preauth_pending' where id = 'c0000000-0000-0000-0000-000000000001' $$,
                      'Submission blocked.*Pre-authorisation form.*missing');

insert into clm_documents (claim_id, tenant_id, doc_code, document_name, file_path) values
  ('c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', 'preauth_form',   'Preauth form', 'p/1.pdf'),
  ('c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'id_proof',       'Aadhaar',      'p/2.pdf'),
  ('c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'policy_card',    'TPA card',     'p/3.pdf'),
  ('c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'clinical_notes', 'Notes',        'p/4.pdf');

select t.check((select bool_and(tenant_id = 'a0000000-0000-0000-0000-000000000001') from clm_documents),
               'child rows take the parent claim''s tenant, whatever the client sends');
select t.expect_error($$ update clm_claims set status = 'preauth_pending' where id = 'c0000000-0000-0000-0000-000000000001' $$,
                      'Submission blocked.*\(uploaded\)');

select t.expect_error($$ update clm_documents set status = 'invalid' where doc_code = 'id_proof' $$, 'Say why');
update clm_documents set status = 'valid' where claim_id = 'c0000000-0000-0000-0000-000000000001';
select t.check((select count(*) from clm_events where event_type = 'doc_verified') = 4, 'each verification is audited');

update clm_claims set status = 'preauth_pending' where id = 'c0000000-0000-0000-0000-000000000001';
select t.check((select count(*) from clm_state_transitions where claim_id = 'c0000000-0000-0000-0000-000000000001'
                and to_status = 'preauth_pending') = 1, 'each status change is logged exactly once');
select t.check((select preauth_submitted_at is not null from clm_claims where id = 'c0000000-0000-0000-0000-000000000001'),
               'pre-auth submission time is stamped');

-- ─── 4. State machine ───────────────────────────────────────────────
select t.expect_error($$ update clm_claims set status = 'settled' where id = 'c0000000-0000-0000-0000-000000000001' $$,
                      'preauth_pending → settled is not allowed');
select t.expect_error($$ update clm_claims set status = 'preauth_approved' where id = 'c0000000-0000-0000-0000-000000000001' $$,
                      'Approved amount is required');
select clm_transition('c0000000-0000-0000-0000-000000000001', 'preauth_approved', '{"approved_amount": 110000}', 'Approved on portal');
select t.check((select notes from clm_state_transitions where to_status = 'preauth_approved') = 'Approved on portal',
               'transition note is stored in the audit row');

-- Final claim: needs final docs; implant invoice only at ₹50,000+
update clm_claims set claimed_amount = 49999 where id = 'c0000000-0000-0000-0000-000000000001';
insert into clm_documents (claim_id, doc_code, document_name, file_path, status)
select 'c0000000-0000-0000-0000-000000000001', d, d, 'f/' || d || '.pdf', 'uploaded'
from unnest(array['discharge_summary','final_bill','icp','investigations','preauth_approval']) d;
update clm_documents set status = 'valid' where status = 'uploaded';
select t.check((select count(*) from clm_unmet_mandatory_docs('c0000000-0000-0000-0000-000000000001', 'final')) = 0,
               'implant invoice is not required below ₹50,000');
update clm_claims set claimed_amount = 50000 where id = 'c0000000-0000-0000-0000-000000000001';
select t.expect_error($$ select clm_transition('c0000000-0000-0000-0000-000000000001', 'claim_submitted') $$,
                      'Implant invoice');

-- A hospital+payer rule overrides the platform default
reset role;
insert into clm_doc_rules (tenant_id, payer_id, stage, doc_code, doc_label, is_mandatory, min_amount)
select 'a0000000-0000-0000-0000-000000000001', id, 'final', 'implant_invoice', 'Implant invoice + sticker', false, 50000
from clm_payers where code = 'hdfc_ergo';
set role authenticated;
select t.act_as('00000000-0000-0000-0000-0000000000d1');
select clm_transition('c0000000-0000-0000-0000-000000000001', 'claim_submitted');
select t.check((select submitted_at is not null from clm_claims where id = 'c0000000-0000-0000-0000-000000000001'),
               'hospital rule for this payer overrode the default; submission stamped');

-- ─── 5. Roles ───────────────────────────────────────────────────────
select t.act_as('00000000-0000-0000-0000-0000000000f1');
update clm_claims set notes = 'viewer edit' where id = 'c0000000-0000-0000-0000-000000000001';
select t.check((select notes is null from clm_claims where id = 'c0000000-0000-0000-0000-000000000001'),
               'viewer cannot edit (update silently matches no rows under RLS)');
select t.expect_error($$ select clm_transition('c0000000-0000-0000-0000-000000000001', 'claim_under_review') $$, 'Read-only');

select t.act_as('00000000-0000-0000-0000-0000000000d1');
select t.expect_error($$ update clm_claims set medpay_synced = true where id = 'c0000000-0000-0000-0000-000000000001' $$,
                      'only be set by the MedPay sync');

-- ─── 6. Bot ─────────────────────────────────────────────────────────
select t.act_as('00000000-0000-0000-0000-0000000000b0');
update clm_claims set notes = 'bot direct' where id = 'c0000000-0000-0000-0000-000000000001';
select t.check((select notes is null from clm_claims where id = 'c0000000-0000-0000-0000-000000000001'),
               'bot cannot write to claims directly');
select t.expect_error($$ select clm_bot_apply('c0000000-0000-0000-0000-000000000001', null, '{"claimed_amount": 1}') $$,
                      'Bot may only set');
select clm_bot_apply('c0000000-0000-0000-0000-000000000001', 'claim_under_review', '{"tpa_claim_number": "HDFC-998"}', 'Status from portal');
select t.check((select trigger_source from clm_state_transitions where to_status = 'claim_under_review') = 'bot',
               'bot changes are attributed to the bot');
select t.act_as('00000000-0000-0000-0000-0000000000d1');
select t.expect_error($$ select clm_bot_apply('c0000000-0000-0000-0000-000000000001', null, '{}') $$, 'Only the bot');

-- ─── 7. Queries ─────────────────────────────────────────────────────
insert into clm_queries (claim_id, query_text) values ('c0000000-0000-0000-0000-000000000001', 'Share MRI report');
select t.check((select query_number = 1 and sla_deadline > now() + interval '47 hours' from clm_queries), 'query numbered, 48h SLA from payer');
select t.check((select query_count = 1 and is_query_pending from clm_claims where id = 'c0000000-0000-0000-0000-000000000001'),
               'claim shows an open query');
select t.expect_error($$ update clm_queries set status = 'responded' $$, 'needs text');
update clm_queries set status = 'responded', response_text = 'MRI attached';
select t.check((select not is_query_pending from clm_claims where id = 'c0000000-0000-0000-0000-000000000001'),
               'responding clears the pending flag');

-- ─── 8. Settlement ──────────────────────────────────────────────────
select clm_transition('c0000000-0000-0000-0000-000000000001', 'claim_partial', '{"approved_amount": 42000}');
select t.expect_error($$ select clm_record_settlement('c0000000-0000-0000-0000-000000000001', 60000, 0, 60000, 'UTR1', current_date) $$,
                      'exceeds claimed');
select t.expect_error($$ select clm_record_settlement('c0000000-0000-0000-0000-000000000001', 42000, 4200, 42000, 'UTR1', current_date) $$,
                      'Net');
select t.expect_error($$ select clm_record_settlement('c0000000-0000-0000-0000-000000000001', 42000, 4200, 37800, 'UTR1', current_date,
                          'neft', '[{"category":"room_rent_cap","amount":5000}]') $$, 'do not add up');
select clm_record_settlement('c0000000-0000-0000-0000-000000000001', 42000, 4200, 37800, 'UTR1', current_date, 'neft',
  '[{"category":"room_rent_cap","amount":5000,"reason_text":"Room above eligibility"},{"category":"non_payable","amount":3000}]');
select t.check((select status = 'settled' and deduction_amount = 8000 and settled_amount = 37800 and tds_amount = 4200
                from clm_claims where id = 'c0000000-0000-0000-0000-000000000001'),
               'settlement sets deduction = claimed − approved and net = approved − TDS');
select t.check((select medpay_synced = false from clm_claims where id = 'c0000000-0000-0000-0000-000000000001'),
               'settlement does not pretend MedPay was synced');
select t.check((select sum(amount) = 8000 and bool_and(is_preventable) from clm_disallowances), 'leakage itemised and classed preventable');

update clm_claims set status = 'closed' where id = 'c0000000-0000-0000-0000-000000000001';
select t.expect_error($$ update clm_claims set notes = 'x', status = 'claim_submitted' where id = 'c0000000-0000-0000-0000-000000000001' $$,
                      'no further changes');

-- ─── 9. Write-off needs a manager ───────────────────────────────────
insert into clm_claims (id, tenant_id, centre_id, payer_id, claim_type, patient_name, claimed_amount, claim_number)
select 'c0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001',
       'a1000000-0000-0000-0000-000000000001', id, 'reimbursement', 'Ramesh Thakor', 64800, 'x'
from clm_payers where code = 'new_india';
select t.expect_error($$ update clm_claims set status = 'claim_submitted' where id = 'c0000000-0000-0000-0000-000000000002' $$,
                      'Payment receipts');
insert into clm_documents (claim_id, doc_code, document_name, file_path, status)
select 'c0000000-0000-0000-0000-000000000002', d, d, 'r/' || d || '.pdf', 'valid'
from unnest(array['claim_form','discharge_summary','final_bill','payment_receipt','bank_details','investigations']) d;
select t.check((select bool_and(status = 'uploaded') from clm_documents where claim_id = 'c0000000-0000-0000-0000-000000000002'),
               'a new upload cannot arrive pre-verified');
update clm_documents set status = 'valid' where claim_id = 'c0000000-0000-0000-0000-000000000002';
select clm_transition('c0000000-0000-0000-0000-000000000002', 'claim_submitted');
select clm_transition('c0000000-0000-0000-0000-000000000002', 'claim_rejected');
select t.expect_error($$ select clm_transition('c0000000-0000-0000-0000-000000000002', 'written_off') $$, 'Only a manager');
select t.act_as('00000000-0000-0000-0000-0000000000a1');
select clm_transition('c0000000-0000-0000-0000-000000000002', 'written_off', '{}', 'Policy exclusion upheld on appeal');

-- ─── 10. PMJAY scheme rules ─────────────────────────────────────────
insert into clm_claims (id, tenant_id, centre_id, payer_id, claim_type, patient_name, estimated_amount, claim_number)
select 'c0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001',
       'a1000000-0000-0000-0000-000000000002', id, 'pmjay', 'Kiran Chauhan', 41000, 'x'
from clm_payers where code = 'pmjay_gujarat';
select t.check((select count(*) from clm_unmet_mandatory_docs('c0000000-0000-0000-0000-000000000003', 'preauth')
                where doc_code in ('pmjay_card','admission_photo')) = 2, 'PMJAY adds scheme documents');
select t.check((select claim_number from clm_claims where id = 'c0000000-0000-0000-0000-000000000003') ~ '^CLM-MOD-',
               'numbering is per centre');

-- ─── 11. Views ──────────────────────────────────────────────────────
select t.check((select total_claims from clm_v_payer_scorecard where payer_name = 'Unused Payer') = 0,
               'scorecard counts 0 claims for an unused payer (H1 bug fixed)');
select t.check((select count(*) from clm_v_timeline where claim_id = 'c0000000-0000-0000-0000-000000000001') >= 15,
               'timeline unifies transitions, documents, queries and settlement');
select t.check((select sum(amount) from clm_v_leakage) = 8000, 'leakage view adds up');
select t.check((select unmet_count >= 2 and next_stage = 'preauth' from clm_v_readiness
                where claim_id = 'c0000000-0000-0000-0000-000000000003'), 'readiness view shows what blocks the next submission');
select t.act_as('00000000-0000-0000-0000-0000000000d2');
select t.check((select count(*) from clm_v_timeline) = 0 and (select count(*) from clm_v_leakage) = 0
               and (select coalesce(sum(total_claims), 0) from clm_v_payer_scorecard) = 0
               and (select count(*) from clm_v_readiness) = 0,
               'views respect tenant isolation');

-- ─── 12. Storage paths ──────────────────────────────────────────────
select t.act_as('00000000-0000-0000-0000-0000000000d1');
insert into storage.objects (bucket_id, name)
values ('claim-documents', 'a0000000-0000-0000-0000-000000000001/c0000000-0000-0000-0000-000000000001/1_x.pdf');
select t.expect_error($$ insert into storage.objects (bucket_id, name)
  values ('claim-documents', 'b0000000-0000-0000-0000-000000000001/c0000000-0000-0000-0000-000000000001/1_x.pdf') $$,
  'row-level security');
select t.act_as('00000000-0000-0000-0000-0000000000d2');
select t.check((select count(*) from storage.objects) = 0, 'other tenant cannot list Health1 files');

reset role;
select t.check((select public = false from storage.buckets where id = 'claim-documents'), 'bucket is private');
select 'ALL DATABASE RULE TESTS PASSED' as result;
