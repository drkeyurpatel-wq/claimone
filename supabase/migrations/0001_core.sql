-- ════════════════════════════════════════════════════════════════════
-- ClaimOne — merged schema (ClaimOne Aug 2026 + H1 Claims Apr 2026)
--
-- Design rules that the rest of the app depends on:
--   1. Every row carries tenant_id. RLS isolates tenants. The app only ever
--      uses the ANON key; the service-role key must never be deployed.
--   2. Status changes are policed HERE, in a trigger, not in the UI:
--        - only allowed transitions (clm_allowed_transitions)
--        - submission statuses are blocked while a mandatory document
--          is not verified (ClaimOne's submission gate)
--        - 'settled' needs a settlement row; 'written_off' needs a manager
--   3. One trigger logs each status change exactly once (H1 Claims logged
--      twice because of duplicate triggers).
--   4. Documents are private. The UI uses short-lived signed URLs.
-- ════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;

-- ─── Tenancy ─────────────────────────────────────────────────────────

create table clm_tenants (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  name        text not null,
  created_at  timestamptz not null default now()
);

create table clm_centres (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references clm_tenants(id),
  code        text not null,
  name        text not null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (tenant_id, code)
);

-- Seam for the common login (H1 Identity). Until HRMS owns identity,
-- an admin inserts one row per Supabase auth user.
create table clm_user_profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  tenant_id   uuid not null references clm_tenants(id),
  full_name   text not null,
  role        text not null check (role in ('admin','manager','desk','viewer','bot')),
  centre_ids  uuid[],            -- null = every centre in the tenant
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ─── Session helpers (used by RLS) ───────────────────────────────────

create or replace function clm_current_tenant() returns uuid
language sql stable security definer set search_path = public as $$
  select tenant_id from clm_user_profiles where user_id = auth.uid() and is_active
$$;

create or replace function clm_current_role() returns text
language sql stable security definer set search_path = public as $$
  select role from clm_user_profiles where user_id = auth.uid() and is_active
$$;

create or replace function clm_can_access_centre(p_centre uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from clm_user_profiles
    where user_id = auth.uid() and is_active
      and (centre_ids is null or p_centre = any(centre_ids))
  )
$$;

create or replace function clm_can_write() returns boolean
language sql stable as $$ select clm_current_role() in ('admin','manager','desk') $$;

-- ─── Payers ──────────────────────────────────────────────────────────

create table clm_payers (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid references clm_tenants(id),   -- null = platform-wide
  code                 text not null,
  name                 text not null,
  type                 text not null check (type in ('tpa','insurer','government','psu','corporate')),
  portal_url           text,
  portal_type          text,
  is_nhcx_live         boolean not null default false,
  query_tat_hours      int not null default 48,
  avg_settlement_days  int,
  is_active            boolean not null default true,
  created_at           timestamptz not null default now()
);
create unique index clm_payers_code_uq on clm_payers (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), code);

-- ─── Claims ──────────────────────────────────────────────────────────

