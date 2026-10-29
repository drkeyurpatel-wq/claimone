-- ════════════════════════════════════════════════════════════════════
-- Payer master.
-- 1. Anyone on the desk can add a payer that is not in the list while
--    adding an admission (a new corporate, a local TPA). A name already
--    on the list (spelt with other spaces / capitals) is reused, not doubled.
-- 2. Admins and managers keep the list in Settings: rename, move to another
--    category, mark inactive. Payers are never deleted — claims point at them.
--    The starter list is shared (tenant_id null); while only one hospital
--    group uses this database, its admins may edit those rows too.
-- ════════════════════════════════════════════════════════════════════

create or replace function clm_payer_key(p text) returns text
language sql immutable set search_path = public as $$
  select regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]', '', 'g')
$$;

-- category on screen → payer type + code prefix
create or replace function clm_payer_type_for_group(p_group text) returns text
language sql immutable set search_path = public as $$
  select case p_group when 'pmjay' then 'government' when 'scheme' then 'government' when 'tpa' then 'tpa'
                      when 'insurer' then 'insurer' when 'corporate' then 'corporate' end
$$;

create or replace function clm_new_payer_code(p_tenant uuid, p_group text, p_name text) returns text
language plpgsql stable security definer set search_path = public as $$
declare base text; c text; n int := 1;
begin
  base := left(regexp_replace(lower(btrim(p_name)), '[^a-z0-9]+', '_', 'g'), 40);
  base := trim(both '_' from base);
  if base = '' then base := 'payer'; end if;
  if p_group = 'pmjay' and base !~ '^pmjay' then base := 'pmjay_' || base; end if;
  c := base;
  while exists (select 1 from clm_payers where coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)
                  = coalesce(p_tenant, '00000000-0000-0000-0000-000000000000'::uuid) and code = c) loop
    n := n + 1; c := base || '_' || n;
  end loop;
  return c;
end $$;

-- Add (or reuse) a payer from the admission form. Any desk login.
create or replace function clm_add_payer(p_name text, p_group text) returns uuid
language plpgsql security definer set search_path = public as $$
declare t uuid := clm_current_tenant(); v_type text; v_id uuid; v_name text := btrim(coalesce(p_name, ''));
begin
  if t is null or not clm_can_write() then raise exception 'Read-only access' using errcode = 'insufficient_privilege'; end if;
  v_type := clm_payer_type_for_group(p_group);
  if v_type is null then raise exception 'Select the payer category' using errcode = 'check_violation'; end if;
  if length(v_name) < 3 then raise exception 'Enter the full payer name' using errcode = 'check_violation'; end if;
  if length(v_name) > 120 then raise exception 'Payer name is too long' using errcode = 'check_violation'; end if;

  select id into v_id from clm_payers
  where (tenant_id is null or tenant_id = t) and clm_payer_key(name) = clm_payer_key(v_name)
  order by (tenant_id is null), created_at limit 1;
  if v_id is not null then
    update clm_payers set is_active = true where id = v_id and not is_active;
    return v_id;
  end if;

  insert into clm_payers (tenant_id, code, name, type, channel)
  values (t, clm_new_payer_code(t, p_group, v_name), v_name, v_type,
          case when p_group = 'corporate' then 'direct' when p_group = 'pmjay' then 'tms' else 'portal' end)
  returning id into v_id;
  return v_id;
end $$;

-- Edit one payer from Settings. Admins and managers.
create or replace function clm_save_payer(p_id uuid, p_name text, p_group text, p_active boolean) returns void
language plpgsql security definer set search_path = public as $$
declare t uuid := clm_current_tenant(); p clm_payers%rowtype; v_type text; v_name text := btrim(coalesce(p_name, '')); v_code text;
begin
  if t is null or coalesce(clm_current_role(), '') not in ('admin','manager') then
    raise exception 'Only an admin or manager can edit the payer list' using errcode = 'insufficient_privilege';
  end if;
  select * into p from clm_payers where id = p_id for update;
  if not found or (p.tenant_id is not null and p.tenant_id <> t) then raise exception 'Unknown payer' using errcode = 'foreign_key_violation'; end if;
  if p.tenant_id is null and (select count(*) from clm_tenants) > 1 then
    raise exception 'This payer is shared by all hospitals — add your own entry instead' using errcode = 'insufficient_privilege';
  end if;
  v_type := clm_payer_type_for_group(p_group);
  if v_type is null then raise exception 'Select the payer category' using errcode = 'check_violation'; end if;
  if length(v_name) < 3 then raise exception 'Enter the full payer name' using errcode = 'check_violation'; end if;
  if exists (select 1 from clm_payers where id <> p.id and (tenant_id is null or tenant_id = t)
             and clm_payer_key(name) = clm_payer_key(v_name)) then
    raise exception 'Another payer already has this name' using errcode = 'unique_violation';
  end if;

  -- PMJAY is told apart by its code; moving in or out of PMJAY changes the code
  v_code := p.code;
  if p_group = 'pmjay' and p.code !~ '^pmjay' then v_code := clm_new_payer_code(p.tenant_id, 'pmjay', v_name);
  elsif p_group <> 'pmjay' and p.code ~ '^pmjay' then v_code := clm_new_payer_code(p.tenant_id, p_group, v_name);
  end if;

  update clm_payers set name = v_name, type = v_type, code = v_code, is_active = coalesce(p_active, true) where id = p.id;
end $$;

revoke execute on function clm_add_payer(text, text) from public, anon;
grant execute on function clm_add_payer(text, text) to authenticated;
revoke execute on function clm_save_payer(uuid, text, text, boolean) from public, anon;
grant execute on function clm_save_payer(uuid, text, text, boolean) to authenticated;
revoke execute on function clm_new_payer_code(uuid, text, text) from public, anon;

-- ─── Enhancements ───────────────────────────────────────────────────
-- The first enhancement is a status change (preauth_approved → preauth_enhanced).
-- A second or later enhancement keeps the status and raises the approved amount;
-- it is recorded in the file's history all the same.
create or replace function clm_record_enhancement(p_claim uuid, p_amount numeric, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare c clm_claims%rowtype;
begin
  select * into c from clm_claims where id = p_claim for update;
  if not found or c.tenant_id <> clm_current_tenant() or not clm_can_access_centre(c.centre_id) then
    raise exception 'Unknown patient' using errcode = 'foreign_key_violation';
  end if;
  if not clm_can_write() then raise exception 'Read-only access' using errcode = 'insufficient_privilege'; end if;
  if c.status <> 'preauth_enhanced' then
    raise exception 'Enhancement can be recorded only after the pre-auth is approved and before the claim is submitted' using errcode = 'check_violation';
  end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Enter the revised approved amount' using errcode = 'check_violation'; end if;
  update clm_claims set approved_amount = p_amount, preauth_approved_amount = p_amount where id = c.id;
  insert into clm_state_transitions (tenant_id, claim_id, from_status, to_status, trigger_source, actor_id, notes)
  values (c.tenant_id, c.id, c.status, c.status, 'user', auth.uid(),
          'Further enhancement approved — ₹' || to_char(p_amount, 'FM99,99,99,999') || coalesce(' — ' || nullif(btrim(p_note), ''), ''));
end $$;
revoke execute on function clm_record_enhancement(uuid, numeric, text) from public, anon;
grant execute on function clm_record_enhancement(uuid, numeric, text) to authenticated;
