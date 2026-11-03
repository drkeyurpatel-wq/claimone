-- Staff create their own login with mobile number + 6-digit PIN.
-- A team code (shared by the hospital) is required, so only staff who have it can join.
-- The login is stored as <mobile>@claimone.local with the PIN as its password.

create table if not exists public.clm_join_codes (
  code       text primary key,
  tenant_id  uuid not null references clm_tenants(id),
  centre_id  uuid not null references clm_centres(id),
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.clm_join_codes enable row level security;
-- no policies: only the security-definer functions below read it
revoke all on public.clm_join_codes from anon, authenticated;

insert into public.clm_join_codes (code, tenant_id, centre_id)
select 'H1' || lpad((floor(random() * 10000))::int::text, 4, '0'), c.tenant_id, c.id
from clm_centres c join clm_tenants t on t.id = c.tenant_id
where t.code = 'health1' and c.code = 'SHJ'
  and not exists (select 1 from public.clm_join_codes j where j.centre_id = c.id and j.is_active);

create or replace function public.clm_mobile_email(p_mobile text)
returns text language sql immutable set search_path = public as $$
  select right(regexp_replace(coalesce(p_mobile, ''), '\D', '', 'g'), 10) || '@claimone.local'
$$;

create or replace function public.clm_self_register(p_name text, p_mobile text, p_pin text, p_desk text, p_code text)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  j clm_join_codes%rowtype;
  v_mobile text := right(regexp_replace(coalesce(p_mobile, ''), '\D', '', 'g'), 10);
  v_email text; v_uid uuid := gen_random_uuid(); v_name text := btrim(coalesce(p_name, ''));
begin
  if length(v_name) < 2 then raise exception 'Enter your full name' using errcode = 'check_violation'; end if;
  if v_mobile !~ '^[6-9][0-9]{9}$' then raise exception 'Enter a 10-digit mobile number' using errcode = 'check_violation'; end if;
  if coalesce(p_pin, '') !~ '^[0-9]{6}$' then raise exception 'PIN must be 6 digits' using errcode = 'check_violation'; end if;
  if p_pin ~ '^(.)\1{5}$' or p_pin in ('123456', '654321', '012345') then
    raise exception 'Choose a harder PIN' using errcode = 'check_violation';
  end if;
  if p_desk not in ('admission', 'claims', 'payments') then raise exception 'Choose your desk' using errcode = 'check_violation'; end if;
  select * into j from clm_join_codes where upper(code) = upper(btrim(coalesce(p_code, ''))) and is_active;
  if not found then raise exception 'Team code is wrong' using errcode = 'check_violation'; end if;

  v_email := v_mobile || '@claimone.local';
  if exists (select 1 from auth.users where lower(email) = v_email) then
    raise exception 'This mobile is already registered. Sign in instead.' using errcode = 'unique_violation';
  end if;

  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, recovery_token, email_change_token_new, email_change,
                          email_change_token_current, phone_change, phone_change_token, reauthentication_token,
                          is_sso_user, is_anonymous)
  values ('00000000-0000-0000-0000-000000000000', v_uid, 'authenticated', 'authenticated', v_email,
          crypt(p_pin, gen_salt('bf')), now(),
          '{"provider":"email","providers":["email"]}'::jsonb,
          jsonb_build_object('full_name', v_name, 'mobile', v_mobile), now(), now(),
          '', '', '', '', '', '', '', '', false, false);
  insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
  values (v_uid::text, v_uid, jsonb_build_object('sub', v_uid::text, 'email', v_email, 'email_verified', true),
          'email', now(), now());
  insert into clm_user_profiles (user_id, tenant_id, full_name, role, centre_ids, is_active, workspace)
  values (v_uid, j.tenant_id, v_name, 'desk', array[j.centre_id], true, p_desk);
  return 'ok';
end $$;

revoke all on function public.clm_self_register(text, text, text, text, text) from public;
grant execute on function public.clm_self_register(text, text, text, text, text) to anon, authenticated;
grant execute on function public.clm_mobile_email(text) to anon, authenticated;
