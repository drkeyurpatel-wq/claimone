-- ════════════════════════════════════════════════════════════════════
-- Old sheet → Master, second pass: the same bills were already on the
-- receivables book (loaded from the sheet on 28 Oct, with their payments)
-- but not tied to a case. A case brought over now takes that bill — found
-- by bill no., IP no. and patient name — instead of a second copy, and its
-- payments are not booked again.
-- ════════════════════════════════════════════════════════════════════

create or replace function clm_import_sheet_case(p_centre uuid, r jsonb) returns text
language plpgsql security invoker set search_path = public as $$
declare
  t uuid := clm_current_tenant(); v_payer uuid; v_id uuid; v_rec clm_receivables%rowtype;
  total numeric := coalesce((r->>'total')::numeric, 0);
  claimed numeric; approved numeric := nullif(r->>'approved', '')::numeric;
  received numeric := coalesce(nullif(r->>'received', '')::numeric, 0);
  tds numeric := coalesce(nullif(r->>'tds', '')::numeric, 0);
  v_day date := (r->>'discharge')::date; v_bill date := coalesce(nullif(r->>'bill_date', '')::date, (r->>'discharge')::date);
  v_pay date := nullif(r->>'pay_date', '')::date; v_utr text := nullif(btrim(r->>'utr'), '');
  batch uuid; rem uuid; rc uuid; bank uuid; short numeric; v_old uuid; v_bal numeric;
