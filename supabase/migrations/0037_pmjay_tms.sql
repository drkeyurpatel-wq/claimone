-- ════════════════════════════════════════════════════════════════════
-- 1. The PMJAY "claim paid" sheet downloaded from TMS, uploaded every week.
--    One row per case ID, and every row is a final payment: what PMJAY
--    approved is all that will come. So a case on that sheet is closed in
--    full: payment, TDS, the deduction (claimed − approved), and nothing
--    left showing as owed.
-- 2. A reason on every deduction (list or free text), required on files
--    from the day set on the tenant (1 Nov 2026).
-- 3. Deductions line by line, for MIS by reason, procedure, consultant,
--    speciality and centre.
-- ════════════════════════════════════════════════════════════════════

alter table clm_receivables add column if not exists speciality text;
alter table clm_receivables add column if not exists procedure_code text;
alter table clm_receivables add column if not exists procedure_name text;

alter table clm_claims add column if not exists cut_category text;
alter table clm_tenants add column if not exists reason_from date;
update clm_tenants set reason_from = date '2026-11-01' where reason_from is null;

-- ─── Deduction reasons: the common ones, plus "Reason not entered" ────
alter table clm_disallowances drop constraint if exists clm_disallowances_category_check;
alter table clm_disallowances add constraint clm_disallowances_category_check check (category in (
  'room_rent_cap','non_payable','doc_missing','tariff_excess','query_tat','pre_existing','policy_exclusion','co_pay','other',
  'multi_procedure','implant_proof','late_submission','package_mismatch','unspecified'));

create or replace function clm_is_preventable(p_category text) returns boolean
language sql immutable set search_path = public as $$
  select coalesce(p_category in ('room_rent_cap','non_payable','doc_missing','tariff_excess','query_tat',
                                 'implant_proof','late_submission','package_mismatch'), false)
$$;

create or replace function clm_reason_ok(p_category text) returns boolean
language sql immutable set search_path = public as $$
  select coalesce(p_category in ('room_rent_cap','non_payable','doc_missing','tariff_excess','query_tat','pre_existing',
                                 'policy_exclusion','co_pay','other','multi_procedure','implant_proof','late_submission',
                                 'package_mismatch'), false)
$$;

-- Every government bill of one PMJAY case (a case can have several invoices), oldest first; null when there is none.
-- p_alt: the same case ID as an old sheet stored it (last digit lost). Runs as definer so the case-ID index is used;
-- it answers only for the caller's own tenant and centre (same guard as clm_find_receivable).
create or replace function clm_case_bills(p_tenant uuid, p_centre uuid, p_case text, p_alt text) returns uuid[]
language sql stable security definer set search_path = public as $$
  select array_agg(q.id order by q.created_at, q.id) from (
    select r.id, r.created_at from clm_receivables r
    where r.tenant_id = p_tenant and r.centre_id = p_centre and clm_norm_ref(r.claim_ref) = p_case and r.debtor_type = 'government'
    union
    select r.id, r.created_at from clm_receivables r
    where p_alt is not null and r.tenant_id = p_tenant and r.centre_id = p_centre and clm_norm_ref(r.claim_ref) = p_alt and r.debtor_type = 'government'
  ) q
  where p_tenant = clm_current_tenant() and clm_can_access_centre(p_centre)
$$;

