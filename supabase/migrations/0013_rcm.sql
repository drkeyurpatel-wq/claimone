-- ════════════════════════════════════════════════════════════════════
-- Full RCM: every credit admission becomes a case (a clm_claims row)
-- from the daily eCW export or by hand; payers know how they are reached
-- (NHCX, portal, email, TMS, direct); desk users get a workspace; and
-- every NHCX message in or out is logged.
-- ════════════════════════════════════════════════════════════════════

-- ─── Payers: how each one is reached ─────────────────────────────────
alter table clm_payers add column if not exists channel text not null default 'portal'
  check (channel in ('portal','email','tms','direct'));
alter table clm_payers add column if not exists nhcx_code text;   -- participant code once the payer is live on NHCX
comment on column clm_payers.channel is 'How claims go when the payer is not live on NHCX';

update clm_payers set channel = 'tms' where code like 'pmjay%';

insert into clm_payers (tenant_id, code, name, type, channel)
select null, v.code, v.name, v.type, v.channel
from (values
  ('esic',             'ESIC',                                   'government', 'portal'),
  ('pgvcl',            'PGVCL (Paschim Gujarat Vij Company)',    'corporate',  'direct'),
  ('ugvcl',            'UGVCL (Uttar Gujarat Vij Company)',      'corporate',  'direct'),
  ('volo',             'Volo Health Insurance TPA',              'tpa',        'portal'),
  ('medsave',          'Medsave Health Insurance TPA',           'tpa',        'portal'),
  ('genins',           'Genins India Insurance TPA',             'tpa',        'portal'),
  ('hitpa',            'Health Insurance TPA of India',          'tpa',        'portal'),
  ('universal_sompo',  'Universal Sompo General Insurance',      'insurer',    'portal'),
  ('generali_central', 'Generali Central Insurance',             'insurer',    'portal'),
  ('cholamandalam',    'Cholamandalam MS General Insurance',     'insurer',    'portal'),
  ('iffco_tokio',      'IFFCO Tokio General Insurance',          'insurer',    'portal')
) v(code, name, type, channel)
where not exists (select 1 from clm_payers p where p.tenant_id is null and p.code = v.code);

-- ─── Sponsor names in eCW → payer ────────────────────────────────────
-- Platform rows (tenant_id null) cover the names already seen; each
-- hospital adds its own when the upload finds a new name.
create table clm_sponsor_map (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid references clm_tenants(id),
  sponsor_key text not null check (sponsor_key = upper(sponsor_key) and length(sponsor_key) between 1 and 120),
  payer_code  text,                      -- platform payer code; 'pmjay' = the centre's state scheme
  payer_id    uuid references clm_payers(id),
  is_credit   boolean not null,
  created_by  uuid references auth.users(id) default auth.uid(),
  created_at  timestamptz not null default now(),
  check (not is_credit or payer_code is not null or payer_id is not null)
);
create unique index clm_sponsor_map_uq on clm_sponsor_map (coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), sponsor_key);

alter table clm_sponsor_map enable row level security;
create policy sponsor_read on clm_sponsor_map for select using (tenant_id is null or tenant_id = clm_current_tenant());
create policy sponsor_write on clm_sponsor_map for insert
  with check (tenant_id = clm_current_tenant() and clm_can_write());
create policy sponsor_update on clm_sponsor_map for update
  using (tenant_id = clm_current_tenant() and clm_current_role() in ('admin','manager'))
  with check (tenant_id = clm_current_tenant());
revoke all on clm_sponsor_map from anon;
grant select, insert, update on clm_sponsor_map to authenticated;

create or replace function clm_sponsor_key(p text) returns text
language sql immutable set search_path = public as $$
  select nullif(upper(regexp_replace(trim(coalesce(p, '')), '\s+', ' ', 'g')), '')
$$;

