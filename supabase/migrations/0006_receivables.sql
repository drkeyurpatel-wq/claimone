-- ════════════════════════════════════════════════════════════════════
-- ClaimOne — receivables and reconciliation
--
-- Every rupee a debtor owes is a receivable. Money in is a receipt (a bank
-- credit, or a manual entry). A receipt is spread over receivables by
-- allocations; anything that legitimately reduces what is owed without cash
-- (TDS, payer deduction, package discount, write-off) is an adjustment.
--
--   balance = expected − allocated − adjustments
--
-- Settlement advices from payers are stored line by line and are the
-- strongest evidence for a match (they name the claim, TDS and deduction).
-- Nothing is deleted; a wrong match is reversed, and the reversal is kept.
-- ════════════════════════════════════════════════════════════════════

create table clm_import_batches (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references clm_tenants(id),
  centre_id   uuid not null references clm_centres(id),
  kind        text not null check (kind in ('bank_statement','cashless_tracker','settlement_advice','patient_dues','receivables')),
  file_name   text not null,
  row_count   int not null default 0,
  imported_by uuid references auth.users(id) default auth.uid(),
  created_at  timestamptz not null default now()
);

create table clm_receivables (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references clm_tenants(id),
  centre_id        uuid not null references clm_centres(id),
  claim_id         uuid references clm_claims(id),
  debtor_type      text not null check (debtor_type in ('insurer','tpa','government','corporate','patient','referrer')),
  payer_id         uuid references clm_payers(id),
  debtor_name      text not null,
  bill_no          text,
  ip_no            text,
  claim_ref        text,                              -- payer's claim number
  bill_date        date not null,
  patient_name     text,
  doctor_name      text,
  care_of          text,                              -- patient dues: who vouched for it
  billed_amount    numeric(12,2),
  expected_amount  numeric(12,2) not null check (expected_amount >= 0),   -- what this debtor owes
  recorded_utr     text,                              -- UTR the team typed against the bill, if any
  status           text not null default 'open' check (status in ('open','disputed','closed')),
  notes            text,
  source           text not null default 'manual' check (source in ('manual','claim','import')),
  import_batch_id  uuid references clm_import_batches(id),
  created_by       uuid references auth.users(id) default auth.uid(),
  created_at       timestamptz not null default now()
);
-- full unique constraint (not partial) so imports can upsert on it; null bill numbers never collide
alter table clm_receivables add constraint clm_receivables_bill_uq unique (tenant_id, centre_id, debtor_type, bill_no);
create unique index clm_receivables_claim_uq on clm_receivables (claim_id) where claim_id is not null and debtor_type <> 'patient';
create index clm_receivables_open on clm_receivables (centre_id, status, bill_date);
comment on column clm_receivables.patient_name is 'PHI: patient name';
comment on column clm_receivables.ip_no is 'PHI: admission number';

create table clm_receipts (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references clm_tenants(id),
  centre_id        uuid not null references clm_centres(id),
  source           text not null check (source in ('bank','manual')),
  bank_account     text,
  value_date       date not null,
  amount           numeric(14,2) not null check (amount > 0),
  reference        text,                              -- UTR / cheque no., as extracted
  narration        text,
  payer_id         uuid references clm_payers(id),    -- if known
  import_batch_id  uuid references clm_import_batches(id),
  created_by       uuid references auth.users(id) default auth.uid(),
  created_at       timestamptz not null default now()
);
-- the same bank line imported twice is refused
create unique index clm_receipts_dedupe on clm_receipts (tenant_id, coalesce(bank_account,''), value_date, amount, coalesce(reference, narration, ''));
create index clm_receipts_ref on clm_receipts (tenant_id, reference);

create table clm_remittance_lines (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references clm_tenants(id),
  centre_id        uuid not null references clm_centres(id),
  payer_id         uuid references clm_payers(id),
  payer_name       text,
  advice_ref       text,
  utr              text,
  advice_date      date,
  claim_ref        text,
  bill_no          text,
  patient_name     text,
  approved_amount  numeric(12,2),
  tds_amount       numeric(12,2) not null default 0,
  deduction_amount numeric(12,2) not null default 0,
  deduction_reason text,
  net_amount       numeric(12,2) not null,
  import_batch_id  uuid references clm_import_batches(id),
  created_at       timestamptz not null default now()
);
create index clm_remittance_utr on clm_remittance_lines (tenant_id, utr);

