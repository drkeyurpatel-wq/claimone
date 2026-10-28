-- ════════════════════════════════════════════════════════════════════
-- Fixes from the weekly-payments review
--  1. Bills are found by their own bill no before the claim / case ID.
--  2. "Already uploaded" is decided per bill + UTR + amount, so the same
--     payment read from a PDF and later from the TPA's Excel (claim no
--     written differently, bill no missing) is not counted twice.
--  3. A bank credit and the settlement letter for the same money are
--     linked by UTR, whichever arrives first, so cash is not counted twice.
--  4. Payer from a letter: whole-name match, not the first word ("Health"
--     put every "… Health TPA" on Health India TPA).
--  5. PMJAY bills go to the scheme of the centre's state.
-- ════════════════════════════════════════════════════════════════════

-- 5 ── centre state
alter table clm_centres add column if not exists state text not null default 'Gujarat';

-- 1 ── bill no first
create or replace function clm_find_receivable(p_tenant uuid, p_centre uuid, p_claim text, p_bill text) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select id from clm_receivables
      where p_bill is not null and tenant_id = p_tenant and centre_id = p_centre and clm_norm_ref(bill_no) = p_bill
        and debtor_type not in ('patient','referrer') order by created_at limit 1),
    (select id from clm_receivables
      where p_claim is not null and tenant_id = p_tenant and centre_id = p_centre and clm_norm_ref(claim_ref) = p_claim
        and debtor_type not in ('patient','referrer') order by created_at limit 1))
  where p_tenant = clm_current_tenant() and clm_can_access_centre(p_centre)
$$;

-- 2 ── one payment per bill + UTR + amount
drop index if exists clm_remittance_dedupe;
create unique index clm_remittance_dedupe on clm_remittance_lines
  (tenant_id, centre_id, receivable_id, upper(coalesce(utr, '')), net_amount);

-- 3 ── letter ↔ bank credit
alter table clm_receipts add column if not exists bank_receipt_id uuid references clm_receipts(id);
comment on column clm_receipts.bank_receipt_id is 'On a letter (advice) receipt: the bank credit that carried this money';

-- When a bank credit arrives, letters already booked with the same UTR are tied to it.
create or replace function clm_link_bank_credit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.source = 'bank' and nullif(new.reference, '') is not null then
    update clm_receipts set bank_receipt_id = new.id, bank_confirmed_on = new.value_date
    where tenant_id = new.tenant_id and centre_id = new.centre_id and source = 'advice'
      and bank_receipt_id is null and upper(reference) = upper(new.reference);
  end if;
  return null;
end $$;
drop trigger if exists clm_receipts_link_bank on clm_receipts;
create trigger clm_receipts_link_bank after insert on clm_receipts for each row execute function clm_link_bank_credit();

-- A bank credit's money is "used" by its own matches plus the letters tied to it.
drop view if exists clm_v_receipt_balance;
create view clm_v_receipt_balance with (security_invoker = true) as
select rc.*,
       coalesce(al.used, 0) + coalesce(adv.covered, 0) as allocated,
       round(rc.amount - coalesce(al.used, 0) - coalesce(adv.covered, 0), 2) as unallocated
from clm_receipts rc
left join lateral (select sum(a.amount) as used from clm_allocations a where a.receipt_id = rc.id and a.reversed_at is null) al on true
left join lateral (select sum(x.amount) as covered from clm_receipts x where x.bank_receipt_id = rc.id) adv on true;
grant select on clm_v_receipt_balance to authenticated;

-- bank credit by UTR with room left (letters tied to it count as used)
create or replace function clm_bank_receipt_for(p_tenant uuid, p_centre uuid, p_utr text, p_net numeric) returns uuid
language sql stable security definer set search_path = public as $$
  select rc.id from clm_receipts rc
  where rc.tenant_id = p_tenant and rc.centre_id = p_centre and rc.source = 'bank'
    and upper(rc.reference) = upper(p_utr)
    and p_tenant = clm_current_tenant() and clm_can_access_centre(p_centre)
    and rc.amount
        - coalesce((select sum(a.amount) from clm_allocations a where a.receipt_id = rc.id and a.reversed_at is null), 0)
        - coalesce((select sum(x.amount) from clm_receipts x where x.bank_receipt_id = rc.id), 0) >= p_net - 0.5
  order by rc.value_date limit 1
