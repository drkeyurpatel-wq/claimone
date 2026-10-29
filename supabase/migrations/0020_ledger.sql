-- ════════════════════════════════════════════════════════════════════
-- Ledger mode.
-- 1. The paper gate is a per-hospital-group switch, off by default:
--    papers are filed on the insurer / TPA website, so the desk records
--    dates and amounts without ticking each paper first. Turn it on with
--    update clm_tenants set paper_gate = true where code = '...';
-- 2. A payment can be typed in against one patient (amount, TDS, UTR,
--    date) instead of uploading a letter. It is booked exactly like an
--    uploaded letter line, so the same cut / fight / settle rules apply.
-- ════════════════════════════════════════════════════════════════════

alter table clm_tenants add column if not exists paper_gate boolean not null default false;
comment on column clm_tenants.paper_gate is 'true: a pre-auth or claim cannot be marked sent until its mandatory papers are ticked';

-- The pre-auth approval is kept on its own, because approved_amount is reused for the claim approval.
alter table clm_claims add column if not exists preauth_approved_amount numeric(12,2);
update clm_claims set preauth_approved_amount = approved_amount
where preauth_approved_amount is null and status in ('preauth_approved','preauth_enhanced');

create or replace function clm_paper_gate_on(p_tenant uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select paper_gate from clm_tenants where id = p_tenant), false)
$$;

-- Same as 0001, except the paper check runs only when the gate is on.
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
      if clm_paper_gate_on(new.tenant_id) then
        select string_agg(doc_label || ' (' || doc_status || ')', '; ')
          into v_unmet from clm_unmet_mandatory_docs(new.id, v_stage);
        if v_unmet is not null then
          raise exception 'Submission blocked — documents not verified: %', v_unmet
            using errcode = 'check_violation', hint = 'CLAIMONE_GATE';
        end if;
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
    if new.status in ('preauth_approved','preauth_enhanced') then new.preauth_approved_amount := new.approved_amount; end if;
  end if;

  new.updated_at := now();
  return new;
end $$;

-- ─── Typed-in payment for one patient ───────────────────────────────
-- p_net: money received in the bank; p_tds: TDS the insurer kept.
-- Whatever is still short shows on the ledger as the insurer's cut, to accept or fight.
create or replace function clm_record_case_payment(p_claim uuid, p_net numeric, p_tds numeric default 0,
                                                   p_utr text default null, p_date date default null)
returns text
language plpgsql security invoker set search_path = public as $$
declare
  c clm_claims%rowtype; r clm_receivables%rowtype;
  t uuid := clm_current_tenant(); batch uuid; rem uuid; rc uuid; bank uuid; v_utr text; v_date date;
begin
  if t is null or not clm_can_write() then raise exception 'Read-only access' using errcode = 'insufficient_privilege'; end if;
  select * into c from clm_claims where id = p_claim;
  if not found or c.tenant_id <> t or not clm_can_access_centre(c.centre_id) then
    raise exception 'Unknown patient' using errcode = 'foreign_key_violation';
  end if;
  if c.status not in ('claim_approved','claim_partial','settlement_pending') then
    raise exception 'Enter the approved amount before the payment' using errcode = 'check_violation';
  end if;
  if coalesce(p_net, 0) <= 0 then raise exception 'Enter the amount received' using errcode = 'check_violation'; end if;
  if coalesce(p_tds, 0) < 0 then raise exception 'TDS cannot be negative' using errcode = 'check_violation'; end if;

  select * into r from clm_receivables where claim_id = c.id and debtor_type <> 'patient';
  if r.id is null then raise exception 'No bill for this patient yet' using errcode = 'check_violation'; end if;

  v_utr := nullif(btrim(coalesce(p_utr, '')), '');
  v_date := coalesce(p_date, (now() at time zone 'Asia/Kolkata')::date);

  insert into clm_import_batches (tenant_id, centre_id, kind, file_name, row_count)
  values (t, c.centre_id, 'weekly_payments', 'Typed in ClaimOne', 1) returning id into batch;

  -- the same payment typed twice is refused (same bill + UTR + amount)
  insert into clm_remittance_lines (tenant_id, centre_id, payer_id, payer_name, utr, advice_date, claim_ref, bill_no, patient_name,
                                    approved_amount, claimed_amount, tds_amount, deduction_amount, net_amount,
                                    payment_date, source, file_name, receivable_id, import_batch_id)
  values (t, c.centre_id, r.payer_id, r.debtor_name, v_utr, v_date, r.claim_ref, r.bill_no, c.patient_name,
          c.approved_amount, c.claimed_amount, coalesce(p_tds, 0), 0, p_net,
          v_date, 'letter', 'Typed in ClaimOne', r.id, batch)
  on conflict do nothing returning id into rem;
  if rem is null then raise exception 'This payment is already entered' using errcode = 'unique_violation'; end if;

  -- the bank credit with this UTR if it is already on file, else a receipt for this payment
  if v_utr is not null then
    rc := clm_bank_receipt_for(t, c.centre_id, v_utr, p_net);
    if rc is null then bank := clm_bank_credit_any(t, c.centre_id, v_utr); end if;
  end if;
  if rc is null then
    insert into clm_receipts (tenant_id, centre_id, source, bank_account, value_date, amount, reference, narration, payer_id,
                              import_batch_id, bank_receipt_id, bank_confirmed_on)
    values (t, c.centre_id, 'advice', 'advice:' || rem, v_date, p_net, v_utr, 'Typed in ClaimOne', r.payer_id,
            batch, bank, (select value_date from clm_receipts where id = bank))
    returning id into rc;
  end if;

  insert into clm_allocations (tenant_id, receipt_id, receivable_id, amount, method, remittance_line_id)
  values (t, rc, r.id, p_net, 'advice', rem);
  if coalesce(p_tds, 0) > 0 then
    insert into clm_adjustments (tenant_id, receivable_id, kind, amount, reason_text, remittance_line_id)
    values (t, r.id, 'tds', p_tds, 'TDS as per settlement', rem);
  end if;
  return 'saved';
end $$;

revoke execute on function clm_record_case_payment(uuid, numeric, numeric, text, date) from public, anon;
grant execute on function clm_record_case_payment(uuid, numeric, numeric, text, date) to authenticated;
revoke execute on function clm_paper_gate_on(uuid) from public, anon;
grant execute on function clm_paper_gate_on(uuid) to authenticated;
