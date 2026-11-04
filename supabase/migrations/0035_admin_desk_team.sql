-- Administrative desk + Setup → Team.
-- Anyone with the team code can sign up and pick "Administrative"; they start as ordinary desk staff.
-- A manager or admin approves them (role → manager: Reports and Setup open). Managers can also
-- switch staff off when they leave. Nobody changes their own role, and an admin's login is only
-- changed by another admin.

alter table clm_user_profiles drop constraint if exists clm_user_profiles_workspace_check;
alter table clm_user_profiles add constraint clm_user_profiles_workspace_check
  check (workspace in ('admission', 'claims', 'payments', 'admin'));

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
  if p_desk not in ('admission', 'claims', 'payments', 'admin') then raise exception 'Choose your desk' using errcode = 'check_violation'; end if;
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
  -- an Administrative signup starts as desk staff until a manager approves it
  insert into clm_user_profiles (user_id, tenant_id, full_name, role, centre_ids, is_active, workspace)
  values (v_uid, j.tenant_id, v_name, 'desk', array[j.centre_id], true, p_desk);
  return 'ok';
end $$;
revoke all on function public.clm_self_register(text, text, text, text, text) from public;
grant execute on function public.clm_self_register(text, text, text, text, text) to anon, authenticated;

-- The team of the caller's hospital group (managers and admins only).
create or replace function public.clm_team()
returns table (user_id uuid, full_name text, mobile text, role text, workspace text, is_active boolean, joined date)
language plpgsql stable security definer set search_path = public
as $$
begin
  if clm_current_role() not in ('admin', 'manager') then
    raise exception 'Only a manager can see the team' using errcode = 'insufficient_privilege';
  end if;
  return query
  select p.user_id, p.full_name,
         case when u.email like '%@claimone.local' then split_part(u.email, '@', 1) end,
         p.role, p.workspace, p.is_active, p.created_at::date
  from clm_user_profiles p left join auth.users u on u.id = p.user_id
  where p.tenant_id = clm_current_tenant() and p.role in ('admin', 'manager', 'desk', 'viewer')
  order by p.is_active desc, coalesce(p.workspace = 'admin' and p.role = 'desk', false) desc, p.full_name;
end $$;
revoke all on function public.clm_team() from public, anon;
grant execute on function public.clm_team() to authenticated;

-- Approve as manager / back to desk, and switch a login on or off.
create or replace function public.clm_set_staff(p_user uuid, p_role text default null, p_active boolean default null)
returns text
language plpgsql security definer set search_path = public
as $$
declare me text := clm_current_role(); them clm_user_profiles%rowtype;
begin
  if me not in ('admin', 'manager') then raise exception 'Only a manager can change the team' using errcode = 'insufficient_privilege'; end if;
  if p_user = auth.uid() then raise exception 'You cannot change your own login' using errcode = 'check_violation'; end if;
  select * into them from clm_user_profiles where user_id = p_user and tenant_id = clm_current_tenant();
  if not found then raise exception 'Unknown staff member' using errcode = 'foreign_key_violation'; end if;
  if p_role is not null and p_role not in ('manager', 'desk') then raise exception 'Role must be manager or desk' using errcode = 'check_violation'; end if;
  -- a manager approves and switches off desk staff; another manager's (or an admin's / the bot's) login is the admin's to change
  if them.role not in ('manager', 'desk', 'viewer') or (them.role = 'manager' and me <> 'admin') then
    raise exception 'Only an admin can change this login' using errcode = 'insufficient_privilege';
  end if;
  update clm_user_profiles set role = coalesce(p_role, role), is_active = coalesce(p_active, is_active)
  where user_id = p_user;
  return 'ok';
end $$;
revoke all on function public.clm_set_staff(uuid, text, boolean) from public, anon;
grant execute on function public.clm_set_staff(uuid, text, boolean) to authenticated;