-- ─── The TMS sheet ───────────────────────────────────────────────────
-- p_lines: [{claim_ref (case ID), patient_name, bill_date (pre-auth date), claimed_amount, approved_amount,
--            tds_amount, net_amount, utr, payment_date, deduction_reason?, speciality?, procedure_code?,
--            procedure_name?, unique15 (no other case on the sheet shares its first 15 digits)}]
create or replace function clm_apply_pmjay_tms(p_centre uuid, p_file text, p_lines jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  t uuid := clm_current_tenant();
  l jsonb; batch uuid; k text; k15 text; ids uuid[]; rid uuid; rem uuid; rc uuid; bank uuid; cid uuid; x record;
  net numeric; tds numeric; claimed numeric; approved numeric; ded numeric; pdate date; utr text;
  v_alloc numeric; v_tds numeric; v_ded numeric;
  part numeric; tds_part numeric; gross numeric; left_gross numeric; left_net numeric; g numeric; g_net numeric; cap numeric; i int; n int;
  n_paid int := 0; n_known int := 0; n_created int := 0; n_fixed int := 0; n_disputed int := 0; n_skip int := 0;
begin
  if t is null or not clm_can_write() then raise exception 'Read-only access' using errcode = 'insufficient_privilege'; end if;
  if not clm_can_access_centre(p_centre) or not exists (select 1 from clm_centres where id = p_centre and tenant_id = t) then
    raise exception 'No access to this centre' using errcode = 'insufficient_privilege';
  end if;

  perform set_config('claimone.upload', '1', true);
  insert into clm_import_batches (tenant_id, centre_id, kind, file_name, row_count)
  values (t, p_centre, 'weekly_payments', left(coalesce(p_file, 'upload'), 300), jsonb_array_length(p_lines)) returning id into batch;

  for l in select * from jsonb_array_elements(p_lines) loop
    k        := clm_norm_ref(l->>'claim_ref');
    net      := coalesce(nullif(l->>'net_amount', '')::numeric, 0);
    tds      := coalesce(nullif(l->>'tds_amount', '')::numeric, 0);
    approved := coalesce(nullif(l->>'approved_amount', '')::numeric, net + tds);
    claimed  := greatest(coalesce(nullif(l->>'claimed_amount', '')::numeric, approved), approved);
    pdate    := nullif(l->>'payment_date', '')::date;
    utr      := nullif(btrim(l->>'utr'), '');
    if k is null or net <= 0 then n_skip := n_skip + 1; continue; end if;

    -- every bill of this case (a case can have several invoices)
    -- the old Excel sheet kept 16-digit case IDs as numbers and lost the last digit (stored as …0)
    k15 := case when length(k) = 16 and coalesce((l->>'unique15')::boolean, false) and right(k, 1) <> '0' then left(k, 15) || '0' end;
    ids := clm_case_bills(t, p_centre, k, k15);
    if ids is not null and exists (select 1 from clm_receivables r where r.id = any(ids) and clm_norm_ref(r.claim_ref) <> k) then
      update clm_claims c set tpa_claim_number = l->>'claim_ref'
      where c.id in (select r.claim_id from clm_receivables r where r.id = any(ids) and r.claim_id is not null)
        and clm_norm_ref(c.tpa_claim_number) = k15
        and not exists (select 1 from clm_claims o where o.tenant_id = t and o.id <> c.id and clm_norm_ref(o.tpa_claim_number) = k);
      update clm_receivables set claim_ref = l->>'claim_ref' where id = any(ids) and clm_norm_ref(claim_ref) <> k;
      n_fixed := n_fixed + 1;
    end if;

    if ids is null then
      -- a patient on Master whose bill is not on the book yet: the sheet is the claim decision, which puts it there.
      -- Only the case ID decides — never the patient's name (the same patient has many cases).
      rid := null;
      select c.id into cid from clm_claims c
      where c.tenant_id = t and c.centre_id = p_centre and c.status not in ('settled','closed','written_off')
        and (clm_norm_ref(c.tpa_claim_number) = k or clm_norm_ref(c.tpa_claim_number) = k15)
      order by c.created_at limit 1;
      if cid is not null then
        if clm_norm_ref((select tpa_claim_number from clm_claims where id = cid)) <> k then
          update clm_claims set tpa_claim_number = l->>'claim_ref' where id = cid; n_fixed := n_fixed + 1;
        end if;
        perform clm_approve_from_letter(cid, l);
        select r.id into rid from clm_receivables r where r.claim_id = cid and r.debtor_type not in ('patient','referrer') order by r.created_at limit 1;
      end if;
      if rid is null then
        select o_id into rid from clm_upsert_bill(t, p_centre, batch, l || jsonb_build_object('part_of_case', true), 'pmjay');
        n_created := n_created + 1;
      end if;
      ids := array[rid];
    end if;
    n := array_length(ids, 1);

    update clm_receivables set
      speciality = coalesce(nullif(l->>'speciality', ''), speciality),
      procedure_code = coalesce(nullif(l->>'procedure_code', ''), procedure_code),
      procedure_name = coalesce(nullif(left(l->>'procedure_name', 300), ''), procedure_name),
      patient_name = coalesce(patient_name, nullif(l->>'patient_name', ''))
    where id = any(ids);

    -- a deduction someone is disputing stays exactly as it is
    if exists (select 1 from clm_receivables r left join clm_claims c on c.id = r.claim_id
               where r.id = any(ids) and (r.status = 'disputed' or c.cut_decision = 'fought')) then
      n_disputed := n_disputed + 1; continue;
    end if;

    -- the claim decision, for a patient on Master
    for x in select r.claim_id from clm_receivables r where r.id = any(ids) and r.claim_id is not null loop
      perform clm_approve_from_letter(x.claim_id, l);
    end loop;

    select coalesce(sum(a.amount), 0) into v_alloc from clm_allocations a where a.receivable_id = any(ids) and a.reversed_at is null;
    select coalesce(sum(a.amount) filter (where a.kind = 'tds'), 0), coalesce(sum(a.amount) filter (where a.kind = 'deduction'), 0)
      into v_tds, v_ded from clm_adjustments a where a.receivable_id = any(ids) and a.reversed_at is null;

    -- money not yet on the case (an earlier upload or a typed payment may already hold it)
    part := round(net - v_alloc, 2);
    tds_part := greatest(round(tds - v_tds, 2), 0);
    rem := null;
    if part > 1 then
      insert into clm_remittance_lines (tenant_id, centre_id, payer_id, payer_name, utr, advice_date, claim_ref, patient_name,
                                        approved_amount, claimed_amount, tds_amount, deduction_amount, deduction_reason, net_amount,
                                        payment_date, source, file_name, receivable_id, import_batch_id)
      select t, p_centre, r.payer_id, r.debtor_name, utr, pdate, l->>'claim_ref', nullif(l->>'patient_name', ''), approved, claimed,
             tds_part, greatest(claimed - approved, 0), nullif(l->>'deduction_reason', ''), part, pdate, 'pmjay', left(p_file, 300), r.id, batch
      from clm_receivables r where r.id = ids[1]
      on conflict do nothing returning id into rem;
    end if;

    if rem is not null then
      rc := null; bank := null;
      if utr is not null then
        rc := clm_bank_receipt_for(t, p_centre, utr, part);
        if rc is null then bank := clm_bank_credit_any(t, p_centre, utr); end if;
      end if;
      if rc is null then
        insert into clm_receipts (tenant_id, centre_id, source, bank_account, value_date, amount, reference, narration, payer_id,
                                  import_batch_id, bank_receipt_id, bank_confirmed_on)
        select t, p_centre, 'advice', 'advice:' || rem, coalesce(pdate, current_date), part, utr, 'PMJAY settlement', r.payer_id, batch,
               bank, (select value_date from clm_receipts where id = bank)
        from clm_receivables r where r.id = ids[1]
        returning id into rc;
      end if;
      -- spread (net + TDS) over the case's invoices in order, each up to what it still waits for; the rest on the last
      gross := part + tds_part; left_gross := gross; left_net := part;
      for i in 1 .. n loop
        select greatest(coalesce(v.balance, 0), 0) into cap from clm_v_receivable_balance v where v.id = ids[i];
        g := case when i = n then left_gross else least(left_gross, cap) end;
        g_net := case when i = n then left_net else round(g * part / gross, 2) end;
        left_gross := left_gross - g; left_net := left_net - g_net;
        if g_net > 0 then
          insert into clm_allocations (tenant_id, receipt_id, receivable_id, amount, method, remittance_line_id)
          values (t, rc, ids[i], g_net, 'advice', rem);
        end if;
        if g - g_net > 0 then
          insert into clm_adjustments (tenant_id, receivable_id, kind, amount, reason_text, remittance_line_id)
          values (t, ids[i], 'tds', g - g_net, 'TDS as per PMJAY payment sheet', rem);
        end if;
      end loop;
      n_paid := n_paid + 1;
    else
      if tds_part > 1 and v_alloc > 0 then
        insert into clm_adjustments (tenant_id, receivable_id, kind, amount, reason_text)
        values (t, ids[n], 'tds', tds_part, 'TDS as per PMJAY payment sheet');
      end if;
      n_known := n_known + 1;
    end if;

    -- the deduction PMJAY made: claimed − approved
    -- (on Master the claim itself carries it: claimed − approved, waiting for accept / dispute and its reason)
    ded := round(claimed - approved - v_ded, 2);
    if ded > 1 and not exists (select 1 from clm_receivables r where r.id = any(ids) and r.claim_id is not null) then
      insert into clm_adjustments (tenant_id, receivable_id, kind, amount, category, reason_text, remittance_line_id)
      values (t, ids[n], 'deduction', ded, 'unspecified',
              coalesce(nullif(btrim(l->>'deduction_reason'), ''), 'Approved less than claimed (PMJAY payment sheet)'), rem);
    end if;

    -- the sheet is final. What a bill still shows as owed is not coming: on Master it is a deduction to explain;
    -- on an old-sheet bill the amount owed was simply recorded differently.
    for x in select v.id, v.balance, v.claim_id, v.allocated from clm_v_receivable_balance v where v.id = any(ids) and abs(v.balance) > 1 loop
      if x.balance > 1 and x.claim_id is not null and x.allocated > 0 then
        insert into clm_adjustments (tenant_id, receivable_id, kind, amount, category, reason_text, remittance_line_id)
        values (t, x.id, 'deduction', x.balance, 'unspecified', 'Paid less than the amount on Master (PMJAY payment sheet)', rem);
      else
        update clm_receivables set expected_amount = expected_amount - x.balance where id = x.id;
      end if;
    end loop;

    for x in select r.id from clm_receivables r where r.id = any(ids) and r.claim_id is not null loop
      perform clm_settle_from_receivable(x.id);
    end loop;
  end loop;

  perform set_config('claimone.upload', '', true);
  return jsonb_build_object('batch_id', batch, 'matched', n_paid, 'created', n_created, 'unpaid', 0, 'duplicate', n_known,
                            'skipped', n_skip, 'fixed', n_fixed, 'disputed', n_disputed);
end $$;

-- ─── A reason on every deduction ─────────────────────────────────────
-- Accept or dispute now carries the reason: one from the list, or "other" with the reason written.
create or replace function clm_decide_cut(p_claim uuid, p_decision text, p_note text default null, p_category text default null)
returns text
language plpgsql security definer set search_path = public as $$
declare
  c clm_claims%rowtype; r clm_receivables%rowtype; v_bal numeric; v_alloc numeric; v_cat text; v_from date; v_file date; x record;
begin
  select * into c from clm_claims where id = p_claim for update;
  if not found or c.tenant_id <> clm_current_tenant() or not clm_can_access_centre(c.centre_id) then
    raise exception 'Unknown claim' using errcode = 'foreign_key_violation';
  end if;
  if not clm_can_write() then raise exception 'Not allowed' using errcode = 'insufficient_privilege'; end if;
  if c.status in ('closed','written_off') then raise exception 'This file is closed' using errcode = 'check_violation'; end if;
  if p_decision not in ('accept','fight') then raise exception 'Choose accept or fight' using errcode = 'check_violation'; end if;
  if p_decision = 'fight' and coalesce(btrim(p_note), '') = '' then
    raise exception 'Write why the cut is wrong' using errcode = 'check_violation';
  end if;
  if p_category is not null and not clm_reason_ok(p_category) then
    raise exception 'Choose the deduction reason from the list' using errcode = 'check_violation';
  end if;
  select reason_from into v_from from clm_tenants where id = c.tenant_id;
  v_file := coalesce(c.discharge_date, (c.discharged_at at time zone 'Asia/Kolkata')::date, current_date);
  if v_from is not null and v_file >= v_from then
    if p_category is null then raise exception 'Choose the deduction reason' using errcode = 'check_violation'; end if;
    if p_category = 'other' and coalesce(btrim(p_note), '') = '' then
      raise exception 'Write the deduction reason' using errcode = 'check_violation';
    end if;
  end if;

  select * into r from clm_receivables where claim_id = c.id and debtor_type <> 'patient';

  update clm_claims set cut_decision = case p_decision when 'fight' then 'fought' else 'accepted' end,
         cut_note = nullif(btrim(p_note), ''), cut_decided_at = now(), cut_decided_by = auth.uid(),
         cut_category = coalesce(p_category, cut_category)
  where id = c.id;

  if r.id is null then return p_decision; end if;

  if p_decision = 'fight' then
    update clm_adjustments set reversed_at = now() where receivable_id = r.id and kind = 'deduction' and reversed_at is null;
    update clm_receivables set
      expected_amount = greatest(coalesce(c.claimed_amount, r.billed_amount, r.expected_amount), r.expected_amount),
      status = 'disputed', notes = left('Fighting the cut: ' || btrim(p_note), 500)
    where id = r.id;
    return 'fought';
  end if;

  -- accept
  if p_category is not null then
    -- booked deductions cannot be edited: each one without a reason is reversed and booked again with it
    for x in select a.id, a.amount, a.reason_text, a.remittance_line_id from clm_adjustments a
             where a.receivable_id = r.id and a.kind = 'deduction' and a.reversed_at is null and a.category in ('unspecified','other') loop
      update clm_adjustments set reversed_at = now() where id = x.id;
      insert into clm_adjustments (tenant_id, receivable_id, kind, amount, category, reason_text, remittance_line_id)
      values (r.tenant_id, r.id, 'deduction', x.amount, p_category, coalesce(nullif(btrim(p_note), ''), x.reason_text, 'Cut accepted'), x.remittance_line_id);
    end loop;
  end if;
  update clm_receivables set
    expected_amount = coalesce(c.approved_amount, r.expected_amount),
    status = case when r.status = 'disputed' then 'open' else r.status end
  where id = r.id;
  select coalesce(sum(amount), 0) into v_alloc from clm_allocations where receivable_id = r.id and reversed_at is null;
  select round(r2.expected_amount - v_alloc
               - coalesce((select sum(amount) from clm_adjustments where receivable_id = r.id and reversed_at is null), 0), 2)
    into v_bal from clm_receivables r2 where r2.id = r.id;
  if v_alloc > 0 and v_bal > 1 then
    select coalesce(p_category,
                    (select category from clm_adjustments where receivable_id = r.id and kind = 'deduction'
                     order by created_at desc limit 1), 'other') into v_cat;
    -- inserting fires the settle trigger
    insert into clm_adjustments (tenant_id, receivable_id, kind, amount, category, reason_text)
    values (r.tenant_id, r.id, 'deduction', v_bal, v_cat, coalesce(nullif(btrim(p_note), ''), 'Cut accepted'));
  else
    perform clm_settle_from_receivable(r.id);
  end if;
  return 'accepted';
end $$;

-- A reason entered later on a deduction that came without one (small cuts close on their own; sheet rows carry none).
-- Give the booked deduction (p_adjustment) or, for a cut at approval, the patient's file (p_claim).
create or replace function clm_set_deduction_reason(p_adjustment uuid, p_claim uuid, p_category text, p_text text default null) returns void
language plpgsql security definer set search_path = public as $$
declare a clm_adjustments%rowtype; r clm_receivables%rowtype; c clm_claims%rowtype;
begin
  if not clm_can_write() then raise exception 'Not allowed' using errcode = 'insufficient_privilege'; end if;
  if not clm_reason_ok(p_category) then raise exception 'Choose the deduction reason from the list' using errcode = 'check_violation'; end if;
  if p_category = 'other' and coalesce(btrim(p_text), '') = '' then
    raise exception 'Write the deduction reason' using errcode = 'check_violation';
  end if;
  if p_adjustment is not null then
    select * into a from clm_adjustments where id = p_adjustment for update;
    if found then select * into r from clm_receivables where id = a.receivable_id; end if;
    if a.id is null or r.id is null or r.tenant_id <> clm_current_tenant() or not clm_can_access_centre(r.centre_id) or a.kind <> 'deduction' then
      raise exception 'Unknown deduction' using errcode = 'foreign_key_violation';
    end if;
    if a.reversed_at is not null then raise exception 'Unknown deduction' using errcode = 'foreign_key_violation'; end if;
    -- a booked deduction cannot be edited: it is reversed and booked again with the reason
    update clm_adjustments set reversed_at = now() where id = a.id;
    insert into clm_adjustments (tenant_id, receivable_id, kind, amount, category, reason_text, remittance_line_id)
    values (a.tenant_id, a.receivable_id, 'deduction', a.amount, p_category,
            coalesce(nullif(btrim(left(p_text, 500)), ''), a.reason_text, 'Reason entered'), a.remittance_line_id);
    p_claim := r.claim_id;
  end if;
  if p_claim is not null then
    select * into c from clm_claims where id = p_claim for update;
    if not found or c.tenant_id <> clm_current_tenant() or not clm_can_access_centre(c.centre_id) then
      raise exception 'Unknown deduction' using errcode = 'foreign_key_violation';
    end if;
    perform set_config('claimone.note', 'Deduction reason entered', true);
    update clm_claims set cut_category = p_category, cut_note = coalesce(nullif(btrim(left(p_text, 500)), ''), cut_note) where id = c.id;
    perform set_config('claimone.note', '', true);
  elsif p_adjustment is null then
    raise exception 'Unknown deduction' using errcode = 'foreign_key_violation';
  end if;
end $$;

-- ─── Deductions line by line (the same four sources as clm_v_leakage) ─
drop view if exists clm_v_deduction_lines;
create view clm_v_deduction_lines with (security_invoker = true) as
with itemised as (
  select d.tenant_id, c.centre_id, c.payer_id, c.id as claim_id, null::uuid as receivable_id, null::uuid as adjustment_id,
         d.kind, d.category, d.reason_text, d.recorded_at as at, d.amount
  from clm_disallowances d join clm_claims c on c.id = d.claim_id
  where c.cut_decision is distinct from 'fought'
),
approval_cut as (
  select c.tenant_id, c.centre_id, c.payer_id, c.id, null::uuid, null::uuid, 'deduction'::text,
         case when c.cut_category is not null then c.cut_category
              when coalesce(btrim(split_part(t.notes, ' — ', 1)), '') = '' or t.notes ilike 'Claim decision taken from%' then 'unspecified'
              else clm_deduction_category(split_part(t.notes, ' — ', 1)) end,
         case when t.notes ilike 'Claim decision taken from%' then c.cut_note else coalesce(c.cut_note, split_part(t.notes, ' — ', 1)) end,
         coalesce(t.created_at, c.updated_at), c.claimed_amount - c.approved_amount
  from clm_claims c
  left join lateral (
    select notes, created_at from clm_state_transitions s
    where s.claim_id = c.id and s.to_status = 'claim_partial' order by created_at desc limit 1
  ) t on true
  where c.status in ('claim_partial','settlement_pending','settled','closed')
    and c.claimed_amount > c.approved_amount
    and (c.status = 'claim_partial' or t.created_at is not null)
    and c.cut_decision is distinct from 'fought'
    and not exists (select 1 from clm_disallowances d where d.claim_id = c.id)
),
short_paid as (
  select r.tenant_id, r.centre_id, coalesce(c.payer_id, r.payer_id), r.claim_id, r.id, a.id, 'deduction'::text,
         coalesce(a.category, 'other'), a.reason_text, a.created_at, a.amount
  from clm_adjustments a
  join clm_receivables r on r.id = a.receivable_id
  left join clm_claims c on c.id = r.claim_id
  where a.kind = 'deduction' and a.reversed_at is null
    and (r.claim_id is null or not exists (select 1 from clm_disallowances d where d.claim_id = r.claim_id))
),
fighting as (
  select c.tenant_id, c.centre_id, c.payer_id, c.id, b.id, null::uuid, 'fighting'::text,
         coalesce(c.cut_category, (select a.category from clm_adjustments a where a.receivable_id = b.id and a.kind = 'deduction'
                                   order by a.created_at desc limit 1), 'other'),
         c.cut_note, c.cut_decided_at,
         case when b.allocated > 0 then b.balance else coalesce(c.claimed_amount, 0) - coalesce(c.approved_amount, 0) end
  from clm_claims c join clm_v_receivable_balance b on b.claim_id = c.id and b.debtor_type <> 'patient'
  where c.cut_decision = 'fought' and c.status not in ('closed','written_off')
),
everything as (
  select * from itemised union all select * from approval_cut union all select * from short_paid union all select * from fighting
)
select e.tenant_id, e.centre_id, coalesce(ce.name, '—') as centre_name, e.payer_id, coalesce(p.name, 'Unknown payer') as payer_name,
       e.claim_id, coalesce(e.receivable_id, rb.id) as receivable_id, e.adjustment_id,
       coalesce(c.patient_name, rb.patient_name) as patient_name,
       coalesce(c.tpa_claim_number, rb.claim_ref) as claim_ref,
       coalesce(nullif(c.treating_doctor_name, ''), nullif(rb.doctor_name, ''), '—') as doctor_name,
       coalesce(nullif(c.department_name, ''), nullif(rb.speciality, ''), '—') as speciality,
       coalesce(nullif(c.package_code, ''), nullif(rb.procedure_code, ''), '—') as procedure_code,
       coalesce(nullif(c.package_name, ''), nullif(c.procedure_name, ''), nullif(rb.procedure_name, ''), '—') as procedure_name,
       e.kind, e.category, e.reason_text, clm_is_preventable(e.category) as is_preventable,
       (e.at at time zone 'Asia/Kolkata')::date as on_date,
       coalesce(c.discharge_date, (c.discharged_at at time zone 'Asia/Kolkata')::date, rb.bill_date) as file_date,
       e.amount
from everything e
left join clm_claims c on c.id = e.claim_id
left join lateral (
  select r.* from clm_receivables r
  where (e.receivable_id is not null and r.id = e.receivable_id)
     or (e.receivable_id is null and r.claim_id = e.claim_id and r.debtor_type <> 'patient')
  order by r.created_at limit 1
) rb on true
left join clm_payers p on p.id = e.payer_id
left join clm_centres ce on ce.id = e.centre_id
where e.amount > 0;

grant select on clm_v_deduction_lines to authenticated;

revoke execute on function clm_case_bills(uuid, uuid, text, text) from public, anon;
grant execute on function clm_case_bills(uuid, uuid, text, text) to authenticated;
revoke execute on function clm_apply_pmjay_tms(uuid, text, jsonb) from public, anon;
grant execute on function clm_apply_pmjay_tms(uuid, text, jsonb) to authenticated;
revoke execute on function clm_set_deduction_reason(uuid, uuid, text, text) from public, anon;
grant execute on function clm_set_deduction_reason(uuid, uuid, text, text) to authenticated;
revoke execute on function clm_reason_ok(text) from public, anon;
grant execute on function clm_reason_ok(text) to authenticated;