$$;

-- any bank credit with that UTR (used when its room is used up: the letter is tied to it and the gap shows)
create or replace function clm_bank_credit_any(p_tenant uuid, p_centre uuid, p_utr text) returns uuid
language sql stable security definer set search_path = public as $$
  select rc.id from clm_receipts rc
  where rc.tenant_id = p_tenant and rc.centre_id = p_centre and rc.source = 'bank' and upper(rc.reference) = upper(p_utr)
    and p_tenant = clm_current_tenant() and clm_can_access_centre(p_centre)
  order by rc.value_date limit 1
$$;

-- 4 ── payer from the names on a letter
-- Each payer name is reduced to its distinctive words; a payer matches when at
-- least 60% of them (and at least one) appear as whole words. Best share wins,
-- then more words, then insurer over TPA, then name — always the same answer.
create or replace function clm_match_payer(p_payer text, p_tpa text, p_tenant uuid) returns uuid
language sql stable set search_path = public as $$
  with src(txt, pref) as (values (p_payer, 1), (p_tpa, 2)),
  words as (
    select p.id, p.name, p.type, w
    from clm_payers p, regexp_split_to_table(upper(regexp_replace(p.name, '[^A-Za-z0-9]+', ' ', 'g')), ' ') w
    where (p.tenant_id is null or p.tenant_id = p_tenant) and p.is_active
      and w <> '' and w not in ('THE','TPA','LTD','PVT','CO','LIMITED','COMPANY','INSURANCE','GENERAL','AND','OF','SERVICES','ASSURANCE','M','S')
  ),
  scored as (
    select s.pref, w.id, w.name, w.type, count(*) as total,
           count(*) filter (where ' ' || upper(regexp_replace(coalesce(s.txt, ''), '[^A-Za-z0-9]+', ' ', 'g')) || ' ' like '% ' || w.w || ' %') as hit
    from src s cross join words w
    where nullif(trim(coalesce(s.txt, '')), '') is not null
    group by s.pref, w.id, w.name, w.type
  )
  select id from scored
  where hit >= 1 and hit::numeric / total >= 0.6
  order by pref, hit::numeric / total desc, hit desc, (type in ('insurer','psu','government')) desc, name
  limit 1
$$;

-- 5 ── PMJAY scheme by state; billed amount kept
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
  end if;

  if o_id is not null then
    update clm_receivables set
      claim_ref = coalesce(claim_ref, nullif(l->>'claim_ref', '')),
      uhid = coalesce(uhid, nullif(l->>'uhid', '')),
      billed_amount = coalesce(billed_amount, claimed)
    where id = o_id;
    return;
  end if;

  owed := coalesce(claimed, approved, net + tds + ded);
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

-- apply: PMJAY over-payment rule for single-invoice cases too; tie letters to a bank credit by UTR
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
        caps := caps || coalesce(nullif(b->>'claimed_amount', '')::numeric, 0);
      end loop;
    else
      select o_id, o_created into rid, made from clm_upsert_bill(t, p_centre, batch, l, src);
      if made then n_created := n_created + 1; end if;
      ids := array[rid];
      caps := array[coalesce(claimed, approved, 0)];
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
    if src = 'pmjay' and gross > (select coalesce(sum(x), 0) from unnest(caps) x) then
      update clm_receivables set expected_amount = expected_amount + (gross - (select coalesce(sum(x), 0) from unnest(caps) x))
      where id = ids[n] and expected_amount < gross;
    end if;

    -- spread the payment (net + TDS) over the invoices in order, each up to what it
    -- claimed; anything left over goes on the last invoice
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

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'clm\_%' loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;
