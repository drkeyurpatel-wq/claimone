-- ════════════════════════════════════════════════════════════════════
-- Leakage from every place money is lost, not only the old itemised
-- settlement form:
--   1. itemised settlement deductions and rejections (clm_disallowances)
--   2. a cut at approval — claimed more than the insurer approved
--      (claim_partial), reason read from the note typed with it
--   3. a short payment given a reason on the patient's Payment stage or on
--      "Payments to check" (clm_adjustments kind 'deduction'), including
--      bills that came only from the PMJAY sheet and have no case
-- A claim with itemised disallowances is counted from those alone, so the
-- same rupee is never counted twice.
-- ════════════════════════════════════════════════════════════════════

-- the reason words the case screen puts at the head of an "Approved less" note
create or replace function clm_deduction_category(reason text) returns text
language sql immutable set search_path = public as $$
  select case
    when reason ~* 'not answered in time|query.*(late|time)' then 'query_tat'
    when reason ~* 'room' then 'room_rent_cap'
    when reason ~* 'co.?pay' then 'co_pay'
    when reason ~* 'non.?pay|consumable|not payable' then 'non_payable'
    when reason ~* 'exclu' then 'policy_exclusion'
    when reason ~* 'pre.?exist|ped' then 'pre_existing'
    when reason ~* 'tariff|package|rate' then 'tariff_excess'
    when reason ~* 'document|doc |missing doc' then 'doc_missing'
    else 'other' end
$$;

create or replace function clm_is_preventable(p_category text) returns boolean
language sql immutable set search_path = public as $$
  select coalesce(p_category in ('room_rent_cap','non_payable','doc_missing','tariff_excess','query_tat'), false)
$$;

drop view if exists clm_v_leakage;
create view clm_v_leakage with (security_invoker = true) as
with itemised as (
  select d.tenant_id, c.centre_id, c.payer_id, c.treating_doctor_name as doctor, d.kind, d.category, d.recorded_at as at, d.amount
  from clm_disallowances d join clm_claims c on c.id = d.claim_id
),
approval_cut as (
  select c.tenant_id, c.centre_id, c.payer_id, c.treating_doctor_name as doctor, 'deduction'::text as kind,
         clm_deduction_category(t.notes) as category, coalesce(t.created_at, c.updated_at) as at,
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
       date_trunc('month', e.at)::date as month,
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