create table clm_allocations (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references clm_tenants(id),
  receipt_id     uuid not null references clm_receipts(id),
  receivable_id  uuid not null references clm_receivables(id),
  amount         numeric(14,2) not null check (amount > 0),
  method         text not null check (method in ('advice','utr','amount','bulk','manual')),
  remittance_line_id uuid references clm_remittance_lines(id),
  reversed_at    timestamptz,
  reversed_by    uuid references auth.users(id),
  reverse_reason text,
  created_by     uuid references auth.users(id) default auth.uid(),
  created_at     timestamptz not null default now()
);
create index clm_alloc_receipt on clm_allocations (receipt_id) where reversed_at is null;
create index clm_alloc_receivable on clm_allocations (receivable_id) where reversed_at is null;

create table clm_adjustments (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references clm_tenants(id),
  receivable_id  uuid not null references clm_receivables(id),
  kind           text not null check (kind in ('tds','deduction','discount','write_off','refund_due','rounding','financing_cost')),
  amount         numeric(12,2) not null,            -- reduces the balance; refund_due is negative (we owe back)
  category       text,                              -- deduction reason category (same list as clm_disallowances)
  reason_text    text,
  remittance_line_id uuid references clm_remittance_lines(id),
  reversed_at    timestamptz,
  reversed_by    uuid references auth.users(id),
  created_by     uuid references auth.users(id) default auth.uid(),
  created_at     timestamptz not null default now(),
  check ((kind = 'refund_due') = (amount < 0)),
  check (kind <> 'deduction' or category is not null)
);
create index clm_adj_receivable on clm_adjustments (receivable_id) where reversed_at is null;

-- ─── Guards ──────────────────────────────────────────────────────────

create or replace function clm_recon_child_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_t uuid;
begin
  if tg_table_name = 'clm_allocations' then
    select tenant_id into v_t from clm_receivables where id = new.receivable_id;
    if v_t is distinct from (select tenant_id from clm_receipts where id = new.receipt_id) then
      raise exception 'Receipt and receivable belong to different hospitals' using errcode = 'check_violation';
    end if;
  else
    select tenant_id into v_t from clm_receivables where id = new.receivable_id;
  end if;
  if v_t is null then raise exception 'Unknown receivable' using errcode = 'foreign_key_violation'; end if;
  new.tenant_id := v_t;
  return new;
end $$;

create trigger clm_alloc_tenant before insert on clm_allocations for each row execute function clm_recon_child_guard();
create trigger clm_adj_tenant   before insert on clm_adjustments for each row execute function clm_recon_child_guard();

-- A receipt cannot be spread over more than it is; a write-off needs a manager.
create or replace function clm_allocations_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_amt numeric; v_used numeric;
begin
  select amount into v_amt from clm_receipts where id = new.receipt_id for update;
  select coalesce(sum(amount), 0) into v_used from clm_allocations
   where receipt_id = new.receipt_id and reversed_at is null and id <> new.id;
  if v_used + new.amount > v_amt + 0.5 then
    raise exception 'Receipt has ₹% left to allocate, not ₹%', v_amt - v_used, new.amount using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger clm_alloc_check before insert on clm_allocations for each row execute function clm_allocations_check();

create or replace function clm_adjustments_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'write_off' and coalesce(clm_current_role(), '') not in ('admin','manager') then
    raise exception 'Only a manager can write off a receivable' using errcode = 'insufficient_privilege';
  end if;
  if new.kind in ('write_off','deduction') and coalesce(trim(new.reason_text), '') = '' and new.remittance_line_id is null then
    raise exception 'Give a reason for the %', replace(new.kind, '_', '-') using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger clm_adj_check before insert on clm_adjustments for each row execute function clm_adjustments_check();

-- Only reversal is allowed after the fact, and it is stamped.
create or replace function clm_recon_reverse_only() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.reversed_at is not null then
    raise exception 'Already reversed' using errcode = 'check_violation';
  end if;
  if new.reversed_at is null or (to_jsonb(new) - array['reversed_at','reversed_by','reverse_reason']) <> (to_jsonb(old) - array['reversed_at','reversed_by','reverse_reason']) then
    raise exception 'Matches and adjustments cannot be edited — reverse and redo' using errcode = 'check_violation';
  end if;
  new.reversed_at := now();
  new.reversed_by := auth.uid();
  return new;
