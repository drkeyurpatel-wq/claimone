-- A payment that came with a UTR is in the bank. A bank statement uploaded later only verifies it (the blue tick).
-- clm_v_case_banked gains with_utr: of the money received on a case, how much came with a UTR / reference.
create or replace view clm_v_case_banked with (security_invoker = true) as
select r.claim_id, r.centre_id,
       coalesce(sum(a.amount) filter (where rc.source = 'bank' or rc.bank_receipt_id is not null), 0) as banked,
       coalesce(sum(a.amount), 0) as received,
       count(distinct a.receipt_id)::int as parts,
       max(rc.value_date) as last_paid,
       coalesce(sum(a.amount) filter (where nullif(btrim(rc.reference), '') is not null or rc.source = 'bank' or rc.bank_receipt_id is not null), 0) as with_utr
from clm_allocations a
join clm_receivables r on r.id = a.receivable_id
join clm_receipts rc on rc.id = a.receipt_id
where a.reversed_at is null and r.claim_id is not null and r.debtor_type <> 'patient'
group by r.claim_id, r.centre_id;

grant select on clm_v_case_banked to authenticated;
