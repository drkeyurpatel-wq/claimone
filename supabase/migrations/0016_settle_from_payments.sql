-- ════════════════════════════════════════════════════════════════════
-- Money closes the claim. When a case's bill on the receivables book is
-- fully accounted for (paid + TDS + reasoned deductions = owed), the claim
-- is settled automatically from those figures, so claim-based screens
-- (claims list, MIS, payer scorecard) agree with the patient's file.
--   final approved = received + TDS        (what the payer actually honoured)
--   deduction      = claimed − final approved
--   net            = final approved − TDS = received
-- The claim's approved_amount keeps the insurer's approval, so leakage still
-- splits the loss into "cut at approval" and "paid short".
-- ════════════════════════════════════════════════════════════════════

create or replace function clm_settle_from_receivable(p_receivable uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  r clm_receivables%rowtype; c clm_claims%rowtype;
  v_alloc numeric; v_tds numeric; v_adj numeric; v_balance numeric; v_claimed numeric; v_final numeric;
  v_utr text; v_date date; v_id uuid;
begin
  select * into r from clm_receivables where id = p_receivable;
  if not found or r.claim_id is null or r.debtor_type = 'patient' then return false; end if;
  select * into c from clm_claims where id = r.claim_id for update;
  if c.status not in ('claim_approved','claim_partial','settlement_pending') then return false; end if;
  if exists (select 1 from clm_settlements where claim_id = c.id) then return false; end if;

  select coalesce(sum(a.amount), 0), max(rc.value_date) into v_alloc, v_date
  from clm_allocations a join clm_receipts rc on rc.id = a.receipt_id where a.receivable_id = r.id and a.reversed_at is null;
  select coalesce(sum(amount) filter (where kind = 'tds'), 0), coalesce(sum(amount), 0) into v_tds, v_adj
  from clm_adjustments where receivable_id = r.id and reversed_at is null;
  v_balance := round(r.expected_amount - v_alloc - v_adj, 2);
  if v_alloc <= 0 or abs(v_balance) > 1 then return false; end if;

  select rc.reference into v_utr from clm_allocations a join clm_receipts rc on rc.id = a.receipt_id
  where a.receivable_id = r.id and a.reversed_at is null order by rc.value_date desc, a.created_at desc limit 1;

  v_claimed := coalesce(c.claimed_amount, r.billed_amount, c.approved_amount, r.expected_amount);
  v_final := v_alloc + v_tds;
  -- one UTR often pays many bills (PMJAY), so the settlement row carries it only when unused
  insert into clm_settlements (tenant_id, claim_id, claimed_amount, approved_amount, deduction_amount, tds_amount, net_amount,
                               utr_number, payment_date, payment_mode, is_reconciled, source, recorded_by)
  values (c.tenant_id, c.id, greatest(v_claimed, v_final), v_final, greatest(v_claimed - v_final, 0), v_tds, v_alloc,
          case when v_utr is not null and not exists (select 1 from clm_settlements s where s.tenant_id = c.tenant_id and s.utr_number = v_utr)
               then v_utr end,
          coalesce(v_date, current_date), 'neft', true, 'recon', auth.uid())
  returning id into v_id;

  perform set_config('claimone.source', 'recon', true);
  perform set_config('claimone.note', 'Paid and reconciled from the payment upload', true);
  update clm_claims set
    settled_amount = v_alloc, tds_amount = v_tds, deduction_amount = greatest(v_claimed - v_final, 0),
    settlement_utr = v_utr, settlement_date = coalesce(v_date, current_date), status = 'settled'
  where id = c.id;
  perform set_config('claimone.source', '', true);
  perform set_config('claimone.note', '', true);
  return true;
end $$;

create or replace function clm_settle_after_money() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform clm_settle_from_receivable(new.receivable_id);
  return null;
end $$;

drop trigger if exists clm_alloc_settle on clm_allocations;
create trigger clm_alloc_settle after insert on clm_allocations for each row execute function clm_settle_after_money();
drop trigger if exists clm_adj_settle on clm_adjustments;
create trigger clm_adj_settle after insert on clm_adjustments for each row execute function clm_settle_after_money();

-- cases already fully paid
do $$ declare x record; begin
  for x in select r.id from clm_receivables r join clm_claims c on c.id = r.claim_id
           where c.status in ('claim_approved','claim_partial','settlement_pending') and r.debtor_type <> 'patient' loop
    perform clm_settle_from_receivable(x.id);
  end loop;
end $$;

do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'clm\_%' loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;
grant execute on function clm_nhcx_receive(text, jsonb) to anon;
