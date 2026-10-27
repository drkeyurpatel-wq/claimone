-- ════════════════════════════════════════════════════════════════════
-- ClaimOne — weekly payment upload
-- The team uploads what arrived this week (PMJAY settlement sheet, TPA /
-- corporate settlement letters). Each payment line is matched to its bill
-- by case ID / claim no, or bill no. A bill that is not on file yet is
-- created from the line, so nothing has to be typed twice. What is left
-- for people is only the mismatches (clm_v_exceptions).
-- ════════════════════════════════════════════════════════════════════

-- A settlement letter is proof of payment before the bank statement is seen.
alter table clm_receipts drop constraint if exists clm_receipts_source_check;
alter table clm_receipts add constraint clm_receipts_source_check check (source in ('bank','manual','advice'));
alter table clm_receipts add column if not exists bank_confirmed_on date;

alter table clm_import_batches drop constraint if exists clm_import_batches_kind_check;
alter table clm_import_batches add constraint clm_import_batches_kind_check
  check (kind in ('bank_statement','cashless_tracker','settlement_advice','patient_dues','receivables','weekly_payments'));

alter table clm_receivables add column if not exists uhid text;
comment on column clm_receivables.uhid is 'PHI: hospital UHID';

alter table clm_remittance_lines add column if not exists source text not null default 'letter';
alter table clm_remittance_lines drop constraint if exists clm_remittance_source_check;
alter table clm_remittance_lines add constraint clm_remittance_source_check check (source in ('letter','pmjay'));
alter table clm_remittance_lines add column if not exists claimed_amount numeric(12,2);
alter table clm_remittance_lines add column if not exists payment_date date;
alter table clm_remittance_lines add column if not exists file_name text;
alter table clm_remittance_lines add column if not exists receivable_id uuid references clm_receivables(id);
comment on column clm_remittance_lines.patient_name is 'PHI: patient name';

-- The same payment line uploaded again next week is ignored.
create unique index if not exists clm_remittance_dedupe on clm_remittance_lines
  (tenant_id, centre_id, coalesce(utr, ''), coalesce(claim_ref, ''), coalesce(bill_no, ''), net_amount);

create or replace function clm_norm_ref(t text) returns text
language sql immutable as $$ select nullif(upper(regexp_replace(coalesce(t, ''), '[^A-Za-z0-9]', '', 'g')), '') $$;

create index if not exists clm_receivables_claimref_norm on clm_receivables (tenant_id, centre_id, clm_norm_ref(claim_ref));
create index if not exists clm_receivables_billno_norm on clm_receivables (tenant_id, centre_id, clm_norm_ref(bill_no));

create or replace function clm_deduction_category(reason text) returns text
language sql immutable as $$
  select case
    when reason ~* 'room' then 'room_rent_cap'
    when reason ~* 'co.?pay' then 'co_pay'
    when reason ~* 'non.?pay|consumable|not payable' then 'non_payable'
    when reason ~* 'exclu' then 'policy_exclusion'
    when reason ~* 'pre.?exist|ped' then 'pre_existing'
    when reason ~* 'tariff|package|rate' then 'tariff_excess'
    when reason ~* 'document|doc ' then 'doc_missing'
    else 'other' end
$$;

