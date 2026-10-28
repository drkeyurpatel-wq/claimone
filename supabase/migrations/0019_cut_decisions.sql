-- ════════════════════════════════════════════════════════════════════
-- Cuts are not accepted silently. When the insurer pays or approves ₹1,000
-- or more below the claim, the file waits for a person: "Accept the cut" or
-- "Fight it". Fighting keeps the cut as money still due (the bill owes the
-- full claim again) and the file open as disputed, until the insurer pays or
-- the desk gives up and accepts. Smaller cuts still close on their own.
-- ════════════════════════════════════════════════════════════════════

alter table clm_claims add column if not exists cut_decision text check (cut_decision in ('accepted','fought'));
alter table clm_claims add column if not exists cut_note text;
alter table clm_claims add column if not exists cut_decided_at timestamptz;
alter table clm_claims add column if not exists cut_decided_by uuid references auth.users(id);

-- Cuts below this close by themselves (TS copy: CUT_FLOOR in src/lib/rcm/cut.ts).
create or replace function clm_cut_floor() returns numeric
language sql immutable set search_path = public as $$ select 1000::numeric $$;

-- "non billable" is the same reason as "non payable"
create or replace function clm_deduction_category(reason text) returns text
language sql immutable set search_path = public as $$
  select case
    when reason ~* 'not answered in time|query.*(late|time)' then 'query_tat'
    when reason ~* 'room' then 'room_rent_cap'
    when reason ~* 'co.?pay' then 'co_pay'
    when reason ~* 'non.?pay|non.?bill|not bill|consumable|not payable' then 'non_payable'
    when reason ~* 'exclu' then 'policy_exclusion'
    when reason ~* 'pre.?exist|ped' then 'pre_existing'
    when reason ~* 'tariff|package|rate' then 'tariff_excess'
    when reason ~* 'document|doc |missing doc' then 'doc_missing'
    else 'other' end
$$;

