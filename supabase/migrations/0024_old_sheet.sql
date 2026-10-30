-- ════════════════════════════════════════════════════════════════════
-- Old Excel sheet → Master.
-- Cases brought over from the desk's old sheet are kept apart from cases
-- entered in ClaimOne: case_source = 'sheet', every status change and
-- payment is marked as coming from the old sheet in the case history.
-- Each case goes through the normal status rules (submitted → approved),
-- its payment is booked like a typed payment, and the usual cut rules
-- apply: a short payment of ₹1,000 or more waits for Accept / Dispute.
-- ════════════════════════════════════════════════════════════════════

alter table clm_claims drop constraint if exists clm_claims_case_source_check;
alter table clm_claims add constraint clm_claims_case_source_check check (case_source in ('manual','ecw','hmis','sheet'));

-- One bill from the old sheet. Returns 'loaded', 'exists' (IP no. already on Master) or the reason it was skipped.
create or replace function clm_import_sheet_case(p_centre uuid, r jsonb) returns text
language plpgsql security invoker set search_path = public as $$
declare
  t uuid := clm_current_tenant(); v_payer uuid; v_id uuid; v_rec clm_receivables%rowtype;
  total numeric := coalesce((r->>'total')::numeric, 0);
  claimed numeric; approved numeric := nullif(r->>'approved', '')::numeric;
  received numeric := coalesce(nullif(r->>'received', '')::numeric, 0);
  tds numeric := coalesce(nullif(r->>'tds', '')::numeric, 0);
  v_day date := (r->>'discharge')::date; v_bill date := coalesce(nullif(r->>'bill_date', '')::date, (r->>'discharge')::date);
  v_pay date := nullif(r->>'pay_date', '')::date; v_utr text := nullif(btrim(r->>'utr'), '');
  batch uuid; rem uuid; rc uuid; bank uuid; short numeric;