create table clm_claims (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references clm_tenants(id),
  centre_id             uuid not null references clm_centres(id),
  payer_id              uuid not null references clm_payers(id),
  claim_number          text not null,
  claim_type            text not null check (claim_type in
                          ('cashless','reimbursement','pmjay','cghs','echs','state_scheme','corporate')),
  status                text not null default 'draft' check (status in (
                          'draft',
                          'preauth_pending','preauth_approved','preauth_query','preauth_rejected','preauth_enhanced',
                          'claim_submitted','claim_under_review','claim_query',
                          'claim_approved','claim_partial','claim_rejected',
                          'settlement_pending','settled','closed','written_off')),
  priority              text not null default 'medium' check (priority in ('low','medium','high','critical')),

  -- patient / episode (external refs until HMIS is live)
  patient_name          text not null,
  patient_phone         text,
  patient_uhid          text,
  abha_id               text,
  admission_ref         text,
  policy_number         text,
  policy_holder_name    text,
  primary_diagnosis     text,
  icd_code              text,
  procedure_name        text,
  package_code          text,
  package_name          text,
  package_amount        numeric(12,2),
  treating_doctor_name  text,
  department_name       text,
  admission_date        date,
  discharge_date        date,

  -- money (all in rupees)
  estimated_amount      numeric(12,2) check (estimated_amount >= 0),
  claimed_amount        numeric(12,2) check (claimed_amount >= 0),
  approved_amount       numeric(12,2) check (approved_amount >= 0),
  settled_amount        numeric(12,2) check (settled_amount >= 0),
  tds_amount            numeric(12,2) check (tds_amount >= 0),
  deduction_amount      numeric(12,2) check (deduction_amount >= 0),
  patient_payable       numeric(12,2) check (patient_payable >= 0),

  -- payer references
  tpa_claim_number      text,
  tpa_preauth_number    text,
  settlement_utr        text,
  settlement_date       date,

  -- workflow
  preauth_submitted_at  timestamptz,
  submitted_at          timestamptz,
  assigned_to           uuid references auth.users(id),
  query_count           int not null default 0,
  is_query_pending      boolean not null default false,
  medpay_synced         boolean not null default false,  -- set only by a real MedPay sync
  medpay_synced_at      timestamptz,
  notes                 text,
  tags                  text[],
  created_by            uuid references auth.users(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  unique (tenant_id, claim_number)
);
create index clm_claims_centre_status on clm_claims (centre_id, status);
create index clm_claims_payer_status  on clm_claims (payer_id, status);

create table clm_preauths (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references clm_tenants(id),
  claim_id              uuid not null references clm_claims(id),
  request_type          text not null check (request_type in ('initial','enhancement','extension')),
  diagnosis             text not null,
  procedure_planned     text,
  estimated_cost        numeric(12,2) not null check (estimated_cost >= 0),
  approved_amount       numeric(12,2) check (approved_amount >= 0),
  status                text not null default 'pending' check (status in ('pending','approved','query','rejected')),
  submitted_at          timestamptz,
  response_received_at  timestamptz,
  created_at            timestamptz not null default now()
);

-- ─── Document rules (ClaimOne) — replaces H1 clm_doc_checklists ─────
-- stage: which submission the document is needed for.
-- Most specific rule wins per doc_code (see clm_unmet_mandatory_docs).

create table clm_doc_rules (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid references clm_tenants(id),   -- null = platform default
  payer_id     uuid references clm_payers(id),    -- null = every payer
  claim_type   text,                              -- null = every claim type
  stage        text not null check (stage in ('preauth','final','reimbursement')),
  doc_code     text not null,
  doc_label    text not null,
  is_mandatory boolean not null default true,
  min_amount   numeric(12,2),                     -- applies when amount >= min_amount
  sort_order   int not null default 0,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

create table clm_documents (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references clm_tenants(id),
  claim_id          uuid not null references clm_claims(id),
  doc_code          text,                       -- links to clm_doc_rules.doc_code
  document_name     text not null,
  document_category text not null default 'clinical'
                    check (document_category in ('clinical','billing','identity','insurance','correspondence','other')),
  file_path         text not null,              -- storage path, never a public URL
  file_size_bytes   bigint,
  mime_type         text,
  source            text not null default 'manual' check (source in ('manual','bot','nhcx','hmis')),
  status            text not null default 'uploaded' check (status in ('uploaded','valid','invalid')),
  review_note       text,
  verified_by       uuid references auth.users(id),
  verified_at       timestamptz,
  uploaded_by       uuid references auth.users(id),
  sort_order        int not null default 0,
  created_at        timestamptz not null default now()
);
create index clm_documents_claim on clm_documents (claim_id);

-- ─── Queries ─────────────────────────────────────────────────────────

create table clm_queries (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references clm_tenants(id),
  claim_id         uuid not null references clm_claims(id),
  query_number     int not null,
  query_text       text not null,
  query_category   text not null default 'documentation'
                   check (query_category in ('clinical','billing','documentation','policy','other')),
  priority         text not null default 'medium' check (priority in ('low','medium','high','critical')),
  source           text not null default 'manual' check (source in ('manual','bot','nhcx','email')),
  raised_by        text,
  raised_at        timestamptz not null default now(),
  routed_to        uuid references auth.users(id),
  routed_to_role   text,
  response_text    text,
  responded_by     uuid references auth.users(id),
  responded_at     timestamptz,
  sla_deadline     timestamptz not null,
  escalation_level int not null default 0,
  status           text not null default 'open' check (status in ('open','in_progress','escalated','responded','closed')),
  unique (claim_id, query_number)
);

-- ─── Settlement & leakage ───────────────────────────────────────────
-- Money identity used everywhere:
--   deduction = claimed - approved      (what the payer disallowed)
--   net       = approved - tds          (what lands in the bank)

create table clm_settlements (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references clm_tenants(id),
  claim_id         uuid not null references clm_claims(id),
  claimed_amount   numeric(12,2) not null check (claimed_amount >= 0),
  approved_amount  numeric(12,2) not null check (approved_amount >= 0),
  deduction_amount numeric(12,2) not null check (deduction_amount >= 0),
  tds_amount       numeric(12,2) not null default 0 check (tds_amount >= 0),
  net_amount       numeric(12,2) not null check (net_amount >= 0),
  utr_number       text,
  payment_date     date not null,
  payment_mode     text not null default 'neft' check (payment_mode in ('neft','rtgs','imps','cheque','other')),
  is_reconciled    boolean not null default false,   -- matched to bank statement
  source           text not null default 'manual',
  recorded_by      uuid references auth.users(id),
  created_at       timestamptz not null default now()
);
create unique index clm_settlements_utr_uq on clm_settlements (tenant_id, utr_number) where utr_number is not null;

-- Replaces H1 clm_rejections: one row per disallowed rupee bucket or rejection.
create table clm_disallowances (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references clm_tenants(id),
  claim_id     uuid not null references clm_claims(id),
  kind         text not null check (kind in ('deduction','rejection')),
  stage        text not null default 'claim' check (stage in ('preauth','claim')),
  category     text not null check (category in (
                 'room_rent_cap','non_payable','doc_missing','tariff_excess',
                 'query_tat','pre_existing','policy_exclusion','co_pay','other')),
  amount       numeric(12,2) not null default 0 check (amount >= 0),
  reason_text  text,
  is_preventable boolean generated always as
               (category in ('room_rent_cap','non_payable','doc_missing','tariff_excess','query_tat')) stored,
  recorded_by  uuid references auth.users(id),
  recorded_at  timestamptz not null default now()
);

-- ─── Audit ───────────────────────────────────────────────────────────

create table clm_state_transitions (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references clm_tenants(id),
  claim_id        uuid not null references clm_claims(id),
  from_status     text,
  to_status       text not null,
  trigger_source  text not null default 'user',
  actor_id        uuid,
  notes           text,
  created_at      timestamptz not null default now()
);
create index clm_transitions_claim on clm_state_transitions (claim_id, created_at);

create table clm_events (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references clm_tenants(id),
  claim_id    uuid not null references clm_claims(id),
  event_type  text not null,           -- submit_blocked, doc_verified, doc_rejected, ...
  payload     jsonb not null default '{}',
  actor_id    uuid,
  created_at  timestamptz not null default now()
);
create index clm_events_claim on clm_events (claim_id, created_at);

create table clm_notifications (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references clm_tenants(id),
  claim_id          uuid not null references clm_claims(id),
  recipient_type    text not null check (recipient_type in ('patient','staff')),
  recipient_phone   text,
  recipient_user_id uuid,
  channel           text not null check (channel in ('whatsapp','sms','in_app','email')),
  message_content   text not null,
  metadata          jsonb not null default '{}',
  delivery_status   text not null default 'queued',
  created_at        timestamptz not null default now()
);

create table clm_bot_runs (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references clm_tenants(id),
  centre_id         uuid not null references clm_centres(id),
  payer_id          uuid references clm_payers(id),
  action            text not null check (action in ('submit_preauth','submit_claim','check_status','download_letter')),
  claim_id          uuid references clm_claims(id),
  status            text not null check (status in ('running','success','partial','failed','timeout','captcha_blocked','skipped')),
  started_at        timestamptz not null default now(),
  completed_at      timestamptz,
  duration_ms       int,
  steps_completed   int not null default 0,
  total_steps       int not null default 0,
  error_message     text,
  screenshot_path   text,
  portal_response   jsonb,
  claims_processed  int not null default 0,
  claims_updated    int not null default 0
);

-- ─── Counters for claim numbers ─────────────────────────────────────

create table clm_counters (
  centre_id  uuid not null references clm_centres(id),
  period     text not null,            -- YYMM
  last_value int not null default 0,
  primary key (centre_id, period)
);

-- Child rows and helper functions follow the parent claim's visibility.
create or replace function clm_can_see_claim(p_claim uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from clm_claims c where c.id = p_claim
                 and c.tenant_id = clm_current_tenant() and clm_can_access_centre(c.centre_id))
$$;

-- ════════════════════════════════════════════════════════════════════
-- Business rules
-- ════════════════════════════════════════════════════════════════════

create table clm_allowed_transitions (
  from_status text not null,
  to_status   text not null,
  primary key (from_status, to_status)
);

insert into clm_allowed_transitions (from_status, to_status) values
  ('draft','preauth_pending'), ('draft','claim_submitted'),
  ('preauth_pending','preauth_approved'), ('preauth_pending','preauth_query'), ('preauth_pending','preauth_rejected'),
  ('preauth_query','preauth_pending'), ('preauth_query','preauth_rejected'),
  ('preauth_approved','preauth_enhanced'), ('preauth_approved','claim_submitted'),
  ('preauth_enhanced','claim_submitted'),
  ('preauth_rejected','preauth_pending'), ('preauth_rejected','closed'),
  ('claim_submitted','claim_under_review'), ('claim_submitted','claim_query'),
  ('claim_submitted','claim_approved'), ('claim_submitted','claim_partial'), ('claim_submitted','claim_rejected'),
  ('claim_under_review','claim_approved'), ('claim_under_review','claim_partial'),
  ('claim_under_review','claim_query'), ('claim_under_review','claim_rejected'),
  ('claim_query','claim_submitted'), ('claim_query','claim_rejected'),
  ('claim_approved','settlement_pending'), ('claim_approved','settled'),
  ('claim_partial','settlement_pending'), ('claim_partial','settled'),
  ('settlement_pending','settled'),
  ('settled','closed'),
  ('claim_rejected','claim_submitted'), ('claim_rejected','written_off');

-- Which submission stage a target status represents (null = not a submission)
create or replace function clm_submission_stage(p_to_status text, p_claim_type text) returns text
language sql immutable as $$
  select case
    when p_to_status = 'preauth_pending' then 'preauth'
    when p_to_status = 'claim_submitted' and p_claim_type = 'reimbursement' then 'reimbursement'
    when p_to_status = 'claim_submitted' then 'final'
    else null end
$$;

-- Mandatory documents still not verified for a claim at a stage.
-- MUST stay in step with src/lib/engine/validation.ts (resolveRules):
--   specificity = (tenant+payer 4 | tenant 3 | payer 2 | global 1) * 2 + (claim_type ? 1 : 0)
--   ties go to the mandatory rule; only status 'valid' satisfies a rule.
create or replace function clm_unmet_mandatory_docs(p_claim_id uuid, p_stage text)
returns table (doc_code text, doc_label text, doc_status text)
language sql stable security definer set search_path = public as $$
  with c as (
    select id, tenant_id, payer_id, claim_type,
           case when p_stage = 'preauth' then coalesce(estimated_amount, 0)
                else coalesce(claimed_amount, estimated_amount, 0) end as amount
    from clm_claims where id = p_claim_id and clm_can_see_claim(p_claim_id)
  ),
  candidate as (
    select r.*,
           (case when r.tenant_id is not null and r.payer_id is not null then 4
                 when r.tenant_id is not null then 3
                 when r.payer_id is not null then 2 else 1 end) * 2
           + (case when r.claim_type is not null then 1 else 0 end) as specificity
    from clm_doc_rules r, c
    where r.is_active
      and r.stage = p_stage
      and (r.tenant_id is null or r.tenant_id = c.tenant_id)
      and (r.payer_id  is null or r.payer_id  = c.payer_id)
      and (r.claim_type is null or r.claim_type = c.claim_type)
      and (r.min_amount is null or c.amount >= r.min_amount)
  ),
  resolved as (
    select distinct on (doc_code) doc_code, doc_label, is_mandatory
    from candidate
    order by doc_code, specificity desc, is_mandatory desc
  ),
  doc_state as (
    select d.doc_code,
           case when bool_or(d.status = 'valid') then 'valid'
                when bool_or(d.status = 'uploaded') then 'uploaded'
                else 'invalid' end as status
    from clm_documents d where d.claim_id = p_claim_id and d.doc_code is not null
    group by d.doc_code
  )
  select r.doc_code, r.doc_label, coalesce(s.status, 'missing')
  from resolved r left join doc_state s using (doc_code)
  where r.is_mandatory and coalesce(s.status, 'missing') <> 'valid'
  order by r.doc_label
$$;

-- ─── Claim triggers ─────────────────────────────────────────────────

create or replace function clm_claims_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_code text; v_period text; v_next int; v_tenant uuid;
begin
  select code, tenant_id into v_code, v_tenant from clm_centres where id = new.centre_id;
  if v_tenant is null or v_tenant <> new.tenant_id then
    raise exception 'Centre does not belong to this tenant' using errcode = 'check_violation';
  end if;
  new.status := 'draft';            -- every claim starts as a draft; submission goes through the gate
  v_period := to_char(now() at time zone 'Asia/Kolkata', 'YYMM');
  insert into clm_counters (centre_id, period, last_value) values (new.centre_id, v_period, 1)
  on conflict (centre_id, period) do update set last_value = clm_counters.last_value + 1
  returning last_value into v_next;
  new.claim_number := 'CLM-' || upper(v_code) || '-' || v_period || '-' || lpad(v_next::text, 4, '0');
  new.created_by := coalesce(new.created_by, auth.uid());
  return new;
end $$;

create trigger clm_claims_bi before insert on clm_claims
for each row execute function clm_claims_before_insert();

create or replace function clm_claims_before_update() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_stage text; v_unmet text;
begin
  -- identity fields never move
  if new.tenant_id <> old.tenant_id or new.claim_number <> old.claim_number or new.id <> old.id then
    raise exception 'tenant_id, id and claim_number are immutable' using errcode = 'check_violation';
  end if;
  -- medpay flags are owned by the MedPay sync, not by the desk
  if (new.medpay_synced is distinct from old.medpay_synced) and coalesce(current_setting('claimone.source', true), '') <> 'medpay' then
    raise exception 'medpay_synced can only be set by the MedPay sync' using errcode = 'check_violation';
  end if;

  if new.status is distinct from old.status then
    if old.status in ('closed','written_off') then
      raise exception 'Claim % is %, no further changes', old.claim_number, old.status using errcode = 'check_violation';
    end if;
    if not exists (select 1 from clm_allowed_transitions where from_status = old.status and to_status = new.status) then
      raise exception 'Transition % → % is not allowed', old.status, new.status using errcode = 'check_violation';
    end if;

    v_stage := clm_submission_stage(new.status, new.claim_type);
    if v_stage is not null then
      select string_agg(doc_label || ' (' || doc_status || ')', '; ')
        into v_unmet from clm_unmet_mandatory_docs(new.id, v_stage);
      if v_unmet is not null then
        raise exception 'Submission blocked — documents not verified: %', v_unmet
          using errcode = 'check_violation', hint = 'CLAIMONE_GATE';
      end if;
      if v_stage = 'preauth' then new.preauth_submitted_at := now();
      else new.submitted_at := now(); end if;
    end if;

    if new.status = 'settled' and not exists (select 1 from clm_settlements where claim_id = new.id) then
      raise exception 'Record the settlement (amount, TDS, UTR) before marking settled' using errcode = 'check_violation';
    end if;
    if new.status = 'written_off' and coalesce(clm_current_role(), '') not in ('admin','manager') then
      raise exception 'Only a manager can write off a claim' using errcode = 'insufficient_privilege';
    end if;
    if new.status in ('preauth_approved','preauth_enhanced','claim_approved','claim_partial')
       and new.approved_amount is null then
      raise exception 'Approved amount is required for %', new.status using errcode = 'check_violation';
    end if;
  end if;

  new.updated_at := now();
  return new;
end $$;

create trigger clm_claims_bu before update on clm_claims
for each row execute function clm_claims_before_update();

-- Exactly one audit row per change (single trigger by design).
create or replace function clm_claims_log_transition() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into clm_state_transitions (tenant_id, claim_id, from_status, to_status, trigger_source, actor_id, notes)
    values (new.tenant_id, new.id, null, new.status, coalesce(nullif(current_setting('claimone.source', true), ''), 'user'), auth.uid(), 'Claim created');
  elsif new.status is distinct from old.status then
    insert into clm_state_transitions (tenant_id, claim_id, from_status, to_status, trigger_source, actor_id, notes)
    values (new.tenant_id, new.id, old.status, new.status,
            coalesce(nullif(current_setting('claimone.source', true), ''), 'user'), auth.uid(),
            nullif(current_setting('claimone.note', true), ''));
  end if;
  return null;
end $$;

create trigger clm_claims_ai after insert on clm_claims
for each row execute function clm_claims_log_transition();
create trigger clm_claims_au after update of status on clm_claims
for each row execute function clm_claims_log_transition();

-- ─── Child-row guards: tenant must match the parent claim ───────────

create or replace function clm_child_tenant_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from clm_claims where id = new.claim_id;
  if v_tenant is null then raise exception 'Unknown claim' using errcode = 'foreign_key_violation'; end if;
  new.tenant_id := v_tenant;
  return new;
end $$;

create trigger clm_documents_tenant  before insert on clm_documents      for each row execute function clm_child_tenant_guard();
create trigger clm_queries_tenant    before insert on clm_queries        for each row execute function clm_child_tenant_guard();
create trigger clm_settle_tenant     before insert on clm_settlements    for each row execute function clm_child_tenant_guard();
create trigger clm_disallow_tenant   before insert on clm_disallowances  for each row execute function clm_child_tenant_guard();
create trigger clm_preauths_tenant   before insert on clm_preauths       for each row execute function clm_child_tenant_guard();
create trigger clm_events_tenant     before insert on clm_events         for each row execute function clm_child_tenant_guard();
create trigger clm_notif_tenant      before insert on clm_notifications  for each row execute function clm_child_tenant_guard();

-- ─── Documents: verification is recorded and audited ────────────────

-- A new file is always 'uploaded'. Only a later, audited update marks it
-- valid, so nobody can upload and self-certify in one step.
create or replace function clm_documents_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.status := 'uploaded';
  new.verified_by := null;
  new.verified_at := null;
  new.uploaded_by := coalesce(auth.uid(), new.uploaded_by);
  return new;
end $$;

create trigger clm_documents_bi before insert on clm_documents
for each row execute function clm_documents_before_insert();


create or replace function clm_documents_before_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.claim_id <> old.claim_id or new.tenant_id <> old.tenant_id or new.file_path <> old.file_path then
    raise exception 'Document identity and file are immutable — upload a new version' using errcode = 'check_violation';
  end if;
  if new.status is distinct from old.status then
    if new.status = 'invalid' and coalesce(trim(new.review_note), '') = '' then
      raise exception 'Say why the document was rejected' using errcode = 'check_violation';
    end if;
    new.verified_by := auth.uid();
    new.verified_at := now();
    insert into clm_events (tenant_id, claim_id, event_type, payload, actor_id)
    values (new.tenant_id, new.claim_id,
            case new.status when 'valid' then 'doc_verified' when 'invalid' then 'doc_rejected' else 'doc_reset' end,
            jsonb_build_object('document_id', new.id, 'doc_code', new.doc_code, 'name', new.document_name, 'note', new.review_note),
            auth.uid());
  end if;
  return new;
end $$;

create trigger clm_documents_bu before update on clm_documents
for each row execute function clm_documents_before_update();

-- ─── Queries: numbering, SLA, claim counters ────────────────────────

create or replace function clm_queries_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_tat int;
begin
  perform 1 from clm_claims where id = new.claim_id for update;   -- serialise numbering per claim
  select coalesce(max(query_number), 0) + 1 into new.query_number from clm_queries where claim_id = new.claim_id;
  if new.sla_deadline is null then
    select p.query_tat_hours into v_tat from clm_claims c join clm_payers p on p.id = c.payer_id where c.id = new.claim_id;
    new.sla_deadline := new.raised_at + make_interval(hours => coalesce(v_tat, 48));
  end if;
  return new;
end $$;

create trigger clm_queries_bi before insert on clm_queries
for each row execute function clm_queries_before_insert();

create or replace function clm_queries_before_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'responded' and old.status <> 'responded' then
    if coalesce(trim(new.response_text), '') = '' then
      raise exception 'A response needs text' using errcode = 'check_violation';
    end if;
    new.responded_at := now();
    new.responded_by := auth.uid();
  end if;
  return new;
end $$;

create trigger clm_queries_bu before update on clm_queries
for each row execute function clm_queries_before_update();

create or replace function clm_queries_sync_claim() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update clm_claims c set
    query_count      = (select count(*) from clm_queries q where q.claim_id = c.id),
    is_query_pending = exists (select 1 from clm_queries q where q.claim_id = c.id
                                 and q.status in ('open','in_progress','escalated'))
  where c.id = new.claim_id;
  return null;
end $$;

create trigger clm_queries_ai after insert or update on clm_queries
for each row execute function clm_queries_sync_claim();

-- ─── Settlement (atomic; runs with the caller's RLS) ────────────────

create or replace function clm_record_settlement(
  p_claim_id      uuid,
  p_approved      numeric,
  p_tds           numeric,
  p_net           numeric,
  p_utr           text,
  p_payment_date  date,
  p_payment_mode  text default 'neft',
  p_disallowances jsonb default '[]'::jsonb   -- [{category, amount, reason_text}]
) returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  c clm_claims%rowtype;
  v_claimed numeric; v_deduction numeric; v_items numeric; v_id uuid; d jsonb;
begin
  select * into c from clm_claims where id = p_claim_id for update;
  if not found then raise exception 'Claim not found' using errcode = 'no_data_found'; end if;
  if c.status not in ('claim_approved','claim_partial','settlement_pending') then
    raise exception 'Claim is %, not ready for settlement', c.status using errcode = 'check_violation';
  end if;

  v_claimed := coalesce(c.claimed_amount, c.estimated_amount);
  if v_claimed is null then raise exception 'Claimed amount missing' using errcode = 'check_violation'; end if;
  if p_approved < 0 or p_tds < 0 or p_net < 0 then raise exception 'Amounts cannot be negative' using errcode = 'check_violation'; end if;
  if p_approved > v_claimed then
    raise exception 'Approved ₹% exceeds claimed ₹%', p_approved, v_claimed using errcode = 'check_violation';
  end if;
  if abs((p_approved - p_tds) - p_net) > 1 then
    raise exception 'Net ₹% ≠ approved ₹% − TDS ₹%', p_net, p_approved, p_tds using errcode = 'check_violation';
  end if;

  v_deduction := v_claimed - p_approved;
  select coalesce(sum((x->>'amount')::numeric), 0) into v_items
  from jsonb_array_elements(coalesce(p_disallowances, '[]'::jsonb)) x;
  if jsonb_array_length(coalesce(p_disallowances, '[]'::jsonb)) > 0 and abs(v_items - v_deduction) > 1 then
    raise exception 'Itemised deductions ₹% do not add up to the total deduction ₹%', v_items, v_deduction
      using errcode = 'check_violation';
  end if;

  insert into clm_settlements (tenant_id, claim_id, claimed_amount, approved_amount, deduction_amount,
                               tds_amount, net_amount, utr_number, payment_date, payment_mode, recorded_by)
  values (c.tenant_id, c.id, v_claimed, p_approved, v_deduction, p_tds, p_net,
          nullif(trim(p_utr), ''), p_payment_date, coalesce(p_payment_mode, 'neft'), auth.uid())
  returning id into v_id;

  for d in select * from jsonb_array_elements(coalesce(p_disallowances, '[]'::jsonb)) loop
    insert into clm_disallowances (tenant_id, claim_id, kind, category, amount, reason_text, recorded_by)
    values (c.tenant_id, c.id, 'deduction', d->>'category', (d->>'amount')::numeric, d->>'reason_text', auth.uid());
  end loop;

  update clm_claims set
    approved_amount  = p_approved,
    settled_amount   = p_net,
    tds_amount       = p_tds,
    deduction_amount = v_deduction,
    settlement_utr   = nullif(trim(p_utr), ''),
    settlement_date  = p_payment_date,
    status           = 'settled'
  where id = c.id;

  return v_id;
end $$;

-- ─── Bot: no service key. The bot is a normal user with role 'bot'. ─
-- It may read claims in its centres and apply portal results through
-- this function only; every status move still passes the triggers above.

create or replace function clm_bot_apply(
  p_claim_id   uuid,
  p_to_status  text default null,
  p_fields     jsonb default '{}'::jsonb,   -- tpa_claim_number, tpa_preauth_number, approved_amount
  p_note       text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare c clm_claims%rowtype;
begin
  if clm_current_role() <> 'bot' then
    raise exception 'Only the bot account may call clm_bot_apply' using errcode = 'insufficient_privilege';
  end if;
  select * into c from clm_claims where id = p_claim_id for update;
  if not found or c.tenant_id <> clm_current_tenant() or not clm_can_access_centre(c.centre_id) then
    raise exception 'Claim not found' using errcode = 'no_data_found';
  end if;
  if p_fields - array['tpa_claim_number','tpa_preauth_number','approved_amount'] <> '{}'::jsonb then
    raise exception 'Bot may only set tpa_claim_number, tpa_preauth_number, approved_amount' using errcode = 'insufficient_privilege';
  end if;
  perform set_config('claimone.source', 'bot', true);
  perform set_config('claimone.note', coalesce(p_note, ''), true);
  update clm_claims set
    tpa_claim_number   = coalesce(p_fields->>'tpa_claim_number', tpa_claim_number),
    tpa_preauth_number = coalesce(p_fields->>'tpa_preauth_number', tpa_preauth_number),
    approved_amount    = coalesce((p_fields->>'approved_amount')::numeric, approved_amount),
    status             = coalesce(p_to_status, status)
  where id = p_claim_id;
end $$;

-- ─── Transition with an audit note (used by the API route) ──────────

create or replace function clm_transition(
  p_claim_id uuid, p_to_status text, p_fields jsonb default '{}'::jsonb, p_note text default null
) returns clm_claims
language plpgsql security invoker set search_path = public as $$
declare r clm_claims%rowtype;
begin
  if not clm_can_write() then
    raise exception 'Read-only access' using errcode = 'insufficient_privilege';
  end if;
  if p_fields - array['approved_amount','claimed_amount','tpa_claim_number','tpa_preauth_number','notes'] <> '{}'::jsonb then
    raise exception 'Unsupported fields in transition' using errcode = 'check_violation';
  end if;
  perform set_config('claimone.note', coalesce(p_note, ''), true);
  update clm_claims set
    approved_amount    = coalesce((p_fields->>'approved_amount')::numeric, approved_amount),
    claimed_amount     = coalesce((p_fields->>'claimed_amount')::numeric, claimed_amount),
    tpa_claim_number   = coalesce(p_fields->>'tpa_claim_number', tpa_claim_number),
    tpa_preauth_number = coalesce(p_fields->>'tpa_preauth_number', tpa_preauth_number),
    notes              = coalesce(p_fields->>'notes', notes),
    status             = p_to_status
  where id = p_claim_id
  returning * into r;
  if not found then raise exception 'Claim not found' using errcode = 'no_data_found'; end if;
  return r;
end $$;

-- ════════════════════════════════════════════════════════════════════
-- Row-level security
-- ════════════════════════════════════════════════════════════════════

alter table clm_tenants            enable row level security;
alter table clm_centres            enable row level security;
alter table clm_user_profiles      enable row level security;
alter table clm_payers             enable row level security;
alter table clm_claims             enable row level security;
alter table clm_preauths           enable row level security;
alter table clm_doc_rules          enable row level security;
alter table clm_documents          enable row level security;
alter table clm_queries            enable row level security;
alter table clm_settlements        enable row level security;
alter table clm_disallowances      enable row level security;
alter table clm_state_transitions  enable row level security;
alter table clm_events             enable row level security;
alter table clm_notifications      enable row level security;
alter table clm_bot_runs           enable row level security;
alter table clm_counters           enable row level security;
alter table clm_allowed_transitions enable row level security;

create policy tenants_read   on clm_tenants   for select using (id = clm_current_tenant());
create policy centres_read   on clm_centres   for select using (tenant_id = clm_current_tenant() and clm_can_access_centre(id));
create policy profiles_self  on clm_user_profiles for select
  using (user_id = auth.uid() or (tenant_id = clm_current_tenant() and clm_current_role() = 'admin'));
create policy transitions_rules_read on clm_allowed_transitions for select using (auth.uid() is not null);

create policy payers_read  on clm_payers for select using (tenant_id is null or tenant_id = clm_current_tenant());
create policy payers_write on clm_payers for all
  using (tenant_id = clm_current_tenant() and clm_current_role() = 'admin')
  with check (tenant_id = clm_current_tenant() and clm_current_role() = 'admin');

create policy rules_read  on clm_doc_rules for select using (tenant_id is null or tenant_id = clm_current_tenant());
create policy rules_write on clm_doc_rules for all
  using (tenant_id = clm_current_tenant() and clm_current_role() in ('admin','manager'))
  with check (tenant_id = clm_current_tenant() and clm_current_role() in ('admin','manager'));

-- Claims: read in your centres; write as desk/manager/admin. The bot reads
-- but writes only through clm_bot_apply. No deletes for anyone.
create policy claims_read on clm_claims for select
  using (tenant_id = clm_current_tenant() and clm_can_access_centre(centre_id));
create policy claims_insert on clm_claims for insert
  with check (tenant_id = clm_current_tenant() and clm_can_access_centre(centre_id) and clm_can_write());
create policy claims_update on clm_claims for update
  using (tenant_id = clm_current_tenant() and clm_can_access_centre(centre_id) and clm_can_write())
  with check (tenant_id = clm_current_tenant() and clm_can_access_centre(centre_id));

create policy docs_read   on clm_documents for select using (clm_can_see_claim(claim_id));
create policy docs_insert on clm_documents for insert with check (clm_can_see_claim(claim_id) and clm_current_role() in ('admin','manager','desk','bot'));
create policy docs_update on clm_documents for update using (clm_can_see_claim(claim_id) and clm_can_write());

create policy queries_read   on clm_queries for select using (clm_can_see_claim(claim_id));
create policy queries_insert on clm_queries for insert with check (clm_can_see_claim(claim_id) and clm_current_role() in ('admin','manager','desk','bot'));
create policy queries_update on clm_queries for update using (clm_can_see_claim(claim_id) and clm_can_write());

create policy preauths_read  on clm_preauths for select using (clm_can_see_claim(claim_id));
create policy preauths_write on clm_preauths for insert with check (clm_can_see_claim(claim_id) and clm_can_write());

create policy settle_read   on clm_settlements for select using (clm_can_see_claim(claim_id));
create policy settle_insert on clm_settlements for insert with check (clm_can_see_claim(claim_id) and clm_can_write());

create policy disallow_read   on clm_disallowances for select using (clm_can_see_claim(claim_id));
create policy disallow_insert on clm_disallowances for insert with check (clm_can_see_claim(claim_id) and clm_can_write());

create policy transitions_read on clm_state_transitions for select using (clm_can_see_claim(claim_id));
create policy events_read      on clm_events for select using (clm_can_see_claim(claim_id));
create policy events_insert    on clm_events for insert with check (clm_can_see_claim(claim_id));
create policy notif_read       on clm_notifications for select using (clm_can_see_claim(claim_id));
create policy notif_insert     on clm_notifications for insert with check (clm_can_see_claim(claim_id) and clm_can_write());

create policy botruns_read   on clm_bot_runs for select using (tenant_id = clm_current_tenant() and clm_can_access_centre(centre_id));
create policy botruns_insert on clm_bot_runs for insert
  with check (tenant_id = clm_current_tenant() and clm_can_access_centre(centre_id) and clm_current_role() = 'bot');
create policy botruns_update on clm_bot_runs for update
  using (tenant_id = clm_current_tenant() and clm_current_role() = 'bot');

-- clm_counters: no policies → only reachable through the security-definer trigger.

grant execute on function clm_record_settlement(uuid, numeric, numeric, numeric, text, date, text, jsonb) to authenticated;
grant execute on function clm_transition(uuid, text, jsonb, text) to authenticated;
grant execute on function clm_bot_apply(uuid, text, jsonb, text) to authenticated;
grant execute on function clm_unmet_mandatory_docs(uuid, text) to authenticated;
revoke execute on function clm_record_settlement(uuid, numeric, numeric, numeric, text, date, text, jsonb) from anon;
revoke execute on function clm_transition(uuid, text, jsonb, text) from anon;
revoke execute on function clm_bot_apply(uuid, text, jsonb, text) from anon;
revoke execute on function clm_unmet_mandatory_docs(uuid, text) from anon;