insert into clm_sponsor_map (tenant_id, sponsor_key, payer_code, is_credit) values
  (null, 'PMJAY', 'pmjay', true), (null, 'MA', 'pmjay', true), (null, 'MAA', 'pmjay', true),
  (null, 'CASH', null, false), (null, 'SELF', null, false), (null, 'CGHS - CASH', null, false), (null, 'H1TKR', null, false),
  (null, 'MEDI ASSIST', 'medi_assist', true), (null, 'MD INDIA', 'mdindia', true),
  (null, 'CARE HEALTH INSURANCE', 'care_health', true), (null, 'VIDAL HEALTH', 'vidal', true),
  (null, 'BAJAJ ALLIANZ', 'bajaj_allianz', true), (null, 'ECHS', 'echs', true), (null, 'CGHS', 'cghs', true),
  (null, 'ADITYA BIRLA', 'aditya_birla', true), (null, 'HDFC ERGO', 'hdfc_ergo', true),
  (null, 'VOLO HEALTH INSURANCE TPA', 'volo', true), (null, 'MEDSAVE', 'medsave', true),
  (null, 'HERITAGE TPA', 'heritage', true), (null, 'HEALTH INDIA', 'health_india', true),
  (null, 'PARAMOUNT HEALTH TPA', 'paramount', true), (null, 'STAR HEALTH INSURANCE', 'star_health', true),
  (null, 'RELIANCE GENERAL INSURANCE', 'reliance_general', true),
  (null, 'UNIVERSAL SOMPO GENERAL INSURANCE', 'universal_sompo', true),
  (null, 'SBI GENERAL INSURANCE', 'sbi_general', true), (null, 'PGVCL', 'pgvcl', true), (null, 'UGVCL', 'ugvcl', true),
  (null, 'FHPL', 'fhpl', true), (null, 'NIVA BUPA HEALTH INSURANCE', 'niva_bupa', true),
  (null, 'TATA AIG', 'tata_aig', true), (null, 'GENINS TPA', 'genins', true), (null, 'ERICSON TPA', 'ericson', true),
  (null, 'GENERALI CENTRAL INSURANCE', 'generali_central', true), (null, 'CHOLAMANDLAM', 'cholamandalam', true),
  (null, 'IFFCO TOKIO', 'iffco_tokio', true), (null, 'ESIC', 'esic', true),
  (null, 'ICICI LOMBARD', 'icici_lombard', true), (null, 'NEW INDIA ASSURANCE', 'new_india', true),
  (null, 'NATIONAL INSURANCE', 'national', true), (null, 'ORIENTAL INSURANCE', 'oriental', true),
  (null, 'UNITED INDIA INSURANCE', 'united_india', true), (null, 'MANIPAL CIGNA', 'manipal_cigna', true),
  (null, 'GOOD HEALTH TPA', 'good_health', true), (null, 'PARK MEDICLAIM', 'park_mediclaim', true),
  (null, 'RAKSHA TPA', 'raksha', true), (null, 'SAFEWAY TPA', 'safeway', true);

-- the payer behind a sponsor name for this centre: null = unknown name,
-- o_credit false = cash / self pay
create or replace function clm_payer_for_sponsor(p_tenant uuid, p_centre uuid, p_sponsor text,
                                                  out o_known boolean, out o_credit boolean, out o_payer uuid)
language plpgsql stable security invoker set search_path = public as $$
declare m clm_sponsor_map%rowtype;
begin
  select * into m from clm_sponsor_map
  where sponsor_key = clm_sponsor_key(p_sponsor) and (tenant_id = p_tenant or tenant_id is null)
  order by tenant_id nulls last limit 1;
  o_known := found;
  if not found then return; end if;
  o_credit := m.is_credit;
  if not m.is_credit then return; end if;
  o_payer := m.payer_id;
  if o_payer is null and m.payer_code = 'pmjay' then
    select py.id into o_payer from clm_payers py, clm_centres c
    where c.id = p_centre and py.tenant_id is null
      and py.code = case when c.state ilike 'rajasthan' then 'pmjay_rajasthan' else 'pmjay_gujarat' end;
  elsif o_payer is null then
    select id into o_payer from clm_payers where code = m.payer_code and (tenant_id = p_tenant or tenant_id is null)
    order by tenant_id nulls last limit 1;
  end if;
  if o_payer is null then o_known := false; end if;
end $$;

