-- ════════════════════════════════════════════════════════════════════
-- NHCX case details: what an NHCX pre-auth / claim needs that eCW does not
-- always give (gender, age, member ID, the doctor's HPR ID, medical vs
-- surgical). The eCW import now fills gender and age.
-- ════════════════════════════════════════════════════════════════════

alter table clm_claims add column if not exists patient_gender text check (patient_gender in ('male','female','other','unknown'));
alter table clm_claims add column if not exists patient_age_years int check (patient_age_years between 0 and 130);
alter table clm_claims add column if not exists member_id text check (length(member_id) <= 80);
alter table clm_claims add column if not exists treating_doctor_hpr_id text check (treating_doctor_hpr_id ~ '^\d{2}-\d{4}-\d{4}-\d{4}$');
alter table clm_claims add column if not exists treatment_type text check (treatment_type in ('medical','surgical'));
comment on column clm_claims.member_id is 'PHI: insurance member / card ID';

-- payment acknowledgements go on /v1/task/submit for some payers
alter table clm_nhcx_messages drop constraint if exists clm_nhcx_messages_api_call_check;
alter table clm_nhcx_messages add constraint clm_nhcx_messages_api_call_check
  check (api_call in ('coverageeligibility','preauth','claim','communication','paymentnotice','status','predetermination','task'));

-- the import also takes gender and age (rows: … gender, age_years)
create or replace function clm_import_cases(p_centre uuid, p_file text, p_rows jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  t uuid := clm_current_tenant();
  r jsonb; batch uuid; c clm_claims%rowtype; sp record; cid uuid;
  ip text; net numeric; paid numeric; owed numeric; dis timestamptz; adm timestamptz;
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

    select * into c from clm_claims where centre_id = p_centre and upper(admission_ref) = upper(ip);
    if not found then
      insert into clm_claims (tenant_id, centre_id, payer_id, claim_type, patient_name, patient_phone, patient_uhid,
                              admission_ref, treating_doctor_name, department_name, admission_date, discharge_date,
                              admitted_at, intimated_at, discharged_at, estimated_amount, claimed_amount,
                              bill_no, bill_amount, discount_amount, patient_paid, bed_category, sponsor_name, case_source,
                              patient_gender, patient_age_years)
      values (t, p_centre, sp.o_payer, clm_claim_type_for(sp.o_payer), left(trim(r->>'patient_name'), 200),
              nullif(r->>'phone', ''), nullif(r->>'uhid', ''), ip, nullif(r->>'doctor', ''), nullif(r->>'specialisation', ''),
              adm::date, dis::date, adm, nullif(r->>'intimated_at', '')::timestamptz, dis,
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
        discharge_date = coalesce(dis::date, discharge_date),
        discharged_at = coalesce(dis, discharged_at),
        intimated_at  = coalesce(intimated_at, nullif(r->>'intimated_at', '')::timestamptz),
        bill_no       = coalesce(nullif(r->>'bill_no', ''), bill_no),
        bill_amount   = coalesce(nullif(r->>'bill_amount', '')::numeric, bill_amount),
        discount_amount = coalesce(nullif(r->>'discount_amount', '')::numeric, discount_amount),
        patient_paid  = coalesce(nullif(r->>'paid_amount', '')::numeric, patient_paid),
        claimed_amount = case when owed is not null and status = any(open_status) then owed else claimed_amount end,
        treating_doctor_name = coalesce(treating_doctor_name, nullif(r->>'doctor', '')),
        sponsor_name  = left(r->>'sponsor', 120),
        patient_gender = coalesce(patient_gender, nullif(r->>'gender', '')),
        patient_age_years = coalesce(patient_age_years, nullif(r->>'age_years', '')::int)
      where id = c.id
      returning * into c;
      n_upd := n_upd + 1;
    end if;

    -- a final bill is money owed: put it on the receivables book once
    if owed is not null and owed > 0
       and not exists (select 1 from clm_receivables where claim_id = c.id and debtor_type <> 'patient') then
      insert into clm_receivables (tenant_id, centre_id, claim_id, debtor_type, payer_id, debtor_name, bill_no, ip_no, uhid,
                                   bill_date, patient_name, doctor_name, billed_amount, expected_amount, source, import_batch_id, notes)
      select t, p_centre, c.id,
             case py.type when 'government' then 'government' when 'corporate' then 'corporate' when 'tpa' then 'tpa' else 'insurer' end,
             py.id, py.name, c.bill_no, ip, c.patient_uhid,
             coalesce(nullif(r->>'bill_date', '')::date, dis::date, current_date), c.patient_name, c.treating_doctor_name,
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

-- How a payer is reached. NHCX participant codes are the same for every
-- hospital, so an admin may set them on the shared payer list.
create or replace function clm_set_payer_route(p_payer uuid, p_channel text, p_nhcx_code text, p_live boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if clm_current_role() is distinct from 'admin' then
    raise exception 'Only an admin can change how a payer is reached' using errcode = 'insufficient_privilege';
  end if;
  if p_channel not in ('portal','email','tms','direct') then raise exception 'Unknown channel' using errcode = 'check_violation'; end if;
  if p_live and coalesce(p_nhcx_code, '') !~ '^[0-9A-Za-z._-]+@[a-z]+$' then
    raise exception 'Enter the NHCX code (like 1000003538@hcx) before turning NHCX on' using errcode = 'check_violation';
  end if;
  update clm_payers set channel = p_channel, nhcx_code = nullif(trim(p_nhcx_code), ''), is_nhcx_live = p_live
  where id = p_payer and (tenant_id is null or tenant_id = clm_current_tenant());
  if not found then raise exception 'Payer not found' using errcode = 'no_data_found'; end if;
end $$;

do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'clm\_%' loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;
grant execute on function clm_nhcx_receive(text, jsonb) to anon;
