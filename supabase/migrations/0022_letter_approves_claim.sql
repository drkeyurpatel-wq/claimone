-- ════════════════════════════════════════════════════════════════════
-- An uploaded settlement letter fills the patient's row by itself.
-- The letter carries the claim decision, so when it lands on a case the
-- desk has not yet marked approved, the case is marked approved (in full
-- or partly) with the letter's approved amount, and the payment then
-- closes it as before. The letter also finds a case that has no bill on
-- the receivables book yet (patients added on Master), by the payer's
-- claim no., the IP no., or the patient's name when only one case fits.
-- ════════════════════════════════════════════════════════════════════

-- the open case a letter is about
create or replace function clm_find_open_claim(p_tenant uuid, p_centre uuid, l jsonb) returns uuid
language sql stable security definer set search_path = public as $$
  with o as (
    select c.id, c.created_at, c.tpa_claim_number, c.admission_ref, c.patient_name, c.status from clm_claims c
    where c.tenant_id = p_tenant and c.centre_id = p_centre
      and c.status not in ('closed','written_off','settled','preauth_rejected','preauth_pending','preauth_query')
  ), by_name as (
    select id from o
    where length(clm_norm_name(l->>'patient_name')) >= 5 and clm_norm_name(patient_name) = clm_norm_name(l->>'patient_name')
  )
  select coalesce(
    (select id from o where clm_norm_ref(l->>'claim_ref') is not null
        and clm_norm_ref(tpa_claim_number) = clm_norm_ref(l->>'claim_ref') order by created_at desc limit 1),
    (select id from o where clm_norm_ref(l->>'ip_no') is not null
        and clm_norm_ref(admission_ref) = clm_norm_ref(l->>'ip_no') order by created_at desc limit 1),
    (select case when (select count(*) from by_name) = 1 then (select id from by_name) end))
  where p_tenant = clm_current_tenant() and clm_can_access_centre(p_centre)
$$;

-- Mark the case approved from the letter, when the desk has not done it yet.
-- approved = the letter's approved amount, else what was paid (net + TDS), else claimed − deduction.
create or replace function clm_approve_from_letter(p_claim uuid, l jsonb) returns boolean
language plpgsql security invoker set search_path = public as $$
declare
  c clm_claims%rowtype; ok boolean := false;
  net numeric := coalesce(nullif(l->>'net_amount', '')::numeric, 0);
  tds numeric := coalesce(nullif(l->>'tds_amount', '')::numeric, 0);
  ded numeric := coalesce(nullif(l->>'deduction_amount', '')::numeric, 0);
  l_claimed numeric := nullif(l->>'claimed_amount', '')::numeric;
  v_appr numeric; v_claimed numeric;
begin
  select * into c from clm_claims where id = p_claim for update;
  if not found or c.status not in ('draft','preauth_approved','preauth_enhanced','claim_query','claim_rejected',
                                   'claim_submitted','claim_under_review') then
    return false;
  end if;
  v_appr := coalesce(nullif(l->>'approved_amount', '')::numeric,
                     case when net + tds > 0 then net + tds end,
                     case when l_claimed is not null and ded > 0 then l_claimed - ded end);
  if coalesce(v_appr, 0) <= 0 then return false; end if;
  v_claimed := greatest(coalesce(c.claimed_amount, l_claimed, v_appr + ded), v_appr);

  perform set_config('claimone.source', 'recon', true);
  perform set_config('claimone.note', 'Claim decision taken from the settlement letter', true);
  begin
    if c.status not in ('claim_submitted','claim_under_review') then
      update clm_claims set status = 'claim_submitted', claimed_amount = v_claimed where id = c.id;
    end if;
    update clm_claims set
      status = case when v_appr >= v_claimed - 1 then 'claim_approved' else 'claim_partial' end,
      approved_amount = v_appr, claimed_amount = v_claimed,
      tpa_claim_number = coalesce(tpa_claim_number, nullif(btrim(l->>'claim_ref'), ''))
    where id = c.id;
    ok := true;
  exception when check_violation then
    ok := false;   -- e.g. papers still required (paper gate on): the payment still books, the desk marks it
  end;
  perform set_config('claimone.source', '', true);
  perform set_config('claimone.note', '', true);
  return ok;
end $$;

-- Same as 0018, plus: the letter's case is found (or its bill made) through the case itself,
-- and the case is marked approved from the letter.
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
  owed numeric; v_claim uuid;
begin
  o_created := false;
  if l ? 'part_of_case' then
    o_id := clm_find_receivable(p_tenant, p_centre, null, k_bill);
  else
    o_id := clm_find_receivable(p_tenant, p_centre, k_claim, k_bill);
    if o_id is not null then
      select claim_id into v_claim from clm_receivables where id = o_id;
    else
      -- through the case: payer's claim no., IP no., or the one open case for this patient
      v_claim := clm_find_open_claim(p_tenant, p_centre, l);
      if v_claim is not null then
        select id into o_id from clm_receivables
        where claim_id = v_claim and debtor_type not in ('patient','referrer') order by created_at limit 1;
      end if;
      if o_id is null and v_claim is null then
        o_id := clm_find_case_bill_by_patient(p_tenant, p_centre, l->>'patient_name');
        if o_id is not null then select claim_id into v_claim from clm_receivables where id = o_id; end if;
      end if;
    end if;
    -- the letter is the claim decision: a case not yet marked approved is marked from it
    -- (approval puts the case's bill on the book, so a case without one gets it here)
    if v_claim is not null and clm_approve_from_letter(v_claim, l) and o_id is null then
      select id into o_id from clm_receivables
      where claim_id = v_claim and debtor_type not in ('patient','referrer') order by created_at limit 1;
    end if;
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

revoke execute on function clm_find_open_claim(uuid, uuid, jsonb) from public, anon;
grant execute on function clm_find_open_claim(uuid, uuid, jsonb) to authenticated;
revoke execute on function clm_approve_from_letter(uuid, jsonb) from public, anon;
grant execute on function clm_approve_from_letter(uuid, jsonb) to authenticated;
revoke execute on function clm_upsert_bill(uuid, uuid, uuid, jsonb, text) from public, anon;
grant execute on function clm_upsert_bill(uuid, uuid, uuid, jsonb, text) to authenticated;
