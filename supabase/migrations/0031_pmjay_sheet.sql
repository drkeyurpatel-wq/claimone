-- PMJAY desk sheet (one row per PMJAY case, the month's sheet the PMJAY desk keeps)
-- → cases on Master. Upload it any time: new cases are added, existing ones move
-- forward to the sheet's case status, and a paid row records the payment with its UTR.
-- PMJAY pays Shilaj the NABH rate: that is the claimed amount. The non-NABH package
-- rate is kept alongside for the internal calculations that use it.

alter table clm_claims add column if not exists non_nabh_amount numeric(14,2);
comment on column clm_claims.non_nabh_amount is 'PMJAY package at the non-NABH rate (internal calculations). The claim itself is at the NABH rate.';

alter table clm_claims drop constraint if exists clm_claims_case_source_check;
alter table clm_claims add constraint clm_claims_case_source_check
  check (case_source = any (array['manual','ecw','hmis','sheet','pmjay']));

alter table clm_import_batches drop constraint if exists clm_import_batches_kind_check;
alter table clm_import_batches add constraint clm_import_batches_kind_check
  check (kind in ('bank_statement','cashless_tracker','settlement_advice','patient_dues','receivables','weekly_payments','ecw_cases','pmjay_cases'));

-- TMS case status (as typed on the sheet) → ClaimOne status. null = not yet sent.
create or replace function clm_pmjay_status(p text) returns text
language sql immutable set search_path = public as $$
  select case
    when s = '' then null
    when s ~ 'PRE' and s ~ 'REJECT' then 'preauth_rejected'
    when s ~ 'PRE' and s ~ 'QUERY' then 'preauth_query'
    when s ~ 'PRE' and s ~ 'APPROV' then 'preauth_approved'
    when s ~ 'PRE' then 'preauth_pending'
    when s ~ 'REJECT' then 'claim_rejected'
    when s ~ 'QUERY' then 'claim_query'
    when s ~ 'PAID|PAYMENT|SETTLED' then 'claim_approved'
    when s ~ 'APPROV' then 'claim_approved'
    when s ~ 'SUBMIT|CLAIM' then 'claim_submitted'
    else null end
  from (select upper(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g')) as s) x
$$;

create or replace function clm_status_rank(p text) returns int
language sql immutable set search_path = public as $$
  select case p
    when 'draft' then 0
    when 'preauth_pending' then 1 when 'preauth_query' then 1
    when 'preauth_approved' then 2 when 'preauth_enhanced' then 2 when 'preauth_rejected' then 2
    when 'claim_submitted' then 3 when 'claim_under_review' then 3 when 'claim_query' then 3
    when 'claim_approved' then 4 when 'claim_partial' then 4 when 'claim_rejected' then 4
    when 'settlement_pending' then 5 when 'settled' then 6 else 7 end
$$;

create or replace function public.clm_import_pmjay(p_centre uuid, p_file text, p_rows jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  t uuid := clm_current_tenant();
  r jsonb; batch uuid; c clm_claims%rowtype; v_payer uuid; ip text; target text; nxt text; guard int;
  nabh numeric; base numeric; paid numeric; approved numeric; v_utr text; pay_date date;
  adm date; dis date; proc text; v_code text;
  n_new int := 0; n_upd int := 0; n_moved int := 0; n_paid int := 0; n_skip int := 0;
  problems jsonb := '[]'::jsonb;
begin
  if t is null or not clm_can_write() then raise exception 'Read-only access' using errcode = 'insufficient_privilege'; end if;
  if not clm_can_access_centre(p_centre) or not exists (select 1 from clm_centres where id = p_centre and tenant_id = t) then
    raise exception 'No access to this centre' using errcode = 'insufficient_privilege';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 3000 then
    raise exception 'Send at most 3000 rows at a time' using errcode = 'check_violation';
  end if;
  select id into v_payer from clm_payers where code = 'pmjay_gujarat' and (tenant_id is null or tenant_id = t)
  order by tenant_id nulls last limit 1;
  if v_payer is null then raise exception 'PMJAY payer is missing from the payer master' using errcode = 'foreign_key_violation'; end if;

  insert into clm_import_batches (tenant_id, centre_id, kind, file_name, row_count)
  values (t, p_centre, 'pmjay_cases', left(coalesce(p_file, 'upload'), 300), jsonb_array_length(p_rows)) returning id into batch;
  perform set_config('claimone.note', 'From the PMJAY sheet', true);

  for r in select * from jsonb_array_elements(p_rows) loop
    ip := nullif(upper(btrim(r->>'ip_no')), '');
    if ip is null or nullif(btrim(r->>'patient_name'), '') is null then n_skip := n_skip + 1; continue; end if;
    nabh := nullif(nullif(r->>'nabh_amount', '')::numeric, 0);
    base := nullif(nullif(r->>'non_nabh_amount', '')::numeric, 0);
    paid := nullif(nullif(r->>'paid_amount', '')::numeric, 0);
    v_utr := nullif(btrim(r->>'utr'), '');
    pay_date := nullif(r->>'paid_on', '')::date;
    adm := nullif(r->>'admitted_on', '')::date;
    dis := nullif(r->>'discharged_on', '')::date;
    proc := nullif(btrim(r->>'procedure'), '');
    v_code := substring(proc from '\(([A-Z]{2}[0-9]{3}[A-Z0-9]*)');
    target := clm_pmjay_status(r->>'case_status');
    if target is null and paid is not null then target := 'claim_approved'; end if;

    select * into c from clm_claims where centre_id = p_centre and upper(admission_ref) = ip;
    if not found then
      insert into clm_claims (tenant_id, centre_id, payer_id, claim_type, patient_name, admission_ref, treating_doctor_name,
                              department_name, admission_date, admitted_at, discharge_date, discharged_at, estimated_amount,
                              non_nabh_amount, member_id, tpa_claim_number, procedure_name, package_code, notes, case_source)
      values (t, p_centre, v_payer, 'pmjay', left(btrim(r->>'patient_name'), 200), ip, nullif(btrim(r->>'doctor'), ''),
              nullif(btrim(r->>'category'), ''), adm, (adm::text || 'T12:00:00+05:30')::timestamptz,
              dis, (dis::text || 'T12:00:00+05:30')::timestamptz, nabh, base,
              nullif(btrim(r->>'card_no'), ''), nullif(btrim(r->>'case_no'), ''), left(proc, 500), v_code,
              nullif(btrim(r->>'remarks'), ''), 'pmjay')
      returning * into c;
      n_new := n_new + 1;
    else
      update clm_claims set
        treating_doctor_name = coalesce(treating_doctor_name, nullif(btrim(r->>'doctor'), '')),
        department_name = coalesce(department_name, nullif(btrim(r->>'category'), '')),
        admission_date = coalesce(admission_date, adm),
        discharge_date = coalesce(dis, discharge_date),
        discharged_at = coalesce(discharged_at, (dis::text || 'T12:00:00+05:30')::timestamptz),
        estimated_amount = coalesce(nabh, estimated_amount),
        non_nabh_amount = coalesce(base, non_nabh_amount),
        member_id = coalesce(member_id, nullif(btrim(r->>'card_no'), '')),
        tpa_claim_number = coalesce(tpa_claim_number, nullif(btrim(r->>'case_no'), '')),
        procedure_name = coalesce(procedure_name, left(proc, 500)),
        package_code = coalesce(package_code, v_code)
      where id = c.id
        and (treating_doctor_name is null and nullif(btrim(r->>'doctor'), '') is not null
          or discharge_date is distinct from coalesce(dis, discharge_date)
          or estimated_amount is distinct from coalesce(nabh, estimated_amount)
          or non_nabh_amount is distinct from coalesce(base, non_nabh_amount)
          or tpa_claim_number is null and nullif(btrim(r->>'case_no'), '') is not null)
      returning * into c;
      if found then n_upd := n_upd + 1; else select * into c from clm_claims where centre_id = p_centre and upper(admission_ref) = ip; end if;
    end if;

    -- move the case forward to the sheet's status (never backwards)
    if target is not null and nabh is null and clm_status_rank(target) >= 3 then
      problems := problems || jsonb_build_object('ip', ip, 'problem', 'No package amount on the sheet — status not updated');
      target := null;
    end if;
    -- FINAL AMOUNT is what PMJAY approved and paid; DED AMOUNT is the scheme's cut (claimed − approved)
    approved := paid;
    guard := 0;
    while target is not null and c.status <> target and clm_status_rank(c.status) <= clm_status_rank(target) and guard < 6 loop
      guard := guard + 1;
      nxt := case
        when c.status = 'draft' then case when target like 'preauth%' then 'preauth_pending' else 'claim_submitted' end
        when c.status = 'preauth_pending' then case when target like 'preauth%' then target else 'preauth_approved' end
        when c.status = 'preauth_query' then 'preauth_pending'
        when c.status in ('preauth_approved','preauth_enhanced') then 'claim_submitted'
        when c.status in ('claim_submitted','claim_under_review') then
          case when target = 'claim_approved' and coalesce(approved, nabh) < coalesce(c.claimed_amount, nabh) - 1 then 'claim_partial' else target end
        when c.status = 'claim_query' then 'claim_submitted'
        else null end;
      exit when nxt is null or nxt = c.status or not exists (select 1 from clm_allowed_transitions where from_status = c.status and to_status = nxt);
      c := clm_transition(c.id, nxt,
        jsonb_strip_nulls(case
          when nxt = 'preauth_approved' then jsonb_build_object('approved_amount', nabh)
          when nxt = 'claim_submitted' then jsonb_build_object('claimed_amount', nabh, 'tpa_claim_number', nullif(btrim(r->>'case_no'), ''))
          when nxt in ('claim_approved','claim_partial') then jsonb_build_object('approved_amount', coalesce(approved, nabh))
          else '{}'::jsonb end),
        'From the PMJAY sheet');
      if nxt = 'claim_submitted' then
        update clm_claims set submitted_at = (coalesce(dis, adm, current_date)::text || 'T12:00:00+05:30')::timestamptz where id = c.id returning * into c;
      end if;
      n_moved := n_moved + 1;
      exit when c.status in ('claim_partial','claim_approved') and target = 'claim_approved';
    end loop;

    -- paid on the sheet: record the payment once, by its UTR
    if paid is not null and v_utr is not null and c.status in ('claim_approved','claim_partial','settlement_pending')
       and not exists (select 1 from clm_remittance_lines l join clm_receivables v on v.id = l.receivable_id
                       where v.claim_id = c.id and v.debtor_type <> 'patient'
                         and upper(split_part(l.utr, ' ', 1)) = upper(v_utr)) then
      begin
        perform clm_record_case_payment(c.id, paid, 0, v_utr, coalesce(pay_date, current_date));
        n_paid := n_paid + 1;
      exception when others then
        problems := problems || jsonb_build_object('ip', ip, 'problem', 'Payment not recorded: ' || sqlerrm);
      end;
    elsif paid is not null and v_utr is null then
      problems := problems || jsonb_build_object('ip', ip, 'problem', 'Paid amount without a UTR — payment not recorded');
    end if;
  end loop;
  perform set_config('claimone.note', '', true);

  return jsonb_build_object('batch_id', batch, 'created', n_new, 'updated', n_upd, 'moved', n_moved,
                            'paid', n_paid, 'skipped', n_skip, 'problems', problems);
end $$;

revoke all on function public.clm_import_pmjay(uuid, text, jsonb) from public, anon;
grant execute on function public.clm_import_pmjay(uuid, text, jsonb) to authenticated;
