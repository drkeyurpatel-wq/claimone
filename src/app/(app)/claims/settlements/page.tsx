'use client';
// Settlement tracker: approved money still to arrive, and money received.
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { IndianRupee, Clock, CheckCircle2, Receipt, TrendingDown } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import { fetchClaims } from '@/lib/claims/api';
import type { Claim } from '@/lib/claims/types';
import { PageHeader, StatCard, Skeleton, Empty, NoCentre, StatusPill, inr, inrShort, shortDate, daysSince } from '@/components/ui';

export default function Settlements() {
  const router = useRouter();
  const centreId = useAuthStore((s) => s.activeCentreId);
  const [rows, setRows] = useState<Claim[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'due' | 'received'>('due');

  useEffect(() => {
    if (!centreId) return;
    setLoading(true);
    fetchClaims(centreId, { statuses: ['claim_approved', 'claim_partial', 'settlement_pending', 'settled', 'closed'], limit: 1000 })
      .then((r) => { setRows(r); setLoading(false); });
  }, [centreId]);

  const due = useMemo(() => rows.filter((r) => ['claim_approved', 'claim_partial', 'settlement_pending'].includes(r.status))
    .sort((a, b) => (a.submitted_at ?? a.created_at).localeCompare(b.submitted_at ?? b.created_at)), [rows]);
  const received = useMemo(() => rows.filter((r) => r.settled_amount != null)
    .sort((a, b) => (b.settlement_date ?? '').localeCompare(a.settlement_date ?? '')), [rows]);
  const sum = (xs: Claim[], k: keyof Claim) => xs.reduce((s, x) => s + Number(x[k] ?? 0), 0);

  if (!centreId) return <NoCentre />;
  return (
    <div>
      <PageHeader title="Settlements" sub="Approved claims awaiting payment, and payments received" icon={IndianRupee} />
      <div className="grid grid-cols-2 gap-3 px-6 pt-4 md:grid-cols-4">
        <StatCard label="Approved, not paid" value={inrShort(sum(due, 'approved_amount'))} sub={`${due.length} claims`} icon={Clock} tone="purple" onClick={() => setTab('due')} />
        <StatCard label="Received (net)" value={inrShort(sum(received, 'settled_amount'))} sub={`${received.length} claims`} icon={CheckCircle2} tone="emerald" onClick={() => setTab('received')} />
        <StatCard label="TDS deducted" value={inrShort(sum(received, 'tds_amount'))} sub="claim against Form 26AS" icon={Receipt} />
        <StatCard label="Disallowed" value={inrShort(sum(received, 'deduction_amount'))}
          sub={sum(received, 'claimed_amount') ? `${(100 * sum(received, 'deduction_amount') / sum(received, 'claimed_amount')).toFixed(1)}% of claimed` : undefined}
          icon={TrendingDown} tone="rose" onClick={() => router.push('/claims/leakage')} />
      </div>
      <div className="flex gap-2 px-6 pt-4">
        {(['due', 'received'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`rounded-lg px-3 py-1.5 text-xs font-medium ${tab === t ? 'bg-teal-600 text-white' : 'border bg-white text-slate-600'}`}>
            {t === 'due' ? `Awaiting payment · ${due.length}` : `Received · ${received.length}`}
          </button>
        ))}
      </div>
      <div className="px-6 py-4">
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          {loading ? <Skeleton /> : (tab === 'due' ? due : received).length === 0 ? <Empty icon={IndianRupee} title="Nothing here yet" /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b bg-slate-50/80 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-3">Patient</th><th className="px-4 py-3">Payer</th><th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Claimed</th><th className="px-4 py-3 text-right">Approved</th>
                  {tab === 'due' ? <th className="px-4 py-3 text-right">Days since filing</th> : <>
                    <th className="px-4 py-3 text-right">TDS</th><th className="px-4 py-3 text-right">Net received</th><th className="px-4 py-3">UTR · date</th></>}
                </tr></thead>
                <tbody>
                  {(tab === 'due' ? due : received).map((c) => {
                    const d = daysSince(c.submitted_at);
                    return (
                      <tr key={c.id} onClick={() => router.push(`/case/${c.id}`)} className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-teal-50/40">
                        <td className="px-4 py-3"><p className="font-medium">{c.patient_name}</p><p className="font-mono text-[11px] text-slate-400">{c.claim_number}</p></td>
                        <td className="px-4 py-3 text-xs text-slate-600">{c.clm_payers?.name}</td>
                        <td className="px-4 py-3"><StatusPill status={c.status} /></td>
                        <td className="tabular px-4 py-3 text-right">{inr(c.claimed_amount)}</td>
                        <td className="tabular px-4 py-3 text-right">{inr(c.approved_amount)}</td>
                        {tab === 'due'
                          ? <td className={`tabular px-4 py-3 text-right font-semibold ${d != null && d > 45 ? 'text-rose-600' : 'text-slate-700'}`}>{d ?? '—'}</td>
                          : <>
                            <td className="tabular px-4 py-3 text-right text-slate-500">{inr(c.tds_amount)}</td>
                            <td className="tabular px-4 py-3 text-right font-semibold text-emerald-700">{inr(c.settled_amount)}</td>
                            <td className="px-4 py-3 font-mono text-xs">{c.settlement_utr ?? '—'}<span className="ml-2 font-sans text-slate-400">{shortDate(c.settlement_date)}</span></td>
                          </>}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
