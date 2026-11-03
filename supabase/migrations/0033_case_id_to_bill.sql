-- A claim / PMJAY case ID added or corrected after approval reaches the bill too,
-- so settlement files that quote it still find the bill.
create or replace function clm_claim_ref_to_bill() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.tpa_claim_number is not null then
    update clm_receivables set claim_ref = new.tpa_claim_number
    where claim_id = new.id and debtor_type <> 'patient' and claim_ref is distinct from new.tpa_claim_number;
  end if;
  return null;
end $$;
revoke execute on function clm_claim_ref_to_bill() from public, anon, authenticated;

drop trigger if exists clm_claims_ref_to_bill on clm_claims;
create trigger clm_claims_ref_to_bill after update of tpa_claim_number on clm_claims
for each row when (new.tpa_claim_number is distinct from old.tpa_claim_number)
execute function clm_claim_ref_to_bill();
