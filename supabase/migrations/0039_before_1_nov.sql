-- 0039: "Before 1 Nov" — the opening figure, frozen.
-- ClaimOne works on files discharged on or after 1 Nov 2026. What was pending on the older files is written down once,
-- per centre, on the day this runs; the Before 1 Nov tab shows it beside what is still pending today.
-- Rule (same as the app, rcm/ledger.ts): a bill belongs with its case's discharge date; a bill with no case goes by its bill date.
create table clm_old_opening (
  centre_id     uuid primary key references clm_centres(id),
  tenant_id     uuid not null references clm_tenants(id),
  cutoff        date not null,
  as_on         date not null,
  bills         int  not null,
  bill_amount   numeric(14,2) not null,
  claims        int  not null,          -- claims submitted and not decided: no bill yet
  claim_amount  numeric(14,2) not null, -- their claimed amount
  created_at    timestamptz not null default now()
);
alter table clm_old_opening enable row level security;
create policy old_opening_read on clm_old_opening for select
  using (tenant_id = clm_current_tenant() and clm_can_access_centre(centre_id));
grant select on clm_old_opening to authenticated;
comment on table clm_old_opening is 'Pending on files discharged before the cutoff, frozen on as_on. Written once by migration; read-only in the app.';

insert into clm_old_opening (centre_id, tenant_id, cutoff, as_on, bills, bill_amount, claims, claim_amount)
select ce.id, ce.tenant_id, date '2026-11-01', (now() at time zone 'Asia/Kolkata')::date,
       coalesce(b.n, 0), coalesce(b.amt, 0), coalesce(s.n, 0), coalesce(s.amt, 0)
from clm_centres ce
left join lateral (
  select count(*)::int n, sum(v.balance) amt
  from clm_v_receivable_balance v
  join clm_receivables r on r.id = v.id
  left join clm_claims c on c.id = r.claim_id
  where r.centre_id = ce.id and v.balance > 1 and r.status <> 'closed'
    and (case when c.id is not null then c.discharge_date else r.bill_date end) < date '2026-11-01'
) b on true
left join lateral (
  select count(*)::int n, sum(coalesce(c.claimed_amount, c.package_amount, 0)) amt
  from clm_claims c
  where c.centre_id = ce.id and c.status = 'claim_submitted' and c.discharge_date < date '2026-11-01'
) s on true
where coalesce(b.n, 0) + coalesce(s.n, 0) > 0
on conflict (centre_id) do nothing;
