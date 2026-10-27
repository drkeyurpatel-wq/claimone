-- ════════════════════════════════════════════════════════════════════
-- PMJAY pays per case ID, not per invoice. A dialysis case with six
-- session invoices is paid once; the settlement sheet repeats that one
-- total on every invoice row. The browser now sends such a case as one
-- payment line with a "bills" list, and this version of
-- clm_apply_payments spreads that payment over the case's invoices.
-- ════════════════════════════════════════════════════════════════════

-- Find the bill for a line (case ID / claim no, then bill no) or create it.
-- Returns the receivable id; p_created tells whether it was new.
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
  -- invoices of a multi-invoice case are found by their own bill no first
  if l ? 'part_of_case' then
    o_id := clm_find_receivable(p_tenant, p_centre, null, k_bill);
  else
    o_id := clm_find_receivable(p_tenant, p_centre, k_claim, k_bill);
  end if;

  if o_id is not null then
    update clm_receivables set
      claim_ref = coalesce(claim_ref, nullif(l->>'claim_ref', '')),
      uhid = coalesce(uhid, nullif(l->>'uhid', ''))
    where id = o_id;
    return;
  end if;

  owed := coalesce(claimed, approved, net + tds + ded);
  if p_src = 'pmjay' then
    owed := greatest(owed, net + tds);
    select * into p from clm_payers where code = 'pmjay_gujarat' limit 1;
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

