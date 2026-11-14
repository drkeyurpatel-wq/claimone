'use client';
// Reports → Dashboard. Headline numbers only; Money owed and Deductions hold the detail.
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import { sb } from '@/lib/supabase/browser';
import { allRows } from '@/lib/supabase/pages';
import { fetchOpenCases } from '@/lib/rcm/api';
import { fetchDeductionLines } from '@/lib/claims/api';
import { CURRENT_FROM, isOldBill, isOldCase, isOldDate } from '@/lib/rcm/ledger';
import { loadOwed } from '@/lib/rcm/reports';
import { collections, deductions, pipeline, turnaround, type LeakLite, type ReceiptLite, type TransitionLite } from '@/lib/rcm/overview';
import { NoCentre } from '@/components/ui';
import { DashboardView, type DashboardData } from '@/components/report/DashboardView';

const since = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

/** Everything on the Dashboard is about files discharged on or after 1 Nov (CURRENT_FROM). */
async function load(centreId: string): Promise<DashboardData> {
  const [age, lines, paid, trans, cases] = await Promise.all([
    loadOwed(centreId),
    fetchDeductionLines(),
    // money received, taken bill by bill so that money for an older file is left out
    allRows<Record<string, unknown>>((f, t) => sb().from('clm_allocations')
      .select('id, amount, clm_receipts!inner(value_date), clm_receivables!inner(centre_id, bill_date, claim_id, clm_claims(discharge_date, discharged_at))')
      .eq('clm_receivables.centre_id', centreId).is('reversed_at', null).gte('clm_receipts.value_date', CURRENT_FROM).order('id').range(f, t)),
    allRows<Record<string, unknown>>((f, t) => sb().from('clm_state_transitions').select('claim_id, from_status, to_status, created_at, clm_claims!inner(centre_id, discharge_date, discharged_at)')
      .eq('clm_claims.centre_id', centreId).gte('created_at', since(180)).order('id').range(f, t)),
    fetchOpenCases(centreId),
  ]);
  if (paid.error) throw new Error('Could not load the dashboard');
  const N = (x: unknown) => Number(x ?? 0);
  type Case = { discharge_date: string | null; discharged_at: string | null };
  const ded = deductions(lines.filter((l) => l.centre_id === centreId && !!l.file_date && !isOldDate(l.file_date))
    .map((l) => ({ kind: l.kind, category: l.category, doctor_name: l.doctor_name, amount: l.amount })) as LeakLite[]);
  const receipts: ReceiptLite[] = ((paid.data ?? []) as unknown as { amount: number; clm_receipts: { value_date: string }; clm_receivables: { bill_date: string | null; claim_id: string | null; clm_claims: Case | null } }[])
    .filter((a) => { const c = a.clm_receivables.clm_claims; return !isOldBill(a.clm_receivables.bill_date, c ? (c.discharge_date ?? c.discharged_at?.slice(0, 10)) : null, !!c); })
    .map((a) => ({ value_date: a.clm_receipts.value_date, amount: N(a.amount), source: 'paid' }));
  const now = new Date();
  const months = Math.min(6, Math.max(1, (now.getFullYear() - Number(CURRENT_FROM.slice(0, 4))) * 12 + now.getMonth() + 1 - Number(CURRENT_FROM.slice(5, 7)) + 1));
  return {
    age,
    pipe: pipeline(cases.filter((x) => !isOldCase(x.c)).map((x) => x.step)),
    ded: { total: ded.total, fighting: ded.fighting },
    coll: collections(receipts, months),
    tat: turnaround(((trans.data ?? []) as unknown as (TransitionLite & { clm_claims: Case })[]).filter((r) => !isOldCase(r.clm_claims))),
  };
}

export default function Overview() {
  const centreId = useAuthStore((s) => s.activeCentreId);
  const [d, setD] = useState<DashboardData | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!centreId) return;
    setD(null); setError('');
    load(centreId).then(setD).catch((e) => setError((e as Error).message));
  }, [centreId]);

  if (!centreId) return <NoCentre />;
  if (error) return <p role="alert" className="m-8 rounded-lg bg-rose-50 p-4 text-base text-rose-800">{error}</p>;
  if (!d) return <div className="flex min-h-[60vh] items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-teal-600" /></div>;
  return <DashboardView d={d} />;
}
