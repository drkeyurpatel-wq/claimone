-- ════════════════════════════════════════════════════════════════════
-- Desk tools.
-- 1. A typed payment needs its UTR / reference no., so the same payment
--    on a later upload is recognised and not counted twice.
-- 2. Payer queries are kept as records: raised (text, time), replied
--    (text, time). The reply time drives the follow-up; the original
--    submission date stays on the file.
-- 3. Dispute letters: which letter went (reconsideration, escalation,
--    patient's grievance) and when, so the follow-up runs from it.
-- 4. Audit trail: every edit to a case, every payment and reversal, with
--    the person who did it, in the case history.
-- 5. Money in the bank: how much of a case's payment is matched to a
--    bank credit.
-- ════════════════════════════════════════════════════════════════════

-- ─── 1. UTR compulsory on a typed payment ────────────────────────────
create or replace function clm_record_case_payment(p_claim uuid, p_net numeric, p_tds numeric default 0,
                                                   p_utr text default null, p_date date default null)
returns text
language plpgsql security invoker set search_path = public as $$
declare
  c clm_claims%rowtype; r clm_receivables%rowtype;
  t uuid := clm_current_tenant(); batch uuid; rem uuid; rc uuid; bank uuid; v_utr text; v_date date;
begin
  if t is null or not clm_can_write() then raise exception 'Read-only access' using errcode = 'insufficient_privilege'; end if;
  select * into c from clm_claims where id = p_claim;
  if not found or c.tenant_id <> t or not clm_can_access_centre(c.centre_id) then
    raise exception 'Unknown patient' using errcode = 'foreign_key_violation';
  end if;
  if c.status not in ('claim_approved','claim_partial','settlement_pending') then
    raise exception 'Enter the approved amount before the payment' using errcode = 'check_violation';
  end if;
  if coalesce(p_net, 0) <= 0 then raise exception 'Enter the amount received' using errcode = 'check_violation'; end if;
  if coalesce(p_tds, 0) < 0 then raise exception 'TDS cannot be negative' using errcode = 'check_violation'; end if;
  v_utr := nullif(btrim(coalesce(p_utr, '')), '');
  if v_utr is null or length(v_utr) < 4 then
    raise exception 'Enter the UTR / reference no. of the payment' using errcode = 'check_violation';
  end if;

  select * into r from clm_receivables where claim_id = c.id and debtor_type <> 'patient';
  if r.id is null then raise exception 'No bill for this patient yet' using errcode = 'check_violation'; end if;
  v_date := coalesce(p_date, (now() at time zone 'Asia/Kolkata')::date);

  insert into clm_import_batches (tenant_id, centre_id, kind, file_name, row_count)
  values (t, c.centre_id, 'weekly_payments', 'Typed in ClaimOne', 1) returning id into batch;

  insert into clm_remittance_lines (tenant_id, centre_id, payer_id, payer_name, utr, advice_date, claim_ref, bill_no, patient_name,
                                    approved_amount, claimed_amount, tds_amount, deduction_amount, net_amount,
                                    payment_date, source, file_name, receivable_id, import_batch_id)
  values (t, c.centre_id, r.payer_id, r.debtor_name, v_utr, v_date, r.claim_ref, r.bill_no, c.patient_name,
          c.approved_amount, c.claimed_amount, coalesce(p_tds, 0), 0, p_net,
          v_date, 'letter', 'Typed in ClaimOne', r.id, batch)
  on conflict do nothing returning id into rem;
  if rem is null then
    -- the same figures were entered before and that entry was reversed: this is the corrected entry
    if exists (select 1 from clm_remittance_lines l
               where l.receivable_id = r.id and upper(coalesce(l.utr, '')) = upper(v_utr) and l.net_amount = p_net
                 and not exists (select 1 from clm_allocations a where a.remittance_line_id = l.id and a.reversed_at is null)) then
      insert into clm_remittance_lines (tenant_id, centre_id, payer_id, payer_name, utr, advice_date, claim_ref, bill_no, patient_name,
                                        approved_amount, claimed_amount, tds_amount, deduction_amount, net_amount,
                                        payment_date, source, file_name, receivable_id, import_batch_id)
      values (t, c.centre_id, r.payer_id, r.debtor_name, v_utr || ' · re-entry ' || to_char(now(), 'YYYYMMDDHH24MISS'), v_date, r.claim_ref, r.bill_no,
              c.patient_name, c.approved_amount, c.claimed_amount, coalesce(p_tds, 0), 0, p_net,
              v_date, 'letter', 'Typed in ClaimOne', r.id, batch)
      returning id into rem;
    else
      raise exception 'This payment is already entered' using errcode = 'unique_violation';
    end if;
  end if;

  rc := clm_bank_receipt_for(t, c.centre_id, v_utr, p_net);
  if rc is null then bank := clm_bank_credit_any(t, c.centre_id, v_utr); end if;
  if rc is null then
    insert into clm_receipts (tenant_id, centre_id, source, bank_account, value_date, amount, reference, narration, payer_id,
                              import_batch_id, bank_receipt_id, bank_confirmed_on)
    values (t, c.centre_id, 'advice', 'advice:' || rem, v_date, p_net, v_utr, 'Typed in ClaimOne', r.payer_id,
            batch, bank, (select value_date from clm_receipts where id = bank))
    returning id into rc;
  end if;

  insert into clm_allocations (tenant_id, receipt_id, receivable_id, amount, method, remittance_line_id)
  values (t, rc, r.id, p_net, 'advice', rem);
  if coalesce(p_tds, 0) > 0 then
    insert into clm_adjustments (tenant_id, receivable_id, kind, amount, reason_text, remittance_line_id)
    values (t, r.id, 'tds', p_tds, 'TDS as per settlement', rem);
  end if;
  return 'saved';
end $$;

-- ─── 2. Payer queries ────────────────────────────────────────────────
alter table clm_claims add column if not exists query_replied_at timestamptz;
alter table clm_claims add column if not exists dispute_level smallint;
alter table clm_claims add column if not exists dispute_sent_at timestamptz;
comment on column clm_claims.query_replied_at is 'When the last payer query was answered; the follow-up runs from here';
comment on column clm_claims.dispute_level is '1 reconsideration letter, 2 escalation to the insurer, 3 patient grievance';

-- answering a query: stamp the reply and keep the original submission date
create or replace function clm_claims_query_reply() returns trigger
language plpgsql set search_path = public as $$
begin
  if old.status = 'claim_query' and new.status = 'claim_submitted' then
    new.query_replied_at := now();
    new.submitted_at := coalesce(old.submitted_at, new.submitted_at);
  elsif old.status = 'preauth_query' and new.status = 'preauth_pending' then
    new.query_replied_at := now();
    new.preauth_submitted_at := coalesce(old.preauth_submitted_at, new.preauth_submitted_at);
  end if;
  return new;
end $$;
drop trigger if exists clm_claims_query_reply on clm_claims;
create trigger clm_claims_query_reply before update of status on clm_claims
for each row execute function clm_claims_query_reply();

-- the query itself is kept: raised with its text, closed with the reply
create or replace function clm_claims_track_queries() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_note text := nullif(btrim(coalesce(current_setting('claimone.note', true), '')), '');
        v_src text := coalesce(nullif(current_setting('claimone.source', true), ''), 'user');
begin
  if new.status in ('preauth_query','claim_query') then
    insert into clm_queries (tenant_id, claim_id, query_number, query_text, source, raised_at, sla_deadline)
    values (new.tenant_id, new.id, 0, coalesce(v_note, 'Query raised'),
            case v_src when 'bot' then 'bot' when 'nhcx' then 'nhcx' else 'manual' end, now(),
            now() + case when new.status = 'preauth_query' then interval '4 hours' else interval '48 hours' end);
  elsif old.status in ('preauth_query','claim_query') then
    update clm_queries set status = 'responded', response_text = coalesce(v_note, 'Replied')
    where claim_id = new.id and status in ('open','in_progress','escalated');
  end if;
  return null;
end $$;
drop trigger if exists clm_claims_queries on clm_claims;
create trigger clm_claims_queries after update of status on clm_claims
for each row when (new.status is distinct from old.status) execute function clm_claims_track_queries();

-- ─── 3. Dispute letters ──────────────────────────────────────────────
create or replace function clm_record_dispute_letter(p_claim uuid, p_level int) returns void
language plpgsql security invoker set search_path = public as $$
declare c clm_claims%rowtype;
begin
  if not clm_can_write() then raise exception 'Read-only access' using errcode = 'insufficient_privilege'; end if;
  select * into c from clm_claims where id = p_claim for update;
  if not found then raise exception 'Unknown patient' using errcode = 'foreign_key_violation'; end if;
  if c.cut_decision is distinct from 'fought' then
    raise exception 'Mark the deduction as disputed first' using errcode = 'check_violation';
  end if;
  if p_level not in (1, 2, 3) then raise exception 'Unknown letter' using errcode = 'check_violation'; end if;
  update clm_claims set dispute_level = greatest(coalesce(dispute_level, 0), p_level), dispute_sent_at = now() where id = c.id;
  insert into clm_events (tenant_id, claim_id, event_type, payload, actor_id)
  values (c.tenant_id, c.id, 'dispute_letter', jsonb_build_object('text',
    case p_level when 1 then 'Reconsideration letter sent to the payer'
                 when 2 then 'Escalation letter sent to the insurer'
                 else 'Grievance letter given to the patient' end), auth.uid());
end $$;
revoke execute on function clm_record_dispute_letter(uuid, int) from public, anon;
grant execute on function clm_record_dispute_letter(uuid, int) to authenticated;

-- ─── 4. Audit trail ──────────────────────────────────────────────────
-- Edits to a case. Patient identifiers are named, not copied (PHI stays in the case row).
create or replace function clm_claims_audit_edits() returns trigger
language plpgsql security definer set search_path = public as $$
declare msgs text[] := '{}'; m text;
  rs constant text := 'FM99,99,99,990';
  d text := 'DD Mon YYYY';
begin
  if new.patient_name is distinct from old.patient_name then msgs := msgs || 'Patient name corrected'::text; end if;
  if new.admission_ref is distinct from old.admission_ref then msgs := msgs || 'IP number corrected'::text; end if;
  if new.patient_uhid is distinct from old.patient_uhid then msgs := msgs || 'UHID updated'::text; end if;
  if new.patient_phone is distinct from old.patient_phone then msgs := msgs || 'Mobile number updated'::text; end if;
  if new.payer_id is distinct from old.payer_id then
    msgs := msgs || ('Payer changed: ' || coalesce((select name from clm_payers where id = old.payer_id), '—')
                     || ' → ' || coalesce((select name from clm_payers where id = new.payer_id), '—'));
  end if;
  if new.admission_date is distinct from old.admission_date then
    msgs := msgs || ('Admission date ' || coalesce(to_char(old.admission_date, d), '—') || ' → ' || coalesce(to_char(new.admission_date, d), '—'));
  end if;
  if new.discharge_date is distinct from old.discharge_date then
    msgs := msgs || ('Discharge date ' || coalesce(to_char(old.discharge_date, d), '—') || ' → ' || coalesce(to_char(new.discharge_date, d), '—'));
  end if;
  if new.estimated_amount is distinct from old.estimated_amount then
    msgs := msgs || ('Estimate ₹' || coalesce(to_char(old.estimated_amount, rs), '—') || ' → ₹' || coalesce(to_char(new.estimated_amount, rs), '—'));
  end if;
  if new.claimed_amount is distinct from old.claimed_amount then
    msgs := msgs || ('Claimed ₹' || coalesce(to_char(old.claimed_amount, rs), '—') || ' → ₹' || coalesce(to_char(new.claimed_amount, rs), '—'));
  end if;
  if new.approved_amount is distinct from old.approved_amount then
    msgs := msgs || ('Approved ₹' || coalesce(to_char(old.approved_amount, rs), '—') || ' → ₹' || coalesce(to_char(new.approved_amount, rs), '—'));
  end if;
  if new.tpa_claim_number is distinct from old.tpa_claim_number then
    msgs := msgs || ('Claim no. ' || coalesce(old.tpa_claim_number, '—') || ' → ' || coalesce(new.tpa_claim_number, '—'));
  end if;
  if new.tpa_preauth_number is distinct from old.tpa_preauth_number then
    msgs := msgs || ('Pre-auth no. ' || coalesce(old.tpa_preauth_number, '—') || ' → ' || coalesce(new.tpa_preauth_number, '—'));
  end if;
  -- dates typed for a submission (the status change itself is logged separately)
  if new.status is not distinct from old.status then
    if new.submitted_at is distinct from old.submitted_at then
      msgs := msgs || ('Claim submission date set to ' || coalesce(to_char(new.submitted_at at time zone 'Asia/Kolkata', d), '—'));
    end if;
    if new.preauth_submitted_at is distinct from old.preauth_submitted_at then
      msgs := msgs || ('Pre-auth submission date set to ' || coalesce(to_char(new.preauth_submitted_at at time zone 'Asia/Kolkata', d), '—'));
    end if;
    if new.query_replied_at is distinct from old.query_replied_at and old.query_replied_at is not null then
      msgs := msgs || ('Query reply date set to ' || coalesce(to_char(new.query_replied_at at time zone 'Asia/Kolkata', d), '—'));
    end if;
  end if;
  if new.cut_decision is distinct from old.cut_decision and new.cut_decision is not null then
    msgs := msgs || (case new.cut_decision when 'fought' then 'Deduction disputed' else 'Deduction accepted' end
                     || coalesce(' — ' || nullif(btrim(new.cut_note), ''), ''));
  end if;
  foreach m in array msgs loop
    insert into clm_events (tenant_id, claim_id, event_type, payload, actor_id)
    values (new.tenant_id, new.id, 'field_changed',
            jsonb_build_object('text', m, 'source', coalesce(nullif(current_setting('claimone.source', true), ''), 'user')), auth.uid());
  end loop;
  return null;
end $$;
drop trigger if exists clm_claims_audit_edits on clm_claims;
create trigger clm_claims_audit_edits after update on clm_claims
for each row execute function clm_claims_audit_edits();

-- staff names for the history (same hospital group only)
create or replace function clm_staff_name(p_user uuid) returns text
language sql stable security definer set search_path = public as $$
  select full_name from clm_user_profiles where user_id = p_user and tenant_id = clm_current_tenant()
$$;
revoke execute on function clm_staff_name(uuid) from public, anon;
grant execute on function clm_staff_name(uuid) to authenticated;

-- Same as 0002, plus payments, reversals and edits, and who did each.
create or replace view clm_v_timeline with (security_invoker = true) as
select t.claim_id, 'status_change'::text as event_type,
       coalesce(t.from_status, 'new') || ' → ' || t.to_status as event_text,
       t.trigger_source as source, t.notes, t.created_at, clm_staff_name(t.actor_id) as actor_name
from clm_state_transitions t
union all
select e.claim_id, e.event_type,
       case e.event_type
         when 'doc_verified' then 'Verified: ' || (e.payload->>'name')
         when 'doc_rejected' then 'Rejected: ' || (e.payload->>'name')
         when 'submit_blocked' then 'Submission blocked'
         when 'field_changed' then e.payload->>'text'
         when 'dispute_letter' then e.payload->>'text'
         else e.event_type end,
       coalesce(e.payload->>'source', 'user'),
       case when e.event_type in ('field_changed','dispute_letter') then null else e.payload->>'note' end,
       e.created_at, clm_staff_name(e.actor_id)
from clm_events e
union all
select d.claim_id, 'document_uploaded', 'Uploaded: ' || d.document_name, d.source, null, d.created_at, null
from clm_documents d
union all
select q.claim_id, 'query_raised', 'Query #' || q.query_number || ': ' || left(q.query_text, 120), q.source, null, q.raised_at, null
from clm_queries q
union all
select q.claim_id, 'query_responded', 'Replied to query #' || q.query_number, 'user', left(q.response_text, 200), q.responded_at,
       clm_staff_name(q.responded_by)
from clm_queries q where q.responded_at is not null
union all
select s.claim_id, 'settlement',
       'Settled ₹' || to_char(s.net_amount, 'FM99,99,99,990') || coalesce(' · UTR ' || s.utr_number, ''),
       s.source, null, s.created_at, clm_staff_name(s.recorded_by)
from clm_settlements s
union all
select r.claim_id, 'payment',
       'Payment received ₹' || to_char(a.amount, 'FM99,99,99,990') || coalesce(' · UTR ' || rc.reference, ''),
       case when rc.narration = 'Typed in ClaimOne' then 'user' when rc.source = 'bank' then 'bank' else 'upload' end,
       case when rc.narration = 'Typed in ClaimOne' then 'Typed on Master' when rc.source = 'bank' then 'From the bank statement'
            else 'From the settlement upload' end,
       a.created_at, clm_staff_name(a.created_by)
from clm_allocations a join clm_receivables r on r.id = a.receivable_id join clm_receipts rc on rc.id = a.receipt_id
where r.claim_id is not null
union all
select r.claim_id, 'payment_reversed', 'Payment entry of ₹' || to_char(a.amount, 'FM99,99,99,990') || ' reversed', 'user',
       a.reverse_reason, a.reversed_at, clm_staff_name(a.reversed_by)
from clm_allocations a join clm_receivables r on r.id = a.receivable_id
where r.claim_id is not null and a.reversed_at is not null
union all
select r.claim_id, 'adjustment',
       case j.kind when 'tds' then 'TDS ₹' else 'Deduction ₹' end || to_char(j.amount, 'FM99,99,99,990') || ' booked'
         || case when j.reversed_at is not null then ' (later reversed)' else '' end,
       'user', case when j.kind = 'tds' then null else j.reason_text end, j.created_at, clm_staff_name(j.created_by)
from clm_adjustments j join clm_receivables r on r.id = j.receivable_id
where r.claim_id is not null and j.kind in ('tds','deduction');
grant select on clm_v_timeline to authenticated;

-- ─── 5. Money in the bank ────────────────────────────────────────────
-- A payment counts as in the bank when it sits on a bank credit, or on a
-- letter tied to one (clm_link_bank_credit).
create or replace view clm_v_case_banked with (security_invoker = true) as
select r.claim_id, r.centre_id,
       coalesce(sum(a.amount) filter (where rc.source = 'bank' or rc.bank_receipt_id is not null), 0) as banked,
       coalesce(sum(a.amount), 0) as received
from clm_allocations a
join clm_receivables r on r.id = a.receivable_id
join clm_receipts rc on rc.id = a.receipt_id
where a.reversed_at is null and r.claim_id is not null and r.debtor_type <> 'patient'
group by r.claim_id, r.centre_id;
grant select on clm_v_case_banked to authenticated;
