/**
 * "Before 1 Nov": files discharged before CURRENT_FROM. The pending figure was frozen once (clm_old_opening, 0039);
 * this puts it beside what is pending today. Pending = bills with money still owed + claims submitted and not decided.
 */
import type { Ageing } from './overview';

export interface OldOpening { as_on: string; bills: number; bill_amount: number; claims: number; claim_amount: number }
export interface OldSummary {
  opening: { as_on: string; files: number; amount: number } | null;
  submitted: { files: number; amount: number };
  now: { files: number; amount: number };
  /** Opening less pending now: money received, deductions accepted and corrections since the freeze. */
  cleared: { files: number; amount: number } | null;
}

export function oldSummary(frozen: OldOpening | null, owed: Pick<Ageing, 'total' | 'count'>, submittedAmounts: number[]): OldSummary {
  const submitted = { files: submittedAmounts.length, amount: Math.round(submittedAmounts.reduce((a, x) => a + x, 0)) };
  const now = { files: owed.count + submitted.files, amount: owed.total + submitted.amount };
  const opening = frozen ? { as_on: frozen.as_on, files: frozen.bills + frozen.claims, amount: Math.round(frozen.bill_amount + frozen.claim_amount) } : null;
  return { opening, submitted, now, cleared: opening ? { files: Math.max(0, opening.files - now.files), amount: Math.max(0, opening.amount - now.amount) } : null };
}