end $$;

create trigger clm_alloc_reverse before update on clm_allocations for each row execute function clm_recon_reverse_only();
create trigger clm_adj_reverse   before update on clm_adjustments for each row execute function clm_recon_reverse_only();

-- Receivables from claims: once the payer approves, the approved amount is owed.
create or replace function clm_claims_to_receivable() returns trigger
language plpgsql security definer set search_path = public as $$
declare p clm_payers%rowtype;
begin
  if new.status in ('claim_approved','claim_partial') and new.approved_amount is not null then
    select * into p from clm_payers where id = new.payer_id;
    insert into clm_receivables (tenant_id, centre_id, claim_id, debtor_type, payer_id, debtor_name, claim_ref, bill_date,
                                 patient_name, doctor_name, ip_no, billed_amount, expected_amount, source, created_by)
    values (new.tenant_id, new.centre_id, new.id,
            case p.type when 'government' then 'government' when 'corporate' then 'corporate' when 'tpa' then 'tpa' else 'insurer' end,
            new.payer_id, p.name, new.tpa_claim_number, coalesce(new.discharge_date, current_date),
            new.patient_name, new.treating_doctor_name, new.admission_ref, new.claimed_amount, new.approved_amount, 'claim', auth.uid())
    on conflict (claim_id) where claim_id is not null and debtor_type <> 'patient'
    do update set expected_amount = excluded.expected_amount, claim_ref = coalesce(excluded.claim_ref, clm_receivables.claim_ref);
  end if;
  return null;
end $$;

create trigger clm_claims_receivable after update of status, approved_amount on clm_claims
for each row execute function clm_claims_to_receivable();

-- ─── Balances ────────────────────────────────────────────────────────

create or replace view clm_v_receivable_balance with (security_invoker = true) as
select r.*,
       coalesce(a.allocated, 0) as allocated,
       coalesce(j.tds, 0) as tds, coalesce(j.deduction, 0) as deduction, coalesce(j.discount, 0) as discount,
       coalesce(j.write_off, 0) as write_off, coalesce(j.refund_due, 0) as refund_due, coalesce(j.other, 0) as other_adj,
       round(r.expected_amount - coalesce(a.allocated, 0) - coalesce(j.total, 0), 2) as balance,
       (current_date - r.bill_date) as age_days,
       case when r.status = 'disputed' then 'disputed'
            when round(r.expected_amount - coalesce(a.allocated, 0) - coalesce(j.total, 0), 2) < -1 then 'over_received'
            when abs(round(r.expected_amount - coalesce(a.allocated, 0) - coalesce(j.total, 0), 2)) <= 1 then 'settled'
            when coalesce(a.allocated, 0) > 0 or coalesce(j.total, 0) > 0 then 'part_received'
            else 'open' end as recon_status,
       a.last_receipt_date
from clm_receivables r
left join lateral (
  select sum(al.amount) as allocated, max(rc.value_date) as last_receipt_date
  from clm_allocations al join clm_receipts rc on rc.id = al.receipt_id
  where al.receivable_id = r.id and al.reversed_at is null
) a on true
left join lateral (
  select sum(amount) as total,
         sum(amount) filter (where kind = 'tds') as tds,
         sum(amount) filter (where kind = 'deduction') as deduction,
         sum(amount) filter (where kind = 'discount') as discount,
         sum(amount) filter (where kind = 'write_off') as write_off,
         sum(amount) filter (where kind = 'refund_due') as refund_due,
         sum(amount) filter (where kind in ('rounding','financing_cost')) as other
  from clm_adjustments where receivable_id = r.id and reversed_at is null
) j on true;

create or replace view clm_v_receipt_balance with (security_invoker = true) as
select rc.*, coalesce(sum(al.amount) filter (where al.reversed_at is null), 0) as allocated,
       round(rc.amount - coalesce(sum(al.amount) filter (where al.reversed_at is null), 0), 2) as unallocated
