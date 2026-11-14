'use client';
// Before 1 Nov → Summary. Files discharged before 1 Nov 2026: the figure frozen on the day of the split, and what is
// still pending today. Money that arrives for these files is applied as usual and brings "pending now" down.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2 } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import { sb } from '@/lib/supabase/browser';
import { allRows } from '@/lib/supabase/pages';
import { loadOwed } from '@/lib/rcm/reports';
import { CURRENT_FROM } from '@/lib/rcm/ledger';
import { oldSummary, type OldOpening, type OldSummary } from '@/lib/rcm/before';
import type { Ageing } from '@/lib/rcm/overview';
import { NoCentre, inr, inrShort, shortDate } from '@/components/ui';
import { ReportPage, Tile, Panel } from '@/components/report/kit';

const n = (x: number) => x.toLocaleString('en-IN');

async function load(centreId: string): Promise<{ age: Ageing; s: OldSummary }> {
  const [age, claims, opening] = await Promise.all([
    loadOwed(centreId, 'old'),
    allRows<Record<string, unknown>>((f, t) => sb().from('clm_claims').select('id, claimed_amount, package_amount')
      .eq('centre_id', centreId).eq('status', 'claim_submitted').lt('discharge_date', CURRENT_FROM).order('id').range(f, t)),
    sb().from('clm_old_opening').select('as_on, bills, bill_amount, claims, claim_amount').eq('centre_id', centreId).maybeSingle(),
  ]);
  if (claims.error) throw new Error('Could not load the files from before 1 Nov');
  const o = opening.data as Record<string, unknown> | null;
  const frozen: OldOpening | null = o ? { as_on: String(o.as_on), bills: Number(o.bills), bill_amount: Number(o.bill_amount), claims: Number(o.claims), claim_amount: Number(o.claim_amount) } : null;
  return { age, s: oldSummary(frozen, age, (claims.data ?? []).map((c) => Number(c.claimed_amount ?? c.package_amount ?? 0))) };
}

export default function BeforeSummary() {
  const centreId = useAuthStore((s) => s.activeCentreId);
  const [d, setD] = useState<{ age: Ageing; s: OldSummary } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!centreId) return;
    setD(null); setError('');
    load(centreId).then(setD).catch((e) => setError((e as Error).message));
  }, [centreId]);

  if (!centreId) return <NoCentre />;
  if (error) return <p role="alert" className="m-8 rounded-lg bg-rose-50 p-4 text-base text-rose-800">{error}</p>;
  if (!d) return <div className="flex min-h-[60vh] items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-teal-600" /></div>;
  const { age, s } = d;
  return (
    <ReportPage title="Before 1 Nov" sub="Files discharged before 1 Nov 2026. They are kept here only — Master, Archive, Dashboard, Money owed and Deductions count files from 1 Nov onwards.">
      <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-3">
        <Tile label={s.opening ? `Pending on ${shortDate(s.opening.as_on)} (frozen)` : 'Pending when frozen'} value={s.opening ? inrShort(s.opening.amount) : '—'}
          sub={s.opening ? `${n(s.opening.files)} files` : 'Not recorded for this hospital'} />
        <Tile label="Pending now" value={inrShort(s.now.amount)} sub={`${n(s.now.files)} files`} tone={s.now.amount > 0 ? 'text-rose-700' : undefined} />
        <Tile label="Cleared since" value={s.cleared ? inrShort(s.cleared.amount) : '—'} sub={s.cleared ? `${n(s.cleared.files)} files` : undefined} tone="text-emerald-700" />
      </div>

      <Panel title="Pending now" flush right={<Link href="/before/pending" className="text-sm font-semibold text-teal-700 underline">Open the files</Link>}>
        {s.now.files === 0 ? <p className="px-5 pb-5 text-base text-slate-500">Nothing pending from before 1 Nov.</p> : (
          <div className="overflow-x-auto">
            <table className="mt-3 w-full border-collapse text-base">
              <thead><tr className="border-y border-slate-200 bg-slate-50 text-left text-sm uppercase tracking-wide text-slate-500">
                <th className="px-5 py-2 font-semibold">Payer</th><th className="px-5 py-2 text-right font-semibold">Files</th><th className="px-5 py-2 text-right font-semibold">Amount</th></tr></thead>
              <tbody>
                {age.byPayer.map((p) => (
                  <tr key={p.name} className="border-b border-slate-100"><td className="px-5 py-2">{p.name}</td>
                    <td className="px-5 py-2 text-right tabular-nums">{n(p.count)}</td><td className="px-5 py-2 text-right tabular-nums">{inr(p.total)}</td></tr>
                ))}
                {s.submitted.files > 0 && <tr className="border-b border-slate-100"><td className="px-5 py-2">Claims submitted, not decided yet <span className="text-sm text-slate-500">(claimed amount)</span></td>
                  <td className="px-5 py-2 text-right tabular-nums">{n(s.submitted.files)}</td><td className="px-5 py-2 text-right tabular-nums">{inr(s.submitted.amount)}</td></tr>}
                <tr className="font-bold"><td className="px-5 py-2">Total</td><td className="px-5 py-2 text-right tabular-nums">{n(s.now.files)}</td><td className="px-5 py-2 text-right tabular-nums">{inr(s.now.amount)}</td></tr>
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </ReportPage>
  );
}