begin
  if t is null or not clm_can_write() then raise exception 'Read-only access' using errcode = 'insufficient_privilege'; end if;
  if exists (select 1 from clm_claims where centre_id = p_centre and upper(btrim(admission_ref)) = upper(btrim(r->>'ip'))) then return 'exists'; end if;
  select id into v_payer from clm_payers where code = r->>'payer_code' and (tenant_id is null or tenant_id = t) order by tenant_id nulls last limit 1;
  if v_payer is null then return 'unknown payer ' || coalesce(r->>'payer_code', ''); end if;
  if approved is null or approved <= 0 then return 'no approved amount'; end if;
  claimed := greatest(total - coalesce((r->>'discount')::numeric, 0) - coalesce((r->>'patient_paid')::numeric, 0), approved);

  perform set_config('claimone.source', 'sheet', true);
  perform set_config('claimone.note', 'Loaded from the old Excel sheet', true);
  insert into clm_claims (tenant_id, centre_id, payer_id, claim_type, patient_name, admission_ref, treating_doctor_name,
                          admitted_at, admission_date, discharged_at, discharge_date, bill_no, bill_amount, discount_amount, patient_paid,
                          policy_number, notes, case_source)
  values (t, p_centre, v_payer, coalesce(r->>'claim_type', 'cashless'), btrim(r->>'name'), btrim(r->>'ip'), nullif(btrim(r->>'doctor'), ''),
          (v_day::text || 'T12:00:00+05:30')::timestamptz, null, (v_day::text || 'T12:00:00+05:30')::timestamptz, v_day,
          nullif(btrim(r->>'bill_no'), ''), total, coalesce((r->>'discount')::numeric, 0), coalesce((r->>'patient_paid')::numeric, 0),
          nullif(btrim(r->>'policy'), ''), nullif(btrim(r->>'remarks'), ''), 'sheet')
  returning id into v_id;

  perform clm_transition(v_id, 'claim_submitted',
    jsonb_strip_nulls(jsonb_build_object('claimed_amount', claimed, 'tpa_claim_number', nullif(btrim(r->>'claim_no'), ''))),
    'Loaded from the old Excel sheet');
  update clm_claims set submitted_at = (v_bill::text || 'T12:00:00+05:30')::timestamptz where id = v_id;
  perform clm_transition(v_id, case when approved >= claimed - 1 then 'claim_approved' else 'claim_partial' end,
    jsonb_build_object('approved_amount', approved),
    case when approved >= claimed - 1 then 'Approved — as per the old Excel sheet' else 'Other — approved less, as per the old Excel sheet' end);

  -- the bill the approval put on the book takes the hospital bill no., so later letters find it
  select * into v_rec from clm_receivables where claim_id = v_id and debtor_type <> 'patient';
  update clm_receivables set bill_no = coalesce(nullif(btrim(r->>'bill_no'), ''), bill_no), bill_date = v_bill,
         billed_amount = claimed, source = 'import'
  where id = v_rec.id;

  if received > 0 then
    v_utr := coalesce(v_utr, 'SHEET-' || coalesce(nullif(btrim(r->>'bill_no'), ''), btrim(r->>'ip')));
    v_pay := coalesce(v_pay, v_bill);
    insert into clm_import_batches (tenant_id, centre_id, kind, file_name, row_count)
    values (t, p_centre, 'weekly_payments', 'Old Excel sheet', 1) returning id into batch;
    insert into clm_remittance_lines (tenant_id, centre_id, payer_id, payer_name, utr, advice_date, claim_ref, bill_no, patient_name,
                                      approved_amount, claimed_amount, tds_amount, deduction_amount, net_amount,
                                      payment_date, source, file_name, receivable_id, import_batch_id)
    values (t, p_centre, v_rec.payer_id, v_rec.debtor_name, v_utr, v_pay, nullif(btrim(r->>'claim_no'), ''), nullif(btrim(r->>'bill_no'), ''),
            btrim(r->>'name'), approved, claimed, tds, 0, received, v_pay, 'letter', 'Old Excel sheet', v_rec.id, batch)
    on conflict do nothing returning id into rem;
    if rem is not null then
      rc := clm_bank_receipt_for(t, p_centre, v_utr, received);
      if rc is null then bank := clm_bank_credit_any(t, p_centre, v_utr); end if;
      if rc is null then
        insert into clm_receipts (tenant_id, centre_id, source, bank_account, value_date, amount, reference, narration, payer_id,
                                  import_batch_id, bank_receipt_id, bank_confirmed_on)
        values (t, p_centre, 'advice', 'advice:' || rem, v_pay, received, v_utr, 'Old Excel sheet', v_rec.payer_id,
                batch, bank, (select value_date from clm_receipts where id = bank))
        returning id into rc;
      end if;
      -- a small short payment on a bill the sheet marks settled was let go: booked, so the file closes
      short := approved - received - tds;
      if r->>'sheet_status' = 'Settled' and short >= 1 and short < clm_cut_floor() then
        insert into clm_adjustments (tenant_id, receivable_id, kind, amount, category, reason_text, remittance_line_id)
        values (t, v_rec.id, 'deduction', short, 'other', 'Short-paid under ₹1,000 — closed as per the old Excel sheet', rem);
      end if;
      if tds > 0 then
        insert into clm_adjustments (tenant_id, receivable_id, kind, amount, reason_text, remittance_line_id)
        values (t, v_rec.id, 'tds', tds, 'TDS as per settlement', rem);
      end if;
      insert into clm_allocations (tenant_id, receipt_id, receivable_id, amount, method, remittance_line_id)
      values (t, rc, v_rec.id, received, 'advice', rem);
    end if;
  end if;
  -- the follow-up clock runs from the bill (or the payment), not from the day the sheet was loaded
  update clm_claims set status_changed_at = case when status = 'settled' then (coalesce(v_pay, v_bill)::text || 'T12:00:00+05:30')::timestamptz
                                                 else (v_bill::text || 'T12:00:00+05:30')::timestamptz end
  where id = v_id;
  perform set_config('claimone.source', '', true);
  perform set_config('claimone.note', '', true);
  return 'loaded';
end $$;
revoke execute on function clm_import_sheet_case(uuid, jsonb) from public, anon;
grant execute on function clm_import_sheet_case(uuid, jsonb) to authenticated;

-- Same as 0023, with payments from the old sheet named as such.
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
       case when rc.narration = 'Typed in ClaimOne' then 'user' when rc.narration = 'Old Excel sheet' then 'sheet'
            when rc.source = 'bank' then 'bank' else 'upload' end,
       case when rc.narration = 'Typed in ClaimOne' then 'Typed on Master' when rc.narration = 'Old Excel sheet' then 'From the old Excel sheet'
            when rc.source = 'bank' then 'From the bank statement' else 'From the settlement upload' end,
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
