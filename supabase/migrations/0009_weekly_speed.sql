-- The weekly upload looked up bank credits through clm_v_receipt_balance,
-- which aggregates every receipt for every line (2,600-line PMJAY sheet hit
-- the statement timeout), and RLS kept the claim-no / bill-no lookups off
-- their indexes (clm_norm_ref is not leakproof, so it runs after the policy
-- on every row). Both lookups now run as definer helpers that check the
-- caller's tenant themselves and use the indexes.
create index if not exists clm_receipts_ref_upper on clm_receipts (tenant_id, centre_id, upper(reference)) where source = 'bank';

create or replace function clm_bank_receipt_for(p_tenant uuid, p_centre uuid, p_utr text, p_net numeric) returns uuid
language sql stable security definer set search_path = public as $$
  select rc.id from clm_receipts rc
  where rc.tenant_id = p_tenant and rc.centre_id = p_centre and rc.source = 'bank'
    and upper(rc.reference) = upper(p_utr)
    and p_tenant = clm_current_tenant() and clm_can_access_centre(p_centre)
    and rc.amount - coalesce((select sum(a.amount) from clm_allocations a where a.receipt_id = rc.id and a.reversed_at is null), 0) >= p_net - 0.5
  order by rc.value_date limit 1
$$;

revoke execute on function clm_bank_receipt_for(uuid, uuid, text, numeric) from public, anon;
grant execute on function clm_bank_receipt_for(uuid, uuid, text, numeric) to authenticated;

create or replace function clm_find_receivable(p_tenant uuid, p_centre uuid, p_claim text, p_bill text) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select id from clm_receivables
      where p_claim is not null and tenant_id = p_tenant and centre_id = p_centre and clm_norm_ref(claim_ref) = p_claim
        and debtor_type not in ('patient','referrer') order by created_at limit 1),
    (select id from clm_receivables
      where p_bill is not null and tenant_id = p_tenant and centre_id = p_centre and clm_norm_ref(bill_no) = p_bill
        and debtor_type not in ('patient','referrer') order by created_at limit 1))
  where p_tenant = clm_current_tenant() and clm_can_access_centre(p_centre)
$$;
revoke execute on function clm_find_receivable(uuid, uuid, text, text) from public, anon;
grant execute on function clm_find_receivable(uuid, uuid, text, text) to authenticated;