begin
  if t is null or not clm_can_write() then raise exception 'Read-only access' using errcode = 'insufficient_privilege'; end if;
  if exists (select 1 from clm_claims where centre_id = p_centre and upper(btrim(admission_ref)) = upper(btrim(r->>'ip'))) then return 'exists'; end if;
  select id into v_payer from clm_payers where code = r->>'payer_code' and (tenant_id is null or tenant_id = t) order by tenant_id nulls last limit 1;
  if v_payer is null then return 'unknown payer ' || coalesce(r->>'payer_code', ''); end if;
  if approved is null or approved <= 0 then return 'no approved amount'; end if;
  claimed := greatest(total - coalesce((r->>'discount')::numeric, 0) - coalesce((r->>'patient_paid')::numeric, 0), approved);

  perform set_config('claimone.source', 'sheet', true);
  perform set_config('claimone.note', 'Loaded from the old Excel sheet', true);
  insert into clm_claims (tenant_id, centre_id, payer_id, claim_type, patient_name, admission_ref, treating_doctor_name,
                          admitted_at, admission_date, discharged_at, discharge_date, bill_no, bill_amount, discount_amount, patient_paid,
                          policy_number, notes, case_source)
  values (t, p_centre, v_payer, coalesce(r->>'claim_type', 'cashless'), btrim(r->>'name'), btrim(r->>'ip'), nullif(btrim(r->>'doctor'), ''),
          (v_day::text || 'T12:00:00+05:30')::timestamptz, null, (v_day::text || 'T12:00:00+05:30')::timestamptz, v_day,
          nullif(btrim(r->>'bill_no'), ''), total, coalesce((r->>'discount')::numeric, 0), coalesce((r->>'patient_paid')::numeric, 0),
          nullif(btrim(r->>'policy'), ''), nullif(btrim(r->>'remarks'), ''), 'sheet')
  returning id into v_id;

  perform clm_transition(v_id, 'claim_submitted',
    jsonb_strip_nulls(jsonb_build_object('claimed_amount', claimed, 'tpa_claim_number', nullif(btrim(r->>'claim_no'), ''))),
    'Loaded from the old Excel sheet');
  update clm_claims set submitted_at = (v_bill::text || 'T12:00:00+05:30')::timestamptz where id = v_id;

  -- the bill may already be on the receivables book (loaded earlier from the same sheet, with its payments):
  -- link it to this case instead of making a second one
  select id into v_old from clm_receivables
  where centre_id = p_centre and claim_id is null and debtor_type not in ('patient','referrer')
    and clm_norm_ref(bill_no) = clm_norm_ref(r->>'bill_no')
    and (ip_no is null or clm_norm_ref(ip_no) = clm_norm_ref(split_part(r->>'ip', '/', 1)))
    and (clm_norm_name(patient_name) is null or clm_norm_name(patient_name) = clm_norm_name(r->>'name'))
  order by created_at limit 1;
  if v_old is not null then update clm_receivables set claim_id = v_id where id = v_old; end if;

  perform clm_transition(v_id, case when approved >= claimed - 1 then 'claim_approved' else 'claim_partial' end,
    jsonb_build_object('approved_amount', approved),
    case when approved >= claimed - 1 then 'Approved — as per the old Excel sheet' else 'Other — approved less, as per the old Excel sheet' end);

  -- the bill the approval put on the book takes the hospital bill no., so later letters find it
  select * into v_rec from clm_receivables where claim_id = v_id and debtor_type <> 'patient';
  if v_old is null then
    -- a new bill takes the hospital bill no. (made unique if another bill already carries it)
    update clm_receivables set
      bill_no = case when exists (select 1 from clm_receivables x where x.id <> v_rec.id and x.tenant_id = v_rec.tenant_id
                                    and x.centre_id = v_rec.centre_id and x.debtor_type = v_rec.debtor_type
                                    and x.bill_no = nullif(btrim(r->>'bill_no'), ''))
                     then btrim(r->>'bill_no') || ' (' || btrim(r->>'ip') || ')'
                     else coalesce(nullif(btrim(r->>'bill_no'), ''), bill_no) end,
      bill_date = v_bill, billed_amount = claimed, source = 'import'
    where id = v_rec.id;
  end if;

  -- payments: only when the bill has none on the book yet (a linked bill keeps the ones it has)
  if received > 0 and not exists (select 1 from clm_allocations a where a.receivable_id = v_rec.id and a.reversed_at is null) then
    v_utr := coalesce(v_utr, 'SHEET-' || coalesce(nullif(btrim(r->>'bill_no'), ''), btrim(r->>'ip')));
    v_pay := coalesce(v_pay, v_bill);
    insert into clm_import_batches (tenant_id, centre_id, kind, file_name, row_count)
    values (t, p_centre, 'weekly_payments', 'Old Excel sheet', 1) returning id into batch;
    insert into clm_remittance_lines (tenant_id, centre_id, payer_id, payer_name, utr, advice_date, claim_ref, bill_no, patient_name,
                                      approved_amount, claimed_amount, tds_amount, deduction_amount, net_amount,
                                      payment_date, source, file_name, receivable_id, import_batch_id)
    values (t, p_centre, v_rec.payer_id, v_rec.debtor_name, v_utr, v_pay, nullif(btrim(r->>'claim_no'), ''), nullif(btrim(r->>'bill_no'), ''),
            btrim(r->>'name'), approved, claimed, tds, 0, received, v_pay, 'letter', 'Old Excel sheet', v_rec.id, batch)
    on conflict do nothing returning id into rem;
    if rem is not null then
      rc := clm_bank_receipt_for(t, p_centre, v_utr, received);
      if rc is null then bank := clm_bank_credit_any(t, p_centre, v_utr); end if;
      if rc is null then
        insert into clm_receipts (tenant_id, centre_id, source, bank_account, value_date, amount, reference, narration, payer_id,
                                  import_batch_id, bank_receipt_id, bank_confirmed_on)
        values (t, p_centre, 'advice', 'advice:' || rem, v_pay, received, v_utr, 'Old Excel sheet', v_rec.payer_id,
                batch, bank, (select value_date from clm_receipts where id = bank))
        returning id into rc;
      end if;
      -- a small short payment on a bill the sheet marks settled was let go: booked, so the file closes
      short := approved - received - tds;
      if r->>'sheet_status' = 'Settled' and short >= 1 and short < clm_cut_floor() then
        insert into clm_adjustments (tenant_id, receivable_id, kind, amount, category, reason_text, remittance_line_id)
        values (t, v_rec.id, 'deduction', short, 'other', 'Short-paid under ₹1,000 — closed as per the old Excel sheet', rem);
      end if;
      if tds > 0 then
        insert into clm_adjustments (tenant_id, receivable_id, kind, amount, reason_text, remittance_line_id)
        values (t, v_rec.id, 'tds', tds, 'TDS as per settlement', rem);
      end if;
      insert into clm_allocations (tenant_id, receipt_id, receivable_id, amount, method, remittance_line_id)
      values (t, rc, v_rec.id, received, 'advice', rem);
    end if;
  end if;
  -- a linked bill already paid: a small short on a bill the sheet marks settled is let go, then the file closes
  if v_old is not null then
    select balance into v_bal from clm_v_receivable_balance where id = v_rec.id;
    if r->>'sheet_status' = 'Settled' and v_bal >= 1 and v_bal < clm_cut_floor()
       and not exists (select 1 from clm_adjustments where receivable_id = v_rec.id and kind = 'deduction' and reversed_at is null) then
      insert into clm_adjustments (tenant_id, receivable_id, kind, amount, category, reason_text)
      values (t, v_rec.id, 'deduction', v_bal, 'other', 'Short-paid under ₹1,000 — closed as per the old Excel sheet');
    else
      perform clm_settle_from_receivable(v_rec.id);
    end if;
  end if;
  -- the follow-up clock runs from the bill (or the payment), not from the day the sheet was loaded
  update clm_claims set status_changed_at = case when status = 'settled' then (coalesce(v_pay, v_bill)::text || 'T12:00:00+05:30')::timestamptz
                                                 else (v_bill::text || 'T12:00:00+05:30')::timestamptz end
  where id = v_id;
  perform set_config('claimone.source', '', true);
  perform set_config('claimone.note', '', true);
  return 'loaded';
end $$;
revoke execute on function clm_import_sheet_case(uuid, jsonb) from public, anon;
grant execute on function clm_import_sheet_case(uuid, jsonb) to authenticated;
