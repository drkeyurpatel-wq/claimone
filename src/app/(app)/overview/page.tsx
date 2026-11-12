'use client';
// Reports → Dashboard. Headline numbers only; Money owed and Deductions hold the detail.
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import { sb } from '@/lib/supabase/browser';
import { allRows } from '@/lib/supabase/pages';
import { fetchOpenCases } from '@/lib/rcm/api';
import { loadOwed } from '@/lib/rcm/reports';
import { collections, deductions, pipeline, turnaround, type LeakLite, type ReceiptLite, type TransitionLite } from '@/lib/rcm/overview';
import { NoCentre } from '@/components/ui';
import { DashboardView, type DashboardData } from '@/components/report/DashboardView';

const since = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

async function load(centreId: string): Promise<DashboardData> {
  const [age, adj, rcpt, trans, cases] = await Promise.all([
    loadOwed(centreId),
    allRows<Record<string, unknown>>((f, t) => sb().from('clm_v_leakage').select('kind, category, doctor_name, amount, month')
      .eq('centre_id', centreId).gte('month', since(365).slice(0, 10)).order('month').order('payer_id').order('doctor_name').order('category').range(f, t)),
    allRows<Record<string, unknown>>((f, t) => sb().from('clm_receipts').select('value_date, amount, source, bank_receipt_id')
      .eq('centre_id', centreId).gte('value_date', since(200).slice(0, 10)).order('id').range(f, t)),
    allRows<Record<string, unknown>>((f, t) => sb().from('clm_state_transitions').select('claim_id, from_status, to_status, created_at, clm_claims!inner(centre_id)')
      .eq('clm_claims.centre_id', centreId).gte('created_at', since(180)).order('id').range(f, t)),
    fetchOpenCases(centreId),
  ]);
  const N = (x: unknown) => Number(x ?? 0);
  const ded = deductions(((adj.data ?? []) as unknown as LeakLite[]).map((a) => ({ ...a, amount: N(a.amount) })));
  return {
    age,
    pipe: pipeline(cases.map((x) => x.step)),
    ded: { total: ded.total, fighting: ded.fighting },
    coll: collections(((rcpt.data ?? []) as unknown as ReceiptLite[]).map((r) => ({ ...r, amount: N(r.amount) }))),
    tat: turnaround((trans.data ?? []) as unknown as TransitionLite[]),
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
