-- 0028 · Indexes for the lookups Master and the payment upload make on every row
-- (database advisor: unindexed foreign keys on the hot paths).
create index if not exists clm_remit_receivable_idx on clm_remittance_lines (receivable_id);
create index if not exists clm_settlements_claim_idx on clm_settlements (claim_id);
create index if not exists clm_receipts_bank_receipt_idx on clm_receipts (bank_receipt_id) where bank_receipt_id is not null;
create index if not exists clm_alloc_remit_idx on clm_allocations (remittance_line_id) where remittance_line_id is not null;
create index if not exists clm_adj_remit_idx on clm_adjustments (remittance_line_id) where remittance_line_id is not null;