-- staff teach a new sponsor name once
create or replace function clm_map_sponsor(p_sponsor text, p_payer uuid, p_credit boolean) returns void
language plpgsql security invoker set search_path = public as $$
declare t uuid := clm_current_tenant(); k text := clm_sponsor_key(p_sponsor);
begin
  if t is null or not clm_can_write() then raise exception 'Read-only access' using errcode = 'insufficient_privilege'; end if;
  if k is null then raise exception 'Sponsor name is empty' using errcode = 'check_violation'; end if;
  if p_credit and (p_payer is null or not exists (select 1 from clm_payers where id = p_payer and (tenant_id is null or tenant_id = t))) then
    raise exception 'Pick the payer for this sponsor' using errcode = 'check_violation';
  end if;
  if exists (select 1 from clm_sponsor_map where tenant_id = t and sponsor_key = k) then
    if clm_current_role() not in ('admin','manager') then
      raise exception 'This sponsor is already set — ask a manager to change it' using errcode = 'insufficient_privilege';
    end if;
    update clm_sponsor_map set payer_id = case when p_credit then p_payer end, is_credit = p_credit, payer_code = null
    where tenant_id = t and sponsor_key = k;
  else
    insert into clm_sponsor_map (tenant_id, sponsor_key, payer_id, is_credit)
    values (t, k, case when p_credit then p_payer end, p_credit);
  end if;
end $$;

-- ─── Centres: NHCX identity ──────────────────────────────────────────
alter table clm_centres add column if not exists hfr_id text;
alter table clm_centres add column if not exists nhcx_participant_code text;
create unique index if not exists clm_centres_nhcx_uq on clm_centres (nhcx_participant_code) where nhcx_participant_code is not null;

-- ─── Cases: admission facts from the HMIS ────────────────────────────
alter table clm_claims add column if not exists case_source     text not null default 'manual' check (case_source in ('manual','ecw','hmis'));
alter table clm_claims add column if not exists admitted_at     timestamptz;
alter table clm_claims add column if not exists intimated_at    timestamptz;
alter table clm_claims add column if not exists discharged_at   timestamptz;
alter table clm_claims add column if not exists bill_no         text;
alter table clm_claims add column if not exists bill_amount     numeric(12,2) check (bill_amount >= 0);
alter table clm_claims add column if not exists discount_amount numeric(12,2) check (discount_amount >= 0);
alter table clm_claims add column if not exists patient_paid    numeric(12,2) check (patient_paid >= 0);
alter table clm_claims add column if not exists bed_category    text;
alter table clm_claims add column if not exists sponsor_name    text;
comment on column clm_claims.bill_no is 'PHI-adjacent: hospital bill number';

-- one case per admission per centre
create unique index if not exists clm_claims_admission_uq on clm_claims (centre_id, upper(admission_ref)) where admission_ref is not null;

alter table clm_import_batches drop constraint if exists clm_import_batches_kind_check;
alter table clm_import_batches add constraint clm_import_batches_kind_check
  check (kind in ('bank_statement','cashless_tracker','settlement_advice','patient_dues','receivables','weekly_payments','ecw_cases'));

create or replace function clm_claim_type_for(p_payer uuid) returns text
language sql stable set search_path = public as $$
  select case
    when code like 'pmjay%' then 'pmjay'
    when code = 'cghs' then 'cghs'
    when code = 'echs' then 'echs'
    when code = 'esic' then 'state_scheme'
    when type = 'corporate' then 'corporate'
    else 'cashless' end
  from clm_payers where id = p_payer
$$;