-- ─── Apply one upload ────────────────────────────────────────────────
-- p_lines: [{source: 'pmjay'|'letter', payer_name, tpa_name, claim_ref, bill_no,
--            patient_name, ip_no, uhid, doctor_name, bill_date, claimed_amount,
--            approved_amount, tds_amount, deduction_amount, deduction_reason,
--            net_amount, utr, payment_date}]
-- Returns {matched, created, unpaid, duplicate, skipped}.
create or replace function clm_apply_payments(p_centre uuid, p_file text, p_lines jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  t uuid := clm_current_tenant();
  l jsonb; rv clm_receivables%rowtype; p clm_payers%rowtype;
  batch uuid; rem uuid; rc uuid;
  src text; net numeric; tds numeric; ded numeric; claimed numeric; approved numeric; owed numeric;
  k_claim text; k_bill text; bdate date; pdate date; dtype text;
  n_matched int := 0; n_created int := 0; n_unpaid int := 0; n_dup int := 0; n_skip int := 0;
begin
  if t is null or not clm_can_write() then raise exception 'Read-only access' using errcode = 'insufficient_privilege'; end if;
  if not clm_can_access_centre(p_centre) or not exists (select 1 from clm_centres where id = p_centre and tenant_id = t) then raise exception 'No access to this centre' using errcode = 'insufficient_privilege'; end if;

  insert into clm_import_batches (tenant_id, centre_id, kind, file_name, row_count)
  values (t, p_centre, 'weekly_payments', left(coalesce(p_file, 'upload'), 300), jsonb_array_length(p_lines)) returning id into batch;

  for l in select * from jsonb_array_elements(p_lines) loop
    src      := coalesce(nullif(l->>'source', ''), 'letter');
    net      := coalesce(nullif(l->>'net_amount', '')::numeric, 0);
    tds      := coalesce(nullif(l->>'tds_amount', '')::numeric, 0);
    ded      := coalesce(nullif(l->>'deduction_amount', '')::numeric, 0);
    claimed  := nullif(l->>'claimed_amount', '')::numeric;
    approved := nullif(l->>'approved_amount', '')::numeric;
    k_claim  := clm_norm_ref(l->>'claim_ref');
    k_bill   := clm_norm_ref(l->>'bill_no');
    bdate    := nullif(l->>'bill_date', '')::date;
    pdate    := nullif(l->>'payment_date', '')::date;

    if k_claim is null and k_bill is null then n_skip := n_skip + 1; continue; end if;

    -- the bill: case ID / claim no first, then bill no
    rv := null;
    if k_claim is not null then
      select * into rv from clm_receivables
      where tenant_id = t and centre_id = p_centre and clm_norm_ref(claim_ref) = k_claim and debtor_type not in ('patient','referrer')
      order by created_at limit 1;
    end if;
    if rv.id is null and k_bill is not null then
      select * into rv from clm_receivables
      where tenant_id = t and centre_id = p_centre and clm_norm_ref(bill_no) = k_bill and debtor_type not in ('patient','referrer')
      order by created_at limit 1;
    end if;

    -- what this payer finally owes for the bill
    owed := coalesce(claimed, approved, net + tds + ded);
    if src = 'pmjay' then owed := greatest(owed, net + tds); end if;

    if rv.id is null then
      -- not on file yet: the letter / PMJAY row is the bill record
      if src = 'pmjay' then
        select * into p from clm_payers where code = 'pmjay_gujarat' limit 1;
        dtype := 'government';
      else
        p := null;
        select * into p from clm_payers
        where (tenant_id is null or tenant_id = t)
          and length(split_part(name, ' ', 1)) >= 3
          and (upper(coalesce(l->>'payer_name', '')) like '%' || upper(split_part(name, ' ', 1)) || '%'
               or upper(coalesce(l->>'tpa_name', '')) like '%' || upper(split_part(name, ' ', 1)) || '%')
        order by (type = 'insurer') desc limit 1;
        dtype := case p.type when 'government' then 'government' when 'corporate' then 'corporate' when 'tpa' then 'tpa' else 'insurer' end;
      end if;
      insert into clm_receivables (tenant_id, centre_id, debtor_type, payer_id, debtor_name, bill_no, ip_no, uhid, claim_ref,
                                   bill_date, patient_name, doctor_name, billed_amount, expected_amount, notes, source, import_batch_id)
      values (t, p_centre, dtype, p.id,
              coalesce(p.name, nullif(l->>'payer_name', ''), nullif(l->>'tpa_name', ''), 'Unknown payer'),
              coalesce(nullif(l->>'bill_no', ''), 'CLAIM-' || k_claim), nullif(l->>'ip_no', ''), nullif(l->>'uhid', ''),
              nullif(l->>'claim_ref', ''), coalesce(bdate, pdate, current_date), nullif(l->>'patient_name', ''),
              nullif(l->>'doctor_name', ''), claimed, owed,
              case src when 'pmjay' then 'Created from PMJAY settlement sheet' else 'Created from settlement letter' end,
              'import', batch)
      on conflict (tenant_id, centre_id, debtor_type, bill_no) do update set claim_ref = coalesce(clm_receivables.claim_ref, excluded.claim_ref)
      returning * into rv;
      n_created := n_created + 1;
    else
      -- fill gaps on the bill from the letter (never overwrite what the team entered)
      update clm_receivables set
        claim_ref = coalesce(claim_ref, nullif(l->>'claim_ref', '')),
        uhid = coalesce(uhid, nullif(l->>'uhid', '')),
        expected_amount = case when src = 'pmjay' and net + tds > expected_amount then net + tds else expected_amount end
      where id = rv.id returning * into rv;
    end if;

    if net <= 0 then n_unpaid := n_unpaid + 1; continue; end if;

    -- the same payment line uploaded again is ignored
    insert into clm_remittance_lines (tenant_id, centre_id, payer_id, payer_name, utr, advice_date, claim_ref, bill_no, patient_name,
                                      approved_amount, claimed_amount, tds_amount, deduction_amount, deduction_reason, net_amount,
                                      payment_date, source, file_name, receivable_id, import_batch_id)
    values (t, p_centre, rv.payer_id, coalesce(nullif(l->>'payer_name', ''), rv.debtor_name), nullif(l->>'utr', ''), pdate,
            nullif(l->>'claim_ref', ''), nullif(l->>'bill_no', ''), nullif(l->>'patient_name', ''), approved, claimed,
            tds, ded, nullif(l->>'deduction_reason', ''), net, pdate, src, left(p_file, 300), rv.id, batch)
    on conflict do nothing returning id into rem;
    if rem is null then n_dup := n_dup + 1; continue; end if;

    -- if the bank statement with this UTR is already in, pay the bill from that credit
    rc := null;
    if nullif(l->>'utr', '') is not null then
      select id into rc from clm_v_receipt_balance
      where tenant_id = t and centre_id = p_centre and source = 'bank'
        and upper(reference) = upper(l->>'utr') and unallocated >= net - 0.5
      order by value_date limit 1;
    end if;
    if rc is null then
      insert into clm_receipts (tenant_id, centre_id, source, bank_account, value_date, amount, reference, narration, payer_id, import_batch_id)
      values (t, p_centre, 'advice', 'advice:' || rem, coalesce(pdate, current_date), net, nullif(l->>'utr', ''),
              case src when 'pmjay' then 'PMJAY settlement' else 'Settlement letter' end, rv.payer_id, batch)
      returning id into rc;
    end if;

    insert into clm_allocations (tenant_id, receipt_id, receivable_id, amount, method, remittance_line_id)
    values (t, rc, rv.id, net, 'advice', rem);

    if tds > 0 then
      insert into clm_adjustments (tenant_id, receivable_id, kind, amount, reason_text, remittance_line_id)
      values (t, rv.id, 'tds', tds, 'TDS as per settlement', rem);
    end if;
    -- a deduction only closes the gap when the letter says why; otherwise it stays on the mismatch list
    if ded > 0 and nullif(trim(l->>'deduction_reason'), '') is not null then
      insert into clm_adjustments (tenant_id, receivable_id, kind, amount, category, reason_text, remittance_line_id)
      values (t, rv.id, 'deduction', ded, clm_deduction_category(l->>'deduction_reason'), trim(l->>'deduction_reason'), rem);
    end if;
    n_matched := n_matched + 1;
  end loop;

  return jsonb_build_object('batch_id', batch, 'matched', n_matched, 'created', n_created, 'unpaid', n_unpaid,
                            'duplicate', n_dup, 'skipped', n_skip);
end $$;

grant execute on function clm_apply_payments(uuid, text, jsonb) to authenticated;
revoke execute on function clm_apply_payments(uuid, text, jsonb) from anon;

-- ─── Only the mismatches ─────────────────────────────────────────────
-- short      paid less than owed and no reason explains the gap
-- over       paid more than owed (patient may need a refund)
-- overdue    nothing received and past the payer's usual time
create or replace view clm_v_exceptions with (security_invoker = true) as
select b.id as receivable_id, b.centre_id, b.debtor_type, b.debtor_name, b.patient_name, r.uhid, b.bill_no, b.claim_ref,
       b.bill_date, b.expected_amount, b.allocated, b.tds, b.deduction, b.balance, b.age_days, b.last_receipt_date,
       case
         when b.recon_status = 'part_received' and b.balance > 1 then 'short'
         when b.recon_status = 'over_received' then 'over'
         when b.recon_status = 'open' and b.age_days > case when b.debtor_type = 'government' then 45 else 30 end then 'overdue'
       end as problem
from clm_v_receivable_balance b join clm_receivables r on r.id = b.id
where b.status = 'open'
  and (   (b.recon_status = 'part_received' and b.balance > 1)
       or  b.recon_status = 'over_received'
       or (b.recon_status = 'open' and b.age_days > case when b.debtor_type = 'government' then 45 else 30 end));

grant select on clm_v_exceptions to authenticated;