-- ─── 1. Settling from payments waits for a decision on a big cut ─────
create or replace function clm_settle_from_receivable(p_receivable uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  r clm_receivables%rowtype; c clm_claims%rowtype;
  v_alloc numeric; v_tds numeric; v_adj numeric; v_balance numeric; v_claimed numeric; v_final numeric;
  v_utr text; v_date date; v_id uuid;
begin
  select * into r from clm_receivables where id = p_receivable;
  if not found or r.claim_id is null or r.debtor_type = 'patient' then return false; end if;
  select * into c from clm_claims where id = r.claim_id for update;
  if c.status not in ('claim_approved','claim_partial','settlement_pending') then return false; end if;
  if exists (select 1 from clm_settlements where claim_id = c.id) then return false; end if;

  select coalesce(sum(a.amount), 0), max(rc.value_date) into v_alloc, v_date
  from clm_allocations a join clm_receipts rc on rc.id = a.receipt_id where a.receivable_id = r.id and a.reversed_at is null;
  select coalesce(sum(amount) filter (where kind = 'tds'), 0), coalesce(sum(amount), 0) into v_tds, v_adj
  from clm_adjustments where receivable_id = r.id and reversed_at is null;
  v_balance := round(r.expected_amount - v_alloc - v_adj, 2);
  if v_alloc <= 0 or abs(v_balance) > 1 then return false; end if;

  v_claimed := coalesce(c.claimed_amount, r.billed_amount, c.approved_amount, r.expected_amount);
  v_final := v_alloc + v_tds;
  -- a cut of ₹1,000 or more waits for "Accept the cut" or "Fight it"
  if v_claimed - v_final >= clm_cut_floor() and c.cut_decision is distinct from 'accepted' then return false; end if;

  select rc.reference into v_utr from clm_allocations a join clm_receipts rc on rc.id = a.receipt_id
  where a.receivable_id = r.id and a.reversed_at is null order by rc.value_date desc, a.created_at desc limit 1;

  insert into clm_settlements (tenant_id, claim_id, claimed_amount, approved_amount, deduction_amount, tds_amount, net_amount,
                               utr_number, payment_date, payment_mode, is_reconciled, source, recorded_by)
  values (c.tenant_id, c.id, greatest(v_claimed, v_final), v_final, greatest(v_claimed - v_final, 0), v_tds, v_alloc,
          case when v_utr is not null and not exists (select 1 from clm_settlements s where s.tenant_id = c.tenant_id and s.utr_number = v_utr)
               then v_utr end,
          coalesce(v_date, current_date), 'neft', true, 'recon', auth.uid())
  returning id into v_id;

  perform set_config('claimone.source', 'recon', true);
  perform set_config('claimone.note', 'Paid and reconciled from the payment upload', true);
  update clm_claims set
    settled_amount = v_alloc, tds_amount = v_tds, deduction_amount = greatest(v_claimed - v_final, 0),
    settlement_utr = v_utr, settlement_date = coalesce(v_date, current_date), status = 'settled'
  where id = c.id;
  perform set_config('claimone.source', '', true);
  perform set_config('claimone.note', '', true);
  return true;
end $$;

-- ─── 2. While a cut is being fought, the bill owes the full claim ────
create or replace function clm_claims_to_receivable() returns trigger
language plpgsql security definer set search_path = public as $$
declare p clm_payers%rowtype; v_owed numeric;
begin
  if new.status in ('claim_approved','claim_partial') and new.approved_amount is not null then
    select * into p from clm_payers where id = new.payer_id;
    v_owed := case when new.cut_decision = 'fought' then greatest(coalesce(new.claimed_amount, 0), new.approved_amount)
                   else new.approved_amount end;
    insert into clm_receivables (tenant_id, centre_id, claim_id, debtor_type, payer_id, debtor_name, claim_ref, bill_date,
                                 patient_name, doctor_name, ip_no, billed_amount, expected_amount, source, created_by)
    values (new.tenant_id, new.centre_id, new.id,
            case p.type when 'government' then 'government' when 'corporate' then 'corporate' when 'tpa' then 'tpa' else 'insurer' end,
            new.payer_id, p.name, new.tpa_claim_number, coalesce(new.discharge_date, current_date),
            new.patient_name, new.treating_doctor_name, new.admission_ref, new.claimed_amount, v_owed, 'claim', auth.uid())
    on conflict (claim_id) where claim_id is not null and debtor_type <> 'patient'
    do update set expected_amount = excluded.expected_amount, claim_ref = coalesce(excluded.claim_ref, clm_receivables.claim_ref);
  end if;
  return null;
end $$;

-- A letter that repeats a cut we are fighting is not booked: the fight goes on.
create or replace function clm_letter_deduction_net() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_cut numeric; v_fought boolean;
begin
  select c.cut_decision = 'fought', case when c.approved_amount is not null then greatest(coalesce(c.claimed_amount, 0) - r.expected_amount, 0) end
    into v_fought, v_cut
  from clm_receivables r join clm_claims c on c.id = r.claim_id
  where r.id = new.receivable_id;
  if coalesce(v_fought, false) then return null; end if;
  if coalesce(v_cut, 0) > 0 then
    new.amount := round(new.amount - v_cut, 2);
    if new.amount <= 0.5 then return null; end if;
  end if;
  return new;
end $$;

-- ─── 3. The decision ─────────────────────────────────────────────────
-- fight:  the cut becomes money still due; letter deductions on the bill are reversed (kept for audit).
-- accept: the bill owes the approved amount again; any unexplained shortfall is booked as a
--         deduction with the reason given; the file then closes from its payments.
create or replace function clm_decide_cut(p_claim uuid, p_decision text, p_note text default null, p_category text default null)
returns text
language plpgsql security definer set search_path = public as $$
declare
  c clm_claims%rowtype; r clm_receivables%rowtype; v_bal numeric; v_alloc numeric; v_cat text;
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

  select * into r from clm_receivables where claim_id = c.id and debtor_type <> 'patient';

  update clm_claims set cut_decision = case p_decision when 'fight' then 'fought' else 'accepted' end,
         cut_note = nullif(btrim(p_note), ''), cut_decided_at = now(), cut_decided_by = auth.uid()
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

-- ─── 4. Leakage: fought cuts are not lost money; they show as "being fought" ─
drop view if exists clm_v_leakage;
create view clm_v_leakage with (security_invoker = true) as
with itemised as (
  select d.tenant_id, c.centre_id, c.payer_id, c.treating_doctor_name as doctor, d.kind, d.category, d.recorded_at as at, d.amount
  from clm_disallowances d join clm_claims c on c.id = d.claim_id
  where c.cut_decision is distinct from 'fought'
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
    and c.cut_decision is distinct from 'fought'
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
fighting as (
  select c.tenant_id, c.centre_id, c.payer_id, c.treating_doctor_name as doctor, 'fighting'::text as kind,
         coalesce((select a.category from clm_adjustments a where a.receivable_id = b.id and a.kind = 'deduction'
                   order by a.created_at desc limit 1), 'other') as category,
         c.cut_decided_at as at,
         case when b.allocated > 0 then b.balance else coalesce(c.claimed_amount, 0) - coalesce(c.approved_amount, 0) end as amount
  from clm_claims c join clm_v_receivable_balance b on b.claim_id = c.id and b.debtor_type <> 'patient'
  where c.cut_decision = 'fought' and c.status not in ('closed','written_off')
),
everything as (
  select * from itemised union all select * from approval_cut union all select * from short_paid union all select * from fighting
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

do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'clm\_%' loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;
grant execute on function clm_nhcx_receive(text, jsonb) to anon;
