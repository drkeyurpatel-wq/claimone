// Money owed, read one way for every report: open bills with a balance, aged from the bill date.
import { sb } from '@/lib/supabase/browser';
import { allRows } from '@/lib/supabase/pages';
import { fetchAllPayers } from '@/lib/rcm/api';
import { ageing, type Ageing, type OpenBill, type PayerInfo } from '@/lib/rcm/overview';

export async function loadOwed(centreId: string): Promise<Ageing> {
  const [bills, payers] = await Promise.all([
    allRows<Record<string, unknown>>((f, t) => sb().from('clm_v_receivable_balance')
      .select('debtor_type, payer_id, debtor_name, doctor_name, balance, age_days, billed_amount, expected_amount, deduction, recon_status, status')
      .eq('centre_id', centreId).order('id').range(f, t)),
    fetchAllPayers(),
  ]);
  if (bills.error) throw new Error('Could not load money owed');
  const N = (x: unknown) => Number(x ?? 0);
  const pm = new Map<string, PayerInfo>(payers.map((p) => [p.id, { id: p.id, code: p.code, name: p.name }]));
  const B = ((bills.data ?? []) as Record<string, unknown>[]).map((b) => ({ ...b, balance: N(b.balance), age_days: N(b.age_days),
    billed_amount: b.billed_amount == null ? null : N(b.billed_amount), expected_amount: N(b.expected_amount), deduction: N(b.deduction) })) as OpenBill[];
  return ageing(B, pm);
}
