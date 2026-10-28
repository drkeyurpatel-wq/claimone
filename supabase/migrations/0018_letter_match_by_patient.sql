-- ════════════════════════════════════════════════════════════════════
-- Payment letters that carry a different claim no. than the one typed on the
-- case still reach the case's bill (by patient, when exactly one unpaid case
-- bill fits); and a letter bill made without a claimed amount owes approved +
-- deduction, so its own deduction does not show it as "paid more".
-- ════════════════════════════════════════════════════════════════════

create or replace function clm_norm_name(p text) returns text
language sql immutable set search_path = public as $$
  select nullif(regexp_replace(upper(regexp_replace(coalesce(p, ''), '^(MR|MRS|MS|MISS|MASTER|BABY|DR)\.?\s+', '', 'i')), '[^A-Z0-9]+', '', 'g'), '')
$$;

create or replace function clm_find_case_bill_by_patient(p_tenant uuid, p_centre uuid, p_patient text) returns uuid
language sql stable security definer set search_path = public as $$
  with c as (
    select r.id from clm_receivables r
    where r.tenant_id = p_tenant and r.centre_id = p_centre and r.claim_id is not null and r.status <> 'closed'
      and r.debtor_type not in ('patient','referrer')
      and clm_norm_name(r.patient_name) = clm_norm_name(p_patient) and length(clm_norm_name(p_patient)) >= 5
      and r.expected_amount
          - coalesce((select sum(amount) from clm_allocations where receivable_id = r.id and reversed_at is null), 0)
          - coalesce((select sum(amount) from clm_adjustments where receivable_id = r.id and reversed_at is null), 0) > 1
  )
  select case when (select count(*) from c) = 1 then (select id from c) end
  where p_tenant = clm_current_tenant() and clm_can_access_centre(p_centre)
$$;

create or replace function clm_upsert_bill(p_tenant uuid, p_centre uuid, p_batch uuid, l jsonb, p_src text,
                                           out o_id uuid, out o_created boolean)
language plpgsql security invoker set search_path = public as $$
declare
  p clm_payers%rowtype; dtype text; k_claim text := clm_norm_ref(l->>'claim_ref'); k_bill text := clm_norm_ref(l->>'bill_no');
  net numeric := coalesce(nullif(l->>'net_amount', '')::numeric, 0);
  tds numeric := coalesce(nullif(l->>'tds_amount', '')::numeric, 0);
  ded numeric := coalesce(nullif(l->>'deduction_amount', '')::numeric, 0);
  claimed numeric := nullif(l->>'claimed_amount', '')::numeric;
  approved numeric := nullif(l->>'approved_amount', '')::numeric;
  owed numeric;
begin
  o_created := false;
  if l ? 'part_of_case' then
    o_id := clm_find_receivable(p_tenant, p_centre, null, k_bill);
  else
    o_id := clm_find_receivable(p_tenant, p_centre, k_claim, k_bill);
    -- the claim no. on the letter may differ from the one typed on the case: fall back to
    -- the one unpaid case bill for this patient (only when exactly one fits)
    if o_id is null then o_id := clm_find_case_bill_by_patient(p_tenant, p_centre, l->>'patient_name'); end if;
  end if;

  if o_id is not null then
    update clm_receivables set
      claim_ref = coalesce(claim_ref, nullif(l->>'claim_ref', '')),
      uhid = coalesce(uhid, nullif(l->>'uhid', '')),
      billed_amount = coalesce(billed_amount, claimed)
    where id = o_id;
    return;
  end if;

  -- deduction = claimed − approved, so a letter without the claimed amount implies approved + deduction
  owed := coalesce(claimed, approved + ded, net + tds + ded);
  if p_src = 'pmjay' then
    owed := greatest(owed, net + tds);
    select py.* into p from clm_payers py, clm_centres c
    where c.id = p_centre and py.tenant_id is null
      and py.code = case when c.state ilike 'rajasthan' then 'pmjay_rajasthan' else 'pmjay_gujarat' end;
    dtype := 'government';
  else
    p.id := clm_match_payer(l->>'payer_name', l->>'tpa_name', p_tenant);
    if p.id is not null then select * into p from clm_payers where id = p.id; end if;
    dtype := case p.type when 'government' then 'government' when 'corporate' then 'corporate' when 'tpa' then 'tpa' else 'insurer' end;
  end if;

  insert into clm_receivables (tenant_id, centre_id, debtor_type, payer_id, debtor_name, bill_no, ip_no, uhid, claim_ref,
                               bill_date, patient_name, doctor_name, billed_amount, expected_amount, notes, source, import_batch_id)
  values (p_tenant, p_centre, dtype, p.id,
          coalesce(p.name, nullif(l->>'payer_name', ''), nullif(l->>'tpa_name', ''), 'Unknown payer'),
          coalesce(nullif(l->>'bill_no', ''), 'CLAIM-' || k_claim), nullif(l->>'ip_no', ''), nullif(l->>'uhid', ''),
          nullif(l->>'claim_ref', ''), coalesce(nullif(l->>'bill_date', '')::date, nullif(l->>'payment_date', '')::date, current_date),
          nullif(l->>'patient_name', ''), nullif(l->>'doctor_name', ''), claimed, owed,
          case p_src when 'pmjay' then 'Created from PMJAY settlement sheet' else 'Created from settlement letter' end,
          'import', p_batch)
  on conflict (tenant_id, centre_id, debtor_type, bill_no) do update set claim_ref = coalesce(clm_receivables.claim_ref, excluded.claim_ref)
  returning id into o_id;
  o_created := true;
end $$;

do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'clm\_%' loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;
grant execute on function clm_nhcx_receive(text, jsonb) to anon;
