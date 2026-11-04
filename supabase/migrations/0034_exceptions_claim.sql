-- "To check" shows only bills with no patient on Master (a bill on Master is worked from its Payment cell).
-- The exceptions view gains the bill's claim, appended so existing readers are unaffected.
create or replace view clm_v_exceptions with (security_invoker = true) as
 SELECT b.id AS receivable_id,
    b.centre_id,
    b.debtor_type,
    b.debtor_name,
    b.patient_name,
    r.uhid,
    b.bill_no,
    b.claim_ref,
    b.bill_date,
    b.expected_amount,
    b.allocated,
    b.tds,
    b.deduction,
    b.balance,
    b.age_days,
    b.last_receipt_date,
        CASE
            WHEN b.recon_status = 'part_received'::text AND b.balance > 1::numeric THEN 'short'::text
            WHEN b.recon_status = 'over_received'::text THEN 'over'::text
            WHEN b.recon_status = 'open'::text AND b.age_days >
            CASE
                WHEN b.debtor_type = 'government'::text THEN 45
                ELSE 30
            END THEN 'overdue'::text
            ELSE NULL::text
        END AS problem,
    r.claim_id
   FROM clm_v_receivable_balance b
     JOIN clm_receivables r ON r.id = b.id
  WHERE b.status = 'open'::text AND (b.recon_status = 'part_received'::text AND b.balance > 1::numeric OR b.recon_status = 'over_received'::text OR b.recon_status = 'open'::text AND b.age_days >
        CASE
            WHEN b.debtor_type = 'government'::text THEN 45
            ELSE 30
        END);
grant select on clm_v_exceptions to authenticated;