from clm_receipts rc left join clm_allocations al on al.receipt_id = rc.id
group by rc.id;

-- ─── Confirming matches: one transaction for a batch of proposals ──────
-- p_items: [{receipt_id, receivable_id, amount, method, remittance_line_id?,
--            adjustments: [{kind, amount, category?, reason_text?}]}]
create or replace function clm_confirm_matches(p_items jsonb) returns int
language plpgsql security invoker set search_path = public as $$
declare it jsonb; adj jsonb; n int := 0;
begin
  if not clm_can_write() then raise exception 'Read-only access' using errcode = 'insufficient_privilege'; end if;
  for it in select * from jsonb_array_elements(p_items) loop
    if coalesce((it->>'amount')::numeric, 0) > 0 then
      insert into clm_allocations (receipt_id, receivable_id, amount, method, remittance_line_id)
      values ((it->>'receipt_id')::uuid, (it->>'receivable_id')::uuid, (it->>'amount')::numeric,
              it->>'method', nullif(it->>'remittance_line_id', '')::uuid);
    end if;
    for adj in select * from jsonb_array_elements(coalesce(it->'adjustments', '[]'::jsonb)) loop
      insert into clm_adjustments (receivable_id, kind, amount, category, reason_text, remittance_line_id)
      values ((it->>'receivable_id')::uuid, adj->>'kind', (adj->>'amount')::numeric, adj->>'category', adj->>'reason_text',
              nullif(it->>'remittance_line_id', '')::uuid);
    end loop;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ─── RLS ─────────────────────────────────────────────────────────────

alter table clm_import_batches   enable row level security;
alter table clm_receivables      enable row level security;
alter table clm_receipts         enable row level security;
alter table clm_remittance_lines enable row level security;
alter table clm_allocations      enable row level security;
alter table clm_adjustments      enable row level security;

create policy batches_rw on clm_import_batches for all
  using (tenant_id = clm_current_tenant() and clm_can_access_centre(centre_id))
  with check (tenant_id = clm_current_tenant() and clm_can_access_centre(centre_id) and clm_can_write());

create policy recv_read on clm_receivables for select using (tenant_id = clm_current_tenant() and clm_can_access_centre(centre_id));
create policy recv_insert on clm_receivables for insert
  with check (tenant_id = clm_current_tenant() and clm_can_access_centre(centre_id) and clm_can_write());
create policy recv_update on clm_receivables for update
  using (tenant_id = clm_current_tenant() and clm_can_access_centre(centre_id) and clm_can_write())
  with check (tenant_id = clm_current_tenant() and clm_can_access_centre(centre_id));

create policy rcpt_read on clm_receipts for select using (tenant_id = clm_current_tenant() and clm_can_access_centre(centre_id));
create policy rcpt_insert on clm_receipts for insert
  with check (tenant_id = clm_current_tenant() and clm_can_access_centre(centre_id) and clm_can_write());

create policy rem_read on clm_remittance_lines for select using (tenant_id = clm_current_tenant() and clm_can_access_centre(centre_id));
create policy rem_insert on clm_remittance_lines for insert
  with check (tenant_id = clm_current_tenant() and clm_can_access_centre(centre_id) and clm_can_write());

create or replace function clm_can_see_receivable(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from clm_receivables r where r.id = p and r.tenant_id = clm_current_tenant() and clm_can_access_centre(r.centre_id))
$$;

create policy alloc_read on clm_allocations for select using (clm_can_see_receivable(receivable_id));
create policy alloc_insert on clm_allocations for insert with check (clm_can_see_receivable(receivable_id) and clm_can_write());
create policy alloc_reverse on clm_allocations for update using (clm_can_see_receivable(receivable_id) and clm_can_write());
create policy adj_read on clm_adjustments for select using (clm_can_see_receivable(receivable_id));
create policy adj_insert on clm_adjustments for insert with check (clm_can_see_receivable(receivable_id) and clm_can_write());
create policy adj_reverse on clm_adjustments for update using (clm_can_see_receivable(receivable_id) and clm_can_write());

grant select on clm_v_receivable_balance, clm_v_receipt_balance to authenticated;
grant execute on function clm_confirm_matches(jsonb) to authenticated;
revoke execute on function clm_confirm_matches(jsonb) from anon;