-- Daily eCW export → cases. Keyed on IP No.; never changes a status.
-- Rows: ip_no, uhid, patient_name, phone, admitted_at, intimated_at, discharged_at,
-- bill_no, bill_date, sponsor, doctor, specialisation, bed_category,
-- bill_amount, discount_amount, net_amount, paid_amount, estimated_amount.
create or replace function clm_import_cases(p_centre uuid, p_file text, p_rows jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  t uuid := clm_current_tenant();
  r jsonb; batch uuid; c clm_claims%rowtype; sp record; cid uuid;
  ip text; net numeric; paid numeric; owed numeric; dis timestamptz; adm timestamptz;
  n_new int := 0; n_upd int := 0; n_cash int := 0; n_skip int := 0; n_bills int := 0;
  unknown text[] := '{}';
  open_status text[] := array['draft','preauth_pending','preauth_query','preauth_approved','preauth_enhanced','preauth_rejected'];
begin
  if t is null or not clm_can_write() then raise exception 'Read-only access' using errcode = 'insufficient_privilege'; end if;
  if not clm_can_access_centre(p_centre) or not exists (select 1 from clm_centres where id = p_centre and tenant_id = t) then
    raise exception 'No access to this centre' using errcode = 'insufficient_privilege';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then
    raise exception 'Send at most 5000 rows at a time' using errcode = 'check_violation';
  end if;

  insert into clm_import_batches (tenant_id, centre_id, kind, file_name, row_count)
  values (t, p_centre, 'ecw_cases', left(coalesce(p_file, 'upload'), 300), jsonb_array_length(p_rows)) returning id into batch;

  for r in select * from jsonb_array_elements(p_rows) loop
    ip := nullif(trim(r->>'ip_no'), '');
    if ip is null or nullif(trim(r->>'patient_name'), '') is null then n_skip := n_skip + 1; continue; end if;

    select * into sp from clm_payer_for_sponsor(t, p_centre, r->>'sponsor');
    if not sp.o_known then
      if clm_sponsor_key(r->>'sponsor') is not null and not (clm_sponsor_key(r->>'sponsor') = any(unknown)) then
        unknown := unknown || clm_sponsor_key(r->>'sponsor');
      end if;
      n_skip := n_skip + 1; continue;
    end if;
    if not sp.o_credit then n_cash := n_cash + 1; continue; end if;

    net  := nullif(r->>'net_amount', '')::numeric;
    paid := coalesce(nullif(r->>'paid_amount', '')::numeric, 0);
    owed := case when net is not null and nullif(r->>'bill_no', '') is not null then greatest(net - paid, 0) end;
    adm  := nullif(r->>'admitted_at', '')::timestamptz;
    dis  := nullif(r->>'discharged_at', '')::timestamptz;

    select * into c from clm_claims where centre_id = p_centre and upper(admission_ref) = upper(ip);
    if not found then
      insert into clm_claims (tenant_id, centre_id, payer_id, claim_type, patient_name, patient_phone, patient_uhid,
                              admission_ref, treating_doctor_name, department_name, admission_date, discharge_date,
                              admitted_at, intimated_at, discharged_at, estimated_amount, claimed_amount,
                              bill_no, bill_amount, discount_amount, patient_paid, bed_category, sponsor_name, case_source)
      values (t, p_centre, sp.o_payer, clm_claim_type_for(sp.o_payer), left(trim(r->>'patient_name'), 200),
              nullif(r->>'phone', ''), nullif(r->>'uhid', ''), ip, nullif(r->>'doctor', ''), nullif(r->>'specialisation', ''),
              adm::date, dis::date, adm, nullif(r->>'intimated_at', '')::timestamptz, dis,
              nullif(r->>'estimated_amount', '')::numeric, owed,
              nullif(r->>'bill_no', ''), nullif(r->>'bill_amount', '')::numeric, nullif(r->>'discount_amount', '')::numeric,
              paid, nullif(r->>'bed_category', ''), left(r->>'sponsor', 120), 'ecw')
      returning * into c;
      n_new := n_new + 1;
    else
      update clm_claims set
        payer_id      = case when status = 'draft' then sp.o_payer else payer_id end,
        claim_type    = case when status = 'draft' then clm_claim_type_for(sp.o_payer) else claim_type end,
        discharge_date = coalesce(dis::date, discharge_date),
        discharged_at = coalesce(dis, discharged_at),
        intimated_at  = coalesce(intimated_at, nullif(r->>'intimated_at', '')::timestamptz),
        bill_no       = coalesce(nullif(r->>'bill_no', ''), bill_no),
        bill_amount   = coalesce(nullif(r->>'bill_amount', '')::numeric, bill_amount),
        discount_amount = coalesce(nullif(r->>'discount_amount', '')::numeric, discount_amount),
        patient_paid  = coalesce(nullif(r->>'paid_amount', '')::numeric, patient_paid),
        claimed_amount = case when owed is not null and status = any(open_status) then owed else claimed_amount end,
        treating_doctor_name = coalesce(treating_doctor_name, nullif(r->>'doctor', '')),
        sponsor_name  = left(r->>'sponsor', 120)
      where id = c.id
      returning * into c;
      n_upd := n_upd + 1;
    end if;

    -- a final bill is money owed: put it on the receivables book once
    if owed is not null and owed > 0
       and not exists (select 1 from clm_receivables where claim_id = c.id and debtor_type <> 'patient') then
      insert into clm_receivables (tenant_id, centre_id, claim_id, debtor_type, payer_id, debtor_name, bill_no, ip_no, uhid,
                                   bill_date, patient_name, doctor_name, billed_amount, expected_amount, source, import_batch_id, notes)
      select t, p_centre, c.id,
             case py.type when 'government' then 'government' when 'corporate' then 'corporate' when 'tpa' then 'tpa' else 'insurer' end,
             py.id, py.name, c.bill_no, ip, c.patient_uhid,
             coalesce(nullif(r->>'bill_date', '')::date, dis::date, current_date), c.patient_name, c.treating_doctor_name,
             nullif(r->>'bill_amount', '')::numeric, owed, 'claim', batch, 'From eCW export'
      from clm_payers py where py.id = c.payer_id
      on conflict (tenant_id, centre_id, debtor_type, bill_no)
        do update set claim_id = coalesce(clm_receivables.claim_id, excluded.claim_id);
      n_bills := n_bills + 1;
    end if;
  end loop;

  return jsonb_build_object('batch_id', batch, 'created', n_new, 'updated', n_upd, 'cash', n_cash,
                            'skipped', n_skip, 'bills', n_bills, 'unknown_sponsors', to_jsonb(unknown));
end $$;

-- ─── Desk workspaces ─────────────────────────────────────────────────
-- admission = pre-auth desk, claims = discharge/claims desk, payments = upload + check list.
-- null: managers see everything; desk users with no workspace keep the payments screens.
alter table clm_user_profiles add column if not exists workspace text check (workspace in ('admission','claims','payments'));

-- ─── NHCX message log ────────────────────────────────────────────────
create table clm_nhcx_messages (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references clm_tenants(id),
  centre_id      uuid not null references clm_centres(id),
  claim_id       uuid references clm_claims(id),
  direction      text not null check (direction in ('out','in')),
  api_call       text not null check (api_call in ('coverageeligibility','preauth','claim','communication','paymentnotice','status','predetermination')),
  action         text not null check (action in ('request','on_request','on_check','on_submit','on_status','on_notice','on_eligibility')),
  api_call_id    text not null,
  correlation_id text not null,
  workflow_id    text,
  sender_code    text,
  recipient_code text,
  status         text not null default 'queued' check (status in ('queued','sent','accepted','error','received','applied','ignored')),
  http_status    int,
  error          text check (length(error) <= 500),
  summary        jsonb not null default '{}'::jsonb,   -- outcome, amounts, reference numbers — no patient details
  payload        text check (length(payload) <= 8000000), -- the JWE as sent/received (encrypted)
  created_by     uuid references auth.users(id) default auth.uid(),
  created_at     timestamptz not null default now(),
  handled_by     uuid references auth.users(id),
  handled_at     timestamptz,
  unique (direction, api_call_id)
);
comment on column clm_nhcx_messages.payload is 'PHI (encrypted JWE): claim bundle as exchanged';
create index clm_nhcx_corr on clm_nhcx_messages (correlation_id);
create index clm_nhcx_claim on clm_nhcx_messages (claim_id, created_at);

alter table clm_nhcx_messages enable row level security;
create policy nhcx_read on clm_nhcx_messages for select
  using (tenant_id = clm_current_tenant() and clm_can_access_centre(centre_id));
create policy nhcx_out on clm_nhcx_messages for insert
  with check (tenant_id = clm_current_tenant() and clm_can_access_centre(centre_id) and clm_can_write()
              and direction = 'out' and (claim_id is null or clm_can_see_claim(claim_id)));
create policy nhcx_update on clm_nhcx_messages for update
  using (tenant_id = clm_current_tenant() and clm_can_access_centre(centre_id) and clm_can_write())
  with check (tenant_id = clm_current_tenant() and clm_can_access_centre(centre_id));
revoke all on clm_nhcx_messages from anon;
grant select, insert, update on clm_nhcx_messages to authenticated;

-- after insert only the delivery result and who handled a reply may change
create or replace function clm_nhcx_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (to_jsonb(new) - array['status','http_status','error','handled_by','handled_at','summary'])
     <> (to_jsonb(old) - array['status','http_status','error','handled_by','handled_at','summary']) then
    raise exception 'An NHCX message cannot be changed' using errcode = 'check_violation';
  end if;
  if old.direction = 'in' and new.summary <> old.summary then
    raise exception 'A received NHCX message cannot be changed' using errcode = 'check_violation';
  end if;
  if new.handled_at is distinct from old.handled_at then new.handled_by := auth.uid(); end if;
  return new;
end $$;
create trigger clm_nhcx_bu before update on clm_nhcx_messages for each row execute function clm_nhcx_guard();

-- Callback secret: the NHCX callback route (anon key, no user) proves itself
-- with a shared secret whose hash lives here. Nobody can read this table.
create table clm_nhcx_secrets (
  centre_id   uuid primary key references clm_centres(id),
  secret_hash text not null check (secret_hash ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz not null default now()
);
alter table clm_nhcx_secrets enable row level security;
revoke all on clm_nhcx_secrets from anon, authenticated;

-- an admin sets the centre's callback secret (stored hashed)
create or replace function clm_set_nhcx_secret(p_centre uuid, p_secret text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if clm_current_role() is distinct from 'admin'
     or not exists (select 1 from clm_centres where id = p_centre and tenant_id = clm_current_tenant()) then
    raise exception 'Only an admin can set this' using errcode = 'insufficient_privilege';
  end if;
  if length(coalesce(p_secret, '')) < 32 then raise exception 'Secret too short' using errcode = 'check_violation'; end if;
  insert into clm_nhcx_secrets (centre_id, secret_hash) values (p_centre, encode(sha256(convert_to(p_secret, 'UTF8')), 'hex'))
  on conflict (centre_id) do update set secret_hash = excluded.secret_hash, created_at = now();
end $$;

-- An incoming NHCX message (on_* callback), already decrypted and checked by
-- the server route. Stored as received; staff apply it to the case.
create or replace function clm_nhcx_receive(p_secret text, p_msg jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare ctr clm_centres%rowtype; out_msg clm_nhcx_messages%rowtype; v_id uuid;
begin
  select c.* into ctr from clm_centres c join clm_nhcx_secrets s on s.centre_id = c.id
  where c.nhcx_participant_code = p_msg->>'recipient_code'
    and s.secret_hash = encode(sha256(convert_to(coalesce(p_secret, ''), 'UTF8')), 'hex');
  if not found then raise exception 'Not recognised' using errcode = 'insufficient_privilege'; end if;

  select * into out_msg from clm_nhcx_messages
  where correlation_id = p_msg->>'correlation_id' and direction = 'out' and centre_id = ctr.id
  order by created_at desc limit 1;

  insert into clm_nhcx_messages (tenant_id, centre_id, claim_id, direction, api_call, action, api_call_id, correlation_id,
                                 workflow_id, sender_code, recipient_code, status, summary, payload, created_by)
  values (ctr.tenant_id, ctr.id, out_msg.claim_id, 'in', p_msg->>'api_call', p_msg->>'action', p_msg->>'api_call_id',
          p_msg->>'correlation_id', p_msg->>'workflow_id', p_msg->>'sender_code', p_msg->>'recipient_code',
          'received', coalesce(p_msg->'summary', '{}'::jsonb), p_msg->>'payload', null)
  on conflict (direction, api_call_id) do nothing
  returning id into v_id;
  if out_msg.id is not null and v_id is not null then
    update clm_nhcx_messages set status = 'accepted' where id = out_msg.id and status in ('queued','sent');
  end if;
  return v_id;
end $$;

-- ─── Function grants ─────────────────────────────────────────────────
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'clm\_%' loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;
-- the one function the callback route (no user session) may call
grant execute on function clm_nhcx_receive(text, jsonb) to anon;
