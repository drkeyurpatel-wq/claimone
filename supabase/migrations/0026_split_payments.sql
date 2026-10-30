-- ════════════════════════════════════════════════════════════════════
-- 0026 · Payments in parts (split payments — common with PMJAY)
--
-- A payer may pay one patient's claim in several transfers. Until now the
-- first part could be read as the whole payment:
--   1. A letter with no approved amount approved the claim at what that one
--      transfer paid (net + TDS), so the rest looked like a deduction.
--      Now: the letter's approved amount, else claimed − the letter's
--      deduction, and only when the claim amount is unknown, what was paid.
--   2. A PMJAY case with several invoices spread each transfer over the
--      invoices by what each CLAIMED, so a second transfer piled onto the
--      first invoice again. Now each transfer fills what each invoice is
--      still owed.
--   3. Master shows how many parts came in (clm_v_case_banked.parts); a
--      short balance waits as "balance awaited" for 30 days after the last
--      part before it is put up as a deduction to accept or dispute
--      (src/lib/rcm/cut.ts — the database never closes a file with a balance).
-- ════════════════════════════════════════════════════════════════════

create or replace function clm_approve_from_letter(p_claim uuid, l jsonb) returns boolean
language plpgsql security invoker set search_path = public as $$
declare
  c clm_claims%rowtype; ok boolean := false;
  net numeric := coalesce(nullif(l->>'net_amount', '')::numeric, 0);
  tds numeric := coalesce(nullif(l->>'tds_amount', '')::numeric, 0);
  ded numeric := coalesce(nullif(l->>'deduction_amount', '')::numeric, 0);
  l_claimed numeric := nullif(l->>'claimed_amount', '')::numeric;
  v_appr numeric; v_claimed numeric; k_claimed numeric;
begin
  select * into c from clm_claims where id = p_claim for update;
  if not found or c.status not in ('draft','preauth_approved','preauth_enhanced','claim_query','claim_rejected',
                                   'claim_submitted','claim_under_review') then
    return false;
  end if;
  -- one transfer may be only part of the payment: what was paid is the approval only when nothing else says
  k_claimed := coalesce(c.claimed_amount, l_claimed);
  v_appr := coalesce(nullif(l->>'approved_amount', '')::numeric,
                     case when k_claimed is not null and k_claimed - ded > 0 then k_claimed - ded end,
                     case when net + tds > 0 then net + tds end);
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
    ok := false;
  end;
  perform set_config('claimone.source', '', true);
  perform set_config('claimone.note', '', true);
  return ok;
end $$;

create or replace function clm_apply_payments(p_centre uuid, p_file text, p_lines jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  t uuid := clm_current_tenant();
  l jsonb; b jsonb;
  batch uuid; rem uuid; rc uuid; rid uuid; made boolean; bank uuid;
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
        -- what this invoice still waits for: a later part of the payment fills what the first part left
        caps := caps || greatest(coalesce((select v.balance from clm_v_receivable_balance v where v.id = rid), 0), 0);
      end loop;
    else
      select o_id, o_created into rid, made from clm_upsert_bill(t, p_centre, batch, l, src);
      if made then n_created := n_created + 1; end if;
      ids := array[rid];
      caps := array[greatest(coalesce((select v.balance from clm_v_receivable_balance v where v.id = rid), 0), 0)];
    end if;

    if net <= 0 then n_unpaid := n_unpaid + 1; continue; end if;

    -- the same payment uploaded again (from any file) is ignored
    insert into clm_remittance_lines (tenant_id, centre_id, payer_id, payer_name, utr, advice_date, claim_ref, bill_no, patient_name,
                                      approved_amount, claimed_amount, tds_amount, deduction_amount, deduction_reason, net_amount,
                                      payment_date, source, file_name, receivable_id, import_batch_id)
    select t, p_centre, r.payer_id, coalesce(nullif(l->>'payer_name', ''), r.debtor_name), nullif(l->>'utr', ''), pdate,
           nullif(l->>'claim_ref', ''), nullif(l->>'bill_no', ''), nullif(l->>'patient_name', ''), approved, claimed,
           tds, ded, nullif(l->>'deduction_reason', ''), net, pdate, src, left(p_file, 300), r.id, batch
    -- keyed on the case's oldest invoice, so a case that gains an invoice next week is still the same payment
    from clm_receivables r where r.id = (select x.id from clm_receivables x where x.id = any(ids) order by x.created_at, x.id limit 1)
    on conflict do nothing returning id into rem;
    if rem is null then n_dup := n_dup + 1; continue; end if;

    -- money: the bank credit with this UTR if it has room, else a letter receipt
    -- (tied to the bank credit when one exists, so the cash is counted once)
    rc := null; bank := null;
    if nullif(l->>'utr', '') is not null then
      rc := clm_bank_receipt_for(t, p_centre, l->>'utr', net);
      if rc is null then bank := clm_bank_credit_any(t, p_centre, l->>'utr'); end if;
    end if;
    if rc is null then
      insert into clm_receipts (tenant_id, centre_id, source, bank_account, value_date, amount, reference, narration, payer_id,
                                import_batch_id, bank_receipt_id, bank_confirmed_on)
      select t, p_centre, 'advice', 'advice:' || rem, coalesce(pdate, current_date), net, nullif(l->>'utr', ''),
             case src when 'pmjay' then 'PMJAY settlement' else 'Settlement letter' end, r.payer_id, batch,
             bank, (select value_date from clm_receipts where id = bank)
      from clm_receivables r where r.id = ids[1]
      returning id into rc;
    end if;

    -- PMJAY paid the case more than it claimed: what PMJAY paid is what was owed
    gross := net + tds; left_gross := gross; left_net := net; n := array_length(ids, 1);
    -- (against what the case still waits for, so a second part is not taken as an over-payment)
    if src = 'pmjay' and gross > (select coalesce(sum(x), 0) from unnest(caps) x) + 1 then
      update clm_receivables set expected_amount = expected_amount + (gross - (select coalesce(sum(x), 0) from unnest(caps) x))
      where id = ids[n];
    end if;

    -- spread the payment (net + TDS) over the invoices in order, each up to what it
    -- is still owed; anything left over goes on the last invoice
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


-- how many payments (transfers) make up what a case has received
create or replace view clm_v_case_banked with (security_invoker = true) as
select r.claim_id, r.centre_id,
       coalesce(sum(a.amount) filter (where rc.source = 'bank' or rc.bank_receipt_id is not null), 0) as banked,
       coalesce(sum(a.amount), 0) as received,
       count(distinct a.receipt_id)::int as parts,
       max(rc.value_date) as last_paid
from clm_allocations a
join clm_receivables r on r.id = a.receivable_id
join clm_receipts rc on rc.id = a.receipt_id
where a.reversed_at is null and r.claim_id is not null and r.debtor_type <> 'patient'
group by r.claim_id, r.centre_id;
grant select on clm_v_case_banked to authenticated;
