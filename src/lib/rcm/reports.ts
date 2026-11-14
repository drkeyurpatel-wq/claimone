// Money owed, read one way for every report: open bills with a balance, aged from the bill date.
import { sb } from '@/lib/supabase/browser';
import { allRows } from '@/lib/supabase/pages';
import { fetchAllPayers, fetchDischargeDays } from './api';
import { isOldBill } from './ledger';
import { ageing, type Ageing, type OpenBill, type PayerInfo } from './overview';

export type Era = 'current' | 'old';

/** `era`: 'current' = files from 1 Nov (every report screen); 'old' = the Before 1 Nov tab. */
export async function loadOwed(centreId: string, era: Era = 'current'): Promise<Ageing> {
  const [bills, payers, days] = await Promise.all([
    allRows<Record<string, unknown>>((f, t) => sb().from('clm_v_receivable_balance')
      .select('debtor_type, payer_id, debtor_name, doctor_name, balance, age_days, billed_amount, expected_amount, deduction, recon_status, status, bill_date, claim_id')
      .eq('centre_id', centreId).order('id').range(f, t)),
    fetchAllPayers(),
    fetchDischargeDays(centreId),
  ]);
  if (bills.error) throw new Error('Could not load money owed');
  const N = (x: unknown) => Number(x ?? 0);
  const pm = new Map<string, PayerInfo>(payers.map((p) => [p.id, { id: p.id, code: p.code, name: p.name }]));
  const B = ((bills.data ?? []) as Record<string, unknown>[])
    .filter((b) => isOldBill(b.bill_date as string | null, days.get(String(b.claim_id ?? '')), !!b.claim_id && days.has(String(b.claim_id))) === (era === 'old'))
    .map((b) => ({ ...b, balance: N(b.balance), age_days: N(b.age_days),
      billed_amount: b.billed_amount == null ? null : N(b.billed_amount), expected_amount: N(b.expected_amount), deduction: N(b.deduction) })) as OpenBill[];
  return ageing(B, pm);
}
