-- ════════════════════════════════════════════════════════════════════
-- Fixes from the audit (28 Oct 2026) and paper tick boxes.
-- ════════════════════════════════════════════════════════════════════

-- ─── 1. A letter's deduction is measured from the claim; the approval cut is
-- already off the bill, so only the rest is booked (no double count, no false "paid more").
create or replace function clm_letter_deduction_net() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_cut numeric;
begin
  select greatest(coalesce(c.claimed_amount, 0) - r.expected_amount, 0) into v_cut
  from clm_receivables r join clm_claims c on c.id = r.claim_id
  where r.id = new.receivable_id and c.approved_amount is not null;
  if coalesce(v_cut, 0) > 0 then
    new.amount := round(new.amount - v_cut, 2);
    if new.amount <= 0.5 then return null; end if;
  end if;
  return new;
end $$;
drop trigger if exists clm_adj_letter_net on clm_adjustments;
create trigger clm_adj_letter_net before insert on clm_adjustments for each row
  when (new.kind = 'deduction' and new.remittance_line_id is not null) execute function clm_letter_deduction_net();

-- ─── 2. Leakage: the reason picked heads the note; months in IST.
drop view if exists clm_v_leakage;
create view clm_v_leakage with (security_invoker = true) as
with itemised as (
  select d.tenant_id, c.centre_id, c.payer_id, c.treating_doctor_name as doctor, d.kind, d.category, d.recorded_at as at, d.amount
  from clm_disallowances d join clm_claims c on c.id = d.claim_id
),
approval_cut as (
  select c.tenant_id, c.centre_id, c.payer_id, c.treating_doctor_name as doctor, 'deduction'::text as kind,
         clm_deduction_category(split_part(t.notes, ' — ', 1)) as category, coalesce(t.created_at, c.updated_at) as at,
         c.claimed_amount - c.approved_amount as amount
  from clm_claims c
  left join lateral (
    select notes, created_at from clm_state_transitions s
    where s.claim_id = c.id and s.to_status = 'claim_partial' order by created_at desc limit 1
  ) t on true
  where c.status in ('claim_partial','settlement_pending','settled','closed')
    and c.claimed_amount > c.approved_amount
    and (c.status = 'claim_partial' or t.created_at is not null)
    and not exists (select 1 from clm_disallowances d where d.claim_id = c.id)
),
short_paid as (
  select r.tenant_id, r.centre_id, coalesce(c.payer_id, r.payer_id) as payer_id,
         coalesce(c.treating_doctor_name, r.doctor_name) as doctor, 'deduction'::text as kind,
         coalesce(a.category, 'other') as category, a.created_at as at, a.amount
  from clm_adjustments a
  join clm_receivables r on r.id = a.receivable_id
  left join clm_claims c on c.id = r.claim_id
  where a.kind = 'deduction' and a.reversed_at is null
    and (r.claim_id is null or not exists (select 1 from clm_disallowances d where d.claim_id = r.claim_id))
),
everything as (
  select * from itemised union all select * from approval_cut union all select * from short_paid
)
select e.tenant_id, e.centre_id, e.payer_id, coalesce(p.name, 'Unknown payer') as payer_name,
       coalesce(nullif(e.doctor, ''), '—') as doctor_name,
       e.kind, e.category, clm_is_preventable(e.category) as is_preventable,
       date_trunc('month', e.at at time zone 'Asia/Kolkata')::date as month,
       count(*)::int as items,
       sum(e.amount) as amount
from everything e
left join clm_payers p on p.id = e.payer_id
where e.amount > 0
group by 1,2,3,4,5,6,7,8,9;


grant select on clm_v_leakage to authenticated;

-- ─── 3. Due clocks run from the last status change, not from any edit.
alter table clm_claims add column if not exists status_changed_at timestamptz;
update clm_claims c set status_changed_at = coalesce(
  (select max(created_at) from clm_state_transitions s where s.claim_id = c.id), c.created_at) where status_changed_at is null;
