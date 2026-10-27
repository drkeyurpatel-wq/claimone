/**
 * Settlement arithmetic. Mirrors clm_record_settlement in 0001_core.sql.
 *
 *   deduction = claimed − approved    (what the payer disallowed)
 *   net       = approved − TDS        (what lands in the bank)
 *
 * H1 Claims computed net = settlement − deduction and hard-coded TDS to 0,
 * so every settled claim overstated cash received by the TDS amount.
 */

export const DISALLOWANCE_CATEGORIES = {
  room_rent_cap: { label: 'Room rent cap', preventable: true },
  non_payable: { label: 'Non-payable items', preventable: true },
  doc_missing: { label: 'Missing documents', preventable: true },
  tariff_excess: { label: 'Above agreed tariff', preventable: true },
  query_tat: { label: 'Query not answered in time', preventable: true },
  pre_existing: { label: 'Pre-existing disease', preventable: false },
  policy_exclusion: { label: 'Policy exclusion', preventable: false },
  co_pay: { label: 'Co-pay', preventable: false },
  other: { label: 'Other', preventable: false },
} as const;

export type DisallowanceCategory = keyof typeof DISALLOWANCE_CATEGORIES;

export interface SettlementInput {
  claimed: number;
  approved: number;
  tds: number;
  net: number;
  items: { category: DisallowanceCategory; amount: number }[];
}

export interface SettlementCheck {
  ok: boolean;
  deduction: number;
  expectedNet: number;
  errors: string[];
}

const TOLERANCE = 1; // rupee rounding on payer advices

export function checkSettlement(s: SettlementInput): SettlementCheck {
  const errors: string[] = [];
  const deduction = round2(s.claimed - s.approved);
  const expectedNet = round2(s.approved - s.tds);

  if ([s.claimed, s.approved, s.tds, s.net].some((n) => !Number.isFinite(n) || n < 0)) {
    errors.push('Amounts must be zero or more.');
  }
  if (s.approved > s.claimed) errors.push('Approved cannot be more than claimed.');
  if (Math.abs(expectedNet - s.net) > TOLERANCE) {
    errors.push(`Net should be approved − TDS = ₹${fmt(expectedNet)}.`);
  }
  if (s.items.length > 0) {
    const sum = round2(s.items.reduce((t, i) => t + i.amount, 0));
    if (Math.abs(sum - deduction) > TOLERANCE) {
      errors.push(`Itemised deductions add to ₹${fmt(sum)}, but the deduction is ₹${fmt(deduction)}.`);
    }
  }
  return { ok: errors.length === 0, deduction, expectedNet, errors };
}

function round2(n: number) { return Math.round(n * 100) / 100; }
function fmt(n: number) { return n.toLocaleString('en-IN', { maximumFractionDigits: 2 }); }
