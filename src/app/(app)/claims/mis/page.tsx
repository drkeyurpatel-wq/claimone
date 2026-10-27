'use client';
// MIS: receivable ageing by payer and the claim pipeline by status.
import { useEffect, useMemo, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import { fetchAging, fetchClaims } from '@/lib/claims/api';
import { STATUS_CONFIG, type AgingRow, type Claim, type ClaimStatus } from '@/lib/claims/types';
import { PageHeader, Skeleton, NoCentre, inrShort } from '@/components/ui';

const BUCKETS = ['0-30', '31-60', '61-90', '91-180', '180+'] as const;
const BUCKET_COLOR: Record<string, string> = { '0-30': '#0d9488', '31-60': '#2563eb', '61-90': '#d97706', '91-180': '#ea580c', '180+': '#dc2626' };

export default function MIS() {
  const centreId = useAuthStore((s) => s.activeCentreId);
  const [aging, setAging] = useState<AgingRow[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!centreId) return;
    setLoading(true);
    Promise.all([fetchAging(centreId), fetchClaims(centreId, { limit: 5000 })]).then(([a, c]) => { setAging(a); setClaims(c); setLoading(false); });
  }, [centreId]);

  const byBucket = useMemo(() => BUCKETS.map((b) => ({
    bucket: b,
    amount: aging.filter((r) => r.aging_bucket === b).reduce((s, r) => s + Number(r.total_amount), 0),
    count: aging.filter((r) => r.aging_bucket === b).reduce((s, r) => s + r.claim_count, 0),
  })), [aging]);
  const total = byBucket.reduce((s, b) => s + b.amount, 0);

  const payers = useMemo(() => {
    const m = new Map<string, Record<string, number> & { name: string; total: number }>();
    for (const r of aging) {
      const row = m.get(r.payer_id) ?? Object.assign({ name: r.payer_name, total: 0 }, Object.fromEntries(BUCKETS.map((b) => [b, 0])));
      row[r.aging_bucket] += Number(r.total_amount);
      row.total += Number(r.total_amount);
      m.set(r.payer_id, row);
    }
    return [...m.values()].sort((a, b) => b.total - a.total);
  }, [aging]);

  const statusRows = useMemo(() => {
    const m = new Map<ClaimStatus, { count: number; amount: number }>();
    for (const c of claims) {
      const v = m.get(c.status) ?? { count: 0, amount: 0 };
      v.count++; v.amount += Number(c.approved_amount ?? c.claimed_amount ?? c.estimated_amount ?? 0);
      m.set(c.status, v);
    }
    return (Object.keys(STATUS_CONFIG) as ClaimStatus[]).filter((s) => m.has(s)).map((s) => ({ status: s, ...m.get(s)! }));
  }, [claims]);
  const maxStatus = Math.max(1, ...statusRows.map((r) => r.count));

  if (!centreId) return <NoCentre />;
  return (
    <div>
      <PageHeader title="MIS" sub="Money owed by payers, by age; claims by status" icon={BarChart3} />
      {loading ? <div className="p-6"><Skeleton rows={10} /></div> : (
        <div className="space-y-4 px-6 py-4">
          <section className="rounded-2xl border border-slate-200 bg-white p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-bold text-slate-900">Receivable ageing — days since the claim was filed</h2>
              <p className="tabular text-sm text-slate-600">Total outstanding <b className="text-slate-900">{inrShort(total)}</b></p>
            </div>
            <div className="mt-4 flex h-8 w-full overflow-hidden rounded-lg bg-slate-100" role="img" aria-label="Outstanding amount by age bucket">
              {byBucket.filter((b) => b.amount > 0).map((b) => (
                <div key={b.bucket} title={`${b.bucket} days: ${inrShort(b.amount)}`} style={{ width: `${(100 * b.amount) / total}%`, background: BUCKET_COLOR[b.bucket] }} />
              ))}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-5">
              {byBucket.map((b) => (
                <div key={b.bucket} className="rounded-lg border border-slate-100 p-3">
                  <p className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: BUCKET_COLOR[b.bucket] }} />{b.bucket} days</p>
                  <p className="tabular mt-1 text-lg font-bold">{inrShort(b.amount)}</p>
                  <p className="text-[11px] text-slate-400">{b.count} claims{total ? ` · ${((100 * b.amount) / total).toFixed(0)}%` : ''}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
            <h2 className="px-5 pt-5 text-sm font-bold text-slate-900">Outstanding by payer</h2>
            <div className="overflow-x-auto p-2">
              <table className="w-full text-sm">
                <thead><tr className="border-b text-left text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  <th className="px-3 py-2">Payer</th>{BUCKETS.map((b) => <th key={b} className="px-3 py-2 text-right">{b}</th>)}<th className="px-3 py-2 text-right">Total</th>
                </tr></thead>
                <tbody>
                  {payers.length === 0 ? <tr><td colSpan={7} className="py-8 text-center text-slate-400">Nothing outstanding</td></tr> : payers.map((p) => (
                    <tr key={p.name} className="border-b border-slate-50 last:border-0">
                      <td className="px-3 py-2 font-medium">{p.name}</td>
                      {BUCKETS.map((b) => <td key={b} className={`tabular px-3 py-2 text-right ${p[b] && (b === '91-180' || b === '180+') ? 'font-semibold text-rose-600' : 'text-slate-600'}`}>{p[b] ? inrShort(p[b]) : '—'}</td>)}
                      <td className="tabular px-3 py-2 text-right font-bold">{inrShort(p.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="rounded-2xl border border-slate-200 bg-white p-5">
            <h2 className="mb-4 text-sm font-bold text-slate-900">Claims by status</h2>
            <div className="space-y-2">
              {statusRows.map((r) => (
                <div key={r.status} className="grid grid-cols-12 items-center gap-3 text-sm">
                  <span className="col-span-3 text-slate-600">{STATUS_CONFIG[r.status].label}</span>
                  <div className="col-span-6 h-5 rounded bg-slate-100"><div className="h-5 rounded bg-teal-500" style={{ width: `${(100 * r.count) / maxStatus}%` }} /></div>
                  <span className="tabular col-span-1 text-right font-semibold">{r.count}</span>
                  <span className="tabular col-span-2 text-right text-slate-500">{inrShort(r.amount)}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
