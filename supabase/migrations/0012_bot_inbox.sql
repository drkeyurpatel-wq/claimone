-- ════════════════════════════════════════════════════════════════════
-- Bot inbox: payment statements the portal bot downloaded from TPA
-- websites. The bot only drops the file's rows here; staff see it on
-- "Upload payments" as a ready file and press Save themselves, so the bot
-- never writes to bills or payments.
-- ════════════════════════════════════════════════════════════════════

create table clm_bot_inbox (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references clm_tenants(id),
  centre_id    uuid not null references clm_centres(id),
  payer_id     uuid references clm_payers(id),
  source_label text not null,                 -- e.g. 'Medi Assist website'
  file_name    text not null,
  rows         jsonb not null,                -- the sheet as rows of text cells
  row_count    int not null,
  created_by   uuid references auth.users(id) default auth.uid(),
  created_at   timestamptz not null default now(),
  used_at      timestamptz,
  used_by      uuid references auth.users(id),
  check (jsonb_typeof(rows) = 'array' and row_count between 1 and 20000)
);
comment on column clm_bot_inbox.rows is 'PHI: payment statement rows (patient names, claim numbers)';
create index clm_bot_inbox_open on clm_bot_inbox (centre_id, created_at) where used_at is null;

-- the same statement downloaded twice is kept once
create unique index clm_bot_inbox_dedupe on clm_bot_inbox (tenant_id, centre_id, source_label, md5(rows::text));

alter table clm_bot_inbox enable row level security;
create policy inbox_read on clm_bot_inbox for select
  using (tenant_id = clm_current_tenant() and clm_can_access_centre(centre_id));
create policy inbox_bot_insert on clm_bot_inbox for insert
  with check (tenant_id = clm_current_tenant() and clm_can_access_centre(centre_id) and clm_current_role() = 'bot');
-- staff only mark a file as used
create policy inbox_mark_used on clm_bot_inbox for update
  using (tenant_id = clm_current_tenant() and clm_can_access_centre(centre_id) and clm_can_write())
  with check (tenant_id = clm_current_tenant() and clm_can_access_centre(centre_id));

create or replace function clm_bot_inbox_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (to_jsonb(new) - array['used_at','used_by']) <> (to_jsonb(old) - array['used_at','used_by']) then
    raise exception 'A downloaded statement cannot be changed' using errcode = 'check_violation';
  end if;
  new.used_by := auth.uid();
  return new;
end $$;
create trigger clm_bot_inbox_bu before update on clm_bot_inbox for each row execute function clm_bot_inbox_guard();

grant select, insert, update on clm_bot_inbox to authenticated;

-- bot runs: the new job
alter table clm_bot_runs drop constraint if exists clm_bot_runs_action_check;
alter table clm_bot_runs add constraint clm_bot_runs_action_check
  check (action in ('submit_preauth','submit_claim','check_status','download_letter','download_payments'));

revoke execute on function clm_bot_inbox_guard() from public, anon;