create or replace function clm_apply_payments(p_centre uuid, p_file text, p_lines jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  t uuid := clm_current_tenant();
  l jsonb; b jsonb; rv clm_receivables%rowtype;
  batch uuid; rem uuid; rc uuid; rid uuid; made boolean;
  ids uuid[]; caps numeric[]; i int; n int;
  src text; net numeric; tds numeric; ded numeric; claimed numeric; approved numeric;
  gross numeric; left_gross numeric; part numeric; part_net numeric; left_net numeric; pdate date;
  n_matched int := 0; n_created int := 0; n_unpaid int := 0; n_dup int := 0; n_skip int := 0;
begin
  if t is null or not clm_can_write() then raise exception 'Read-only access' using errcode = 'insufficient_privilege'; end if;
  if not clm_can_access_centre(p_centre) or not exists (select 1 from clm_centres where id = p_centre and tenant_id = t) then
    raise exception 'No access to this centre' using errcode = 'insufficient_privilege';
  end if;

  insert into clm_import_batches (tenant_id, centre_id, kind, file_name, row_count)
  values (t, p_centre, 'weekly_payments', left(coalesce(p_file, 'upload'), 300), jsonb_array_length(p_lines)) returning id into batch;

  for l in select * from jsonb_array_elements(p_lines) loop
    src      := coalesce(nullif(l->>'source', ''), 'letter');
    net      := coalesce(nullif(l->>'net_amount', '')::numeric, 0);
    tds      := coalesce(nullif(l->>'tds_amount', '')::numeric, 0);
    ded      := coalesce(nullif(l->>'deduction_amount', '')::numeric, 0);
    claimed  := nullif(l->>'claimed_amount', '')::numeric;
    approved := nullif(l->>'approved_amount', '')::numeric;
    pdate    := nullif(l->>'payment_date', '')::date;

    if clm_norm_ref(l->>'claim_ref') is null and clm_norm_ref(l->>'bill_no') is null
       and jsonb_array_length(coalesce(l->'bills', '[]'::jsonb)) = 0 then
      n_skip := n_skip + 1; continue;
    end if;

    -- the bill(s) this payment is for
    ids := '{}'; caps := '{}';
    if jsonb_array_length(coalesce(l->'bills', '[]'::jsonb)) > 0 then
      for b in select * from jsonb_array_elements(l->'bills') loop
        select o_id, o_created into rid, made from clm_upsert_bill(t, p_centre, batch,
          b || jsonb_build_object('claim_ref', l->>'claim_ref', 'payer_name', l->>'payer_name', 'part_of_case', true), src);
        if made then n_created := n_created + 1; end if;
        ids := ids || rid;
        caps := caps || coalesce(nullif(b->>'claimed_amount', '')::numeric, 0);
      end loop;
    else
      select o_id, o_created into rid, made from clm_upsert_bill(t, p_centre, batch, l, src);
      if made then n_created := n_created + 1; end if;
      ids := array[rid];
      -- PMJAY may pay above the claim: what PMJAY paid is what was owed
      if src = 'pmjay' and net > 0 then
        update clm_receivables set expected_amount = net + tds where id = rid and expected_amount < net + tds;
      end if;
      caps := array[null::numeric];
    end if;

    if net <= 0 then n_unpaid := n_unpaid + 1; continue; end if;

    -- the same payment uploaded again is ignored
    insert into clm_remittance_lines (tenant_id, centre_id, payer_id, payer_name, utr, advice_date, claim_ref, bill_no, patient_name,
                                      approved_amount, claimed_amount, tds_amount, deduction_amount, deduction_reason, net_amount,
                                      payment_date, source, file_name, receivable_id, import_batch_id)
    select t, p_centre, r.payer_id, coalesce(nullif(l->>'payer_name', ''), r.debtor_name), nullif(l->>'utr', ''), pdate,
           nullif(l->>'claim_ref', ''), nullif(l->>'bill_no', ''), nullif(l->>'patient_name', ''), approved, claimed,
           tds, ded, nullif(l->>'deduction_reason', ''), net, pdate, src, left(p_file, 300), r.id, batch
    from clm_receivables r where r.id = ids[1]
    on conflict do nothing returning id into rem;
    if rem is null then n_dup := n_dup + 1; continue; end if;

    rc := null;
    if nullif(l->>'utr', '') is not null then rc := clm_bank_receipt_for(t, p_centre, l->>'utr', net); end if;
    if rc is null then
      insert into clm_receipts (tenant_id, centre_id, source, bank_account, value_date, amount, reference, narration, payer_id, import_batch_id)
      select t, p_centre, 'advice', 'advice:' || rem, coalesce(pdate, current_date), net, nullif(l->>'utr', ''),
             case src when 'pmjay' then 'PMJAY settlement' else 'Settlement letter' end, r.payer_id, batch
      from clm_receivables r where r.id = ids[1]
      returning id into rc;
    end if;

    -- spread the case's payment (net + TDS) over its invoices in order, each up to
    -- what it claimed; anything left over goes on the last invoice
    gross := net + tds; left_gross := gross; left_net := net; n := array_length(ids, 1);
    -- PMJAY paid the case more than its invoices claimed: what PMJAY paid is what was owed
    if src = 'pmjay' and n > 1 and gross > (select sum(x) from unnest(caps) x) then
      update clm_receivables set expected_amount = expected_amount + (gross - (select sum(x) from unnest(caps) x)) where id = ids[n];
    end if;
    for i in 1 .. n loop
      part := case when i = n then left_gross else least(left_gross, greatest(caps[i], 0)) end;
      part_net := case when i = n then left_net else round(part * net / gross, 2) end;
      left_gross := left_gross - part; left_net := left_net - part_net;
      if part_net > 0 then
        insert into clm_allocations (tenant_id, receipt_id, receivable_id, amount, method, remittance_line_id)
        values (t, rc, ids[i], part_net, 'advice', rem);
      end if;
      if part - part_net > 0 then
        insert into clm_adjustments (tenant_id, receivable_id, kind, amount, reason_text, remittance_line_id)
        values (t, ids[i], 'tds', part - part_net, 'TDS as per settlement', rem);
      end if;
    end loop;

    -- a deduction only closes the gap when the letter says why; otherwise it stays on the mismatch list
    if ded > 0 and nullif(trim(l->>'deduction_reason'), '') is not null then
      insert into clm_adjustments (tenant_id, receivable_id, kind, amount, category, reason_text, remittance_line_id)
      values (t, ids[n], 'deduction', ded, clm_deduction_category(l->>'deduction_reason'), trim(l->>'deduction_reason'), rem);
    end if;
    n_matched := n_matched + 1;
  end loop;

  return jsonb_build_object('batch_id', batch, 'matched', n_matched, 'created', n_created, 'unpaid', n_unpaid,
                            'duplicate', n_dup, 'skipped', n_skip);
end $$;

revoke execute on function clm_upsert_bill(uuid, uuid, uuid, jsonb, text) from public, anon;
grant execute on function clm_upsert_bill(uuid, uuid, uuid, jsonb, text) to authenticated;
revoke execute on function clm_apply_payments(uuid, text, jsonb) from public, anon;
grant execute on function clm_apply_payments(uuid, text, jsonb) to authenticated;
