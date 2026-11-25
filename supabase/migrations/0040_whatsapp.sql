-- ════════════════════════════════════════════════════════════════════
-- WhatsApp desk: papers sent on WhatsApp land on the patient's file, and
-- staff ask the assistant for a file's status or close a settled file.
-- The webhook signs in as a 'bot' user (anon key only, like the portal bot).
-- It may only: look up whether a mobile number is staff (clm_wa_staff),
-- keep a short-lived "close this file?" question (clm_wa_sessions), and
-- move a file with clm_bot_apply — every status rule still runs.
-- ════════════════════════════════════════════════════════════════════

create table if not exists clm_wa_sessions (
  tenant_id   uuid not null references clm_tenants(id),
  phone       text not null,                 -- 10-digit mobile of the staff member
  claim_id    uuid not null references clm_claims(id),
  action      text not null check (action in ('close')),
  staff_name  text not null,
  expires_at  timestamptz not null default now() + interval '15 minutes',
  created_at  timestamptz not null default now(),
  primary key (tenant_id, phone)
);
comment on column clm_wa_sessions.phone is 'PHI-adjacent: staff mobile';
alter table clm_wa_sessions enable row level security;
create policy wa_sessions_bot on clm_wa_sessions for all
  using (tenant_id = clm_current_tenant() and clm_current_role() = 'bot')
  with check (tenant_id = clm_current_tenant() and clm_current_role() = 'bot');

-- Is this mobile number a staff login in the bot's tenant? Name and role only.
create or replace function clm_wa_staff(p_mobile text)
returns table (full_name text, role text)
language plpgsql stable security definer set search_path = public as $$
begin
  if coalesce(clm_current_role(), '') <> 'bot' then
    raise exception 'Only the bot account may look up staff' using errcode = 'insufficient_privilege';
  end if;
  return query
    select p.full_name, p.role from clm_user_profiles p join auth.users u on u.id = p.user_id
    where p.tenant_id = clm_current_tenant() and p.is_active
      and lower(u.email) = clm_mobile_email(p_mobile)
      and p.role in ('admin', 'manager', 'desk', 'viewer')
    limit 1;
end $$;
revoke all on function clm_wa_staff(text) from public, anon;
grant execute on function clm_wa_staff(text) to authenticated;