alter table clm_claims alter column status_changed_at set default now();
create or replace function clm_stamp_status_change() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then new.status_changed_at := now(); end if;
  return new;
end $$;
drop trigger if exists clm_claims_status_stamp on clm_claims;
create trigger clm_claims_status_stamp before insert or update on clm_claims for each row execute function clm_stamp_status_change();

-- ─── 4. eCW import: IST dates; touch a case only when something changed; give an
-- approval-time bill its bill no.; no insurer bill on a closed or rejected case.
create or replace function clm_import_cases(p_centre uuid, p_file text, p_rows jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  t uuid := clm_current_tenant();
  r jsonb; batch uuid; c clm_claims%rowtype; sp record; cid uuid;
  adm_d date; dis_d date; ip text; net numeric; paid numeric; owed numeric; dis timestamptz; adm timestamptz;
  n_new int := 0; n_upd int := 0; n_cash int := 0; n_skip int := 0; n_bills int := 0;
  unknown text[] := '{}';
  open_status text[] := array['draft','preauth_pending','preauth_query','preauth_approved','preauth_enhanced','preauth_rejected'];
begin
  if t is null or not clm_can_write() then raise exception 'Read-only access' using errcode = 'insufficient_privilege'; end if;
  if not clm_can_access_centre(p_centre) or not exists (select 1 from clm_centres where id = p_centre and tenant_id = t) then
    raise exception 'No access to this centre' using errcode = 'insufficient_privilege';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then
    raise exception 'Send at most 5000 rows at a time' using errcode = 'check_violation';
  end if;

  insert into clm_import_batches (tenant_id, centre_id, kind, file_name, row_count)
  values (t, p_centre, 'ecw_cases', left(coalesce(p_file, 'upload'), 300), jsonb_array_length(p_rows)) returning id into batch;

  for r in select * from jsonb_array_elements(p_rows) loop
    ip := nullif(trim(r->>'ip_no'), '');
    if ip is null or nullif(trim(r->>'patient_name'), '') is null then n_skip := n_skip + 1; continue; end if;

    select * into sp from clm_payer_for_sponsor(t, p_centre, r->>'sponsor');
    if not sp.o_known then
      if clm_sponsor_key(r->>'sponsor') is not null and not (clm_sponsor_key(r->>'sponsor') = any(unknown)) then
        unknown := unknown || clm_sponsor_key(r->>'sponsor');
      end if;
      n_skip := n_skip + 1; continue;
    end if;
    if not sp.o_credit then n_cash := n_cash + 1; continue; end if;

    net  := nullif(r->>'net_amount', '')::numeric;
    paid := coalesce(nullif(r->>'paid_amount', '')::numeric, 0);
    owed := case when net is not null and nullif(r->>'bill_no', '') is not null then greatest(net - paid, 0) end;
    adm  := nullif(r->>'admitted_at', '')::timestamptz;
    dis  := nullif(r->>'discharged_at', '')::timestamptz;
    adm_d := (adm at time zone 'Asia/Kolkata')::date;
    dis_d := (dis at time zone 'Asia/Kolkata')::date;

    select * into c from clm_claims where centre_id = p_centre and upper(admission_ref) = upper(ip);
    if not found then
      insert into clm_claims (tenant_id, centre_id, payer_id, claim_type, patient_name, patient_phone, patient_uhid,
                              admission_ref, treating_doctor_name, department_name, admission_date, discharge_date,
                              admitted_at, intimated_at, discharged_at, estimated_amount, claimed_amount,
                              bill_no, bill_amount, discount_amount, patient_paid, bed_category, sponsor_name, case_source,
                              patient_gender, patient_age_years)
      values (t, p_centre, sp.o_payer, clm_claim_type_for(sp.o_payer), left(trim(r->>'patient_name'), 200),
              nullif(r->>'phone', ''), nullif(r->>'uhid', ''), ip, nullif(r->>'doctor', ''), nullif(r->>'specialisation', ''),
              adm_d, dis_d, adm, nullif(r->>'intimated_at', '')::timestamptz, dis,
              nullif(r->>'estimated_amount', '')::numeric, owed,
              nullif(r->>'bill_no', ''), nullif(r->>'bill_amount', '')::numeric, nullif(r->>'discount_amount', '')::numeric,
              paid, nullif(r->>'bed_category', ''), left(r->>'sponsor', 120), 'ecw',
              nullif(r->>'gender', ''), nullif(r->>'age_years', '')::int)
      returning * into c;
      n_new := n_new + 1;
    else
      update clm_claims set
        payer_id      = case when status = 'draft' then sp.o_payer else payer_id end,
        claim_type    = case when status = 'draft' then clm_claim_type_for(sp.o_payer) else claim_type end,
        discharge_date = coalesce(dis_d, discharge_date),
        discharged_at = coalesce(dis, discharged_at),
        intimated_at  = coalesce(intimated_at, nullif(r->>'intimated_at', '')::timestamptz),
        bill_no       = coalesce(nullif(r->>'bill_no', ''), bill_no),
        bill_amount   = coalesce(nullif(r->>'bill_amount', '')::numeric, bill_amount),
        discount_amount = coalesce(nullif(r->>'discount_amount', '')::numeric, discount_amount),
        patient_paid  = coalesce(nullif(r->>'paid_amount', '')::numeric, patient_paid),
        claimed_amount = case when owed is not null and status = any(open_status) then owed else claimed_amount end,
        treating_doctor_name = coalesce(treating_doctor_name, nullif(r->>'doctor', '')),
        sponsor_name  = coalesce(sponsor_name, left(r->>'sponsor', 120)),
        patient_gender = coalesce(patient_gender, nullif(r->>'gender', '')),
        patient_age_years = coalesce(patient_age_years, nullif(r->>'age_years', '')::int)
      where id = c.id
        -- touch the case only when eCW brings something new, so due clocks are not reset
        and (discharged_at is distinct from coalesce(dis, discharged_at)
          or bill_no is distinct from coalesce(nullif(r->>'bill_no', ''), bill_no)
          or bill_amount is distinct from coalesce(nullif(r->>'bill_amount', '')::numeric, bill_amount)
          or (status = 'draft' and payer_id is distinct from sp.o_payer)
          or (owed is not null and status = any(open_status) and claimed_amount is distinct from owed)
          or (treating_doctor_name is null and nullif(r->>'doctor', '') is not null)
          or (patient_gender is null and nullif(r->>'gender', '') is not null)
          or (intimated_at is null and nullif(r->>'intimated_at', '') is not null))
      returning * into c;
      if found then n_upd := n_upd + 1; else select * into c from clm_claims where centre_id = p_centre and upper(admission_ref) = upper(ip); end if;
    end if;

    -- a final bill is money owed: put it on the receivables book once
    -- a bill made at approval (no bill no. yet) takes the eCW bill no., so payment letters find it
    if c.bill_no is not null then
      update clm_receivables set bill_no = c.bill_no
      where claim_id = c.id and debtor_type <> 'patient' and bill_no is null
        and not exists (select 1 from clm_receivables x where x.tenant_id = t and x.centre_id = p_centre and x.bill_no = c.bill_no and x.debtor_type <> 'patient');
    end if;
    -- a closed, written-off or rejected case is not money owed by the insurer
    if owed is not null and owed > 0 and c.status not in ('closed','written_off','preauth_rejected','claim_rejected')
       and not exists (select 1 from clm_receivables where claim_id = c.id and debtor_type <> 'patient') then
      insert into clm_receivables (tenant_id, centre_id, claim_id, debtor_type, payer_id, debtor_name, bill_no, ip_no, uhid,
                                   bill_date, patient_name, doctor_name, billed_amount, expected_amount, source, import_batch_id, notes)
      select t, p_centre, c.id,
             case py.type when 'government' then 'government' when 'corporate' then 'corporate' when 'tpa' then 'tpa' else 'insurer' end,
             py.id, py.name, c.bill_no, ip, c.patient_uhid,
             coalesce(nullif(r->>'bill_date', '')::date, dis_d, (now() at time zone 'Asia/Kolkata')::date), c.patient_name, c.treating_doctor_name,
             nullif(r->>'bill_amount', '')::numeric, owed, 'claim', batch, 'From eCW export'
      from clm_payers py where py.id = c.payer_id
      on conflict (tenant_id, centre_id, debtor_type, bill_no)
        do update set claim_id = coalesce(clm_receivables.claim_id, excluded.claim_id);
      n_bills := n_bills + 1;
    end if;
  end loop;

  return jsonb_build_object('batch_id', batch, 'created', n_new, 'updated', n_upd, 'cash', n_cash,
                            'skipped', n_skip, 'bills', n_bills, 'unknown_sponsors', to_jsonb(unknown));
end $$;

-- ─── 5. A disputed bill that is then paid in full stops being disputed.
create or replace function clm_clear_paid_dispute() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update clm_receivables r set status = 'open'
  where r.id = new.receivable_id and r.status = 'disputed'
    and abs(r.expected_amount
            - coalesce((select sum(amount) from clm_allocations where receivable_id = r.id and reversed_at is null), 0)
            - coalesce((select sum(amount) from clm_adjustments where receivable_id = r.id and reversed_at is null), 0)) <= 1;
  return null;
end $$;
drop trigger if exists clm_alloc_undispute on clm_allocations;
create trigger clm_alloc_undispute after insert on clm_allocations for each row execute function clm_clear_paid_dispute();
drop trigger if exists clm_adj_undispute on clm_adjustments;
create trigger clm_adj_undispute after insert on clm_adjustments for each row execute function clm_clear_paid_dispute();

-- ─── 6. Papers: a tick says "attached on the insurer website"; a file is optional.
alter table clm_documents alter column file_path drop not null;
alter table clm_documents add column if not exists attested boolean not null default false;
alter table clm_documents drop constraint if exists clm_documents_file_or_tick;
alter table clm_documents add constraint clm_documents_file_or_tick check (file_path is not null or attested);

create or replace function clm_tick_document(p_claim uuid, p_doc_code text, p_label text, p_on boolean) returns void
language plpgsql security invoker set search_path = public as $$
declare v_id uuid;
begin
  if not clm_can_write() then raise exception 'Read-only access' using errcode = 'insufficient_privilege'; end if;
  if coalesce(trim(p_doc_code), '') = '' then raise exception 'Which paper?' using errcode = 'check_violation'; end if;
  if p_on then
    if exists (select 1 from clm_documents where claim_id = p_claim and doc_code = p_doc_code and status = 'valid') then return; end if;
    insert into clm_documents (claim_id, doc_code, document_name, document_category, file_path, attested, source)
    values (p_claim, p_doc_code, left(coalesce(nullif(trim(p_label), ''), p_doc_code), 200), 'clinical', null, true, 'manual')
    returning id into v_id;
    update clm_documents set status = 'valid', review_note = 'Ticked — sent to the insurer' where id = v_id;
  else
    update clm_documents set status = 'invalid', review_note = 'Unticked'
    where claim_id = p_claim and doc_code = p_doc_code and attested and status = 'valid';
  end if;
end $$;

-- ─── 7. The insurer's query text can name the patient.
comment on column clm_nhcx_messages.summary is 'PHI: payer reply summary — decision and amounts, and the payer''s query text';

do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'clm\_%' loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;
grant execute on function clm_nhcx_receive(text, jsonb) to anon;
