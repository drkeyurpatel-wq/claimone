-- ════════════════════════════════════════════════════════════════════
-- 0027 · Security tidy-up (database advisor findings, Oct 2026)
--   1. Trigger functions are not API calls: nobody needs EXECUTE on them
--      (triggers fire without it). Revoked from public, anon, authenticated.
--   2. clm_settle_from_receivable can be called through the API: it now
--      only acts on a bill of the caller's own tenant.
--   3. A file paid in parts keeps every transfer's UTR on its settlement.
--   4. The one-time staging table from the old-sheet load is dropped.
-- ════════════════════════════════════════════════════════════════════

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prorettype = 'trigger'::regtype and p.proname like 'clm\_%'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

CREATE OR REPLACE FUNCTION public.clm_settle_from_receivable(p_receivable uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r clm_receivables%rowtype; c clm_claims%rowtype;
  v_alloc numeric; v_tds numeric; v_adj numeric; v_balance numeric; v_claimed numeric; v_final numeric;
  v_utr text; v_date date; v_id uuid;
begin
  select * into r from clm_receivables where id = p_receivable;
  if not found or r.claim_id is null or r.debtor_type = 'patient' then return false; end if;
  -- called through the API, only for a bill of the caller's own hospital group
  if auth.uid() is not null and r.tenant_id is distinct from clm_current_tenant() then return false; end if;
  select * into c from clm_claims where id = r.claim_id for update;
  if c.status not in ('claim_approved','claim_partial','settlement_pending') then return false; end if;
  if exists (select 1 from clm_settlements where claim_id = c.id) then return false; end if;

  select coalesce(sum(a.amount), 0), max(rc.value_date) into v_alloc, v_date
  from clm_allocations a join clm_receipts rc on rc.id = a.receipt_id where a.receivable_id = r.id and a.reversed_at is null;
  select coalesce(sum(amount) filter (where kind = 'tds'), 0), coalesce(sum(amount), 0) into v_tds, v_adj
  from clm_adjustments where receivable_id = r.id and reversed_at is null;
  v_balance := round(r.expected_amount - v_alloc - v_adj, 2);
  if v_alloc <= 0 or abs(v_balance) > 1 then return false; end if;

  v_claimed := coalesce(c.claimed_amount, r.billed_amount, c.approved_amount, r.expected_amount);
  v_final := v_alloc + v_tds;
  -- a cut of ₹1,000 or more waits for "Accept the cut" or "Fight it"
  if v_claimed - v_final >= clm_cut_floor() and c.cut_decision is distinct from 'accepted' then return false; end if;

  -- paid in parts: every transfer's UTR, oldest first
  select string_agg(x.reference, ', ' order by x.d) into v_utr from (
    select rc.reference, min(rc.value_date) as d from clm_allocations a join clm_receipts rc on rc.id = a.receipt_id
    where a.receivable_id = r.id and a.reversed_at is null and nullif(btrim(rc.reference), '') is not null
    group by rc.reference) x;

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
end $function$;

revoke execute on function clm_settle_from_receivable(uuid) from public, anon;

drop table if exists public.tmp_sheet_stage;
