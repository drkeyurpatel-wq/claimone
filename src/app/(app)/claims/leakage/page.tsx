'use client';
// Leakage (ClaimOne's "where the money is lost"): every disallowed rupee,
// by reason, payer and doctor — and how much of it a process fix recovers.
import { useEffect, useMemo, useState } from 'react';
import { TrendingDown } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import { fetchLeakage } from '@/lib/claims/api';
import type { LeakageRow } from '@/lib/claims/types';
import { DISALLOWANCE_CATEGORIES, type DisallowanceCategory } from '@/lib/engine/settlement';
import { PageHeader, Skeleton, NoCentre, Empty, StatCard, inrShort } from '@/components/ui';

function Bars({ title, rows }: { title: string; rows: { label: string; amount: number; preventable?: boolean }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.amount));
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5">
      <h2 className="mb-4 text-sm font-bold text-slate-900">{title}</h2>
      {rows.length === 0 ? <p className="text-sm text-slate-400">No data yet</p> : (
        <div className="space-y-2.5">
          {rows.map((r) => (
            <div key={r.label} className="grid grid-cols-12 items-center gap-3 text-sm">
              <span className="col-span-4 truncate text-slate-700" title={r.label}>{r.label}</span>
              <div className="col-span-6 h-5 rounded bg-slate-100">
                <div className={`h-5 rounded ${r.preventable === false ? 'bg-slate-400' : 'bg-rose-500'}`} style={{ width: `${(100 * r.amount) / max}%` }} />
              </div>
              <span className="tabular col-span-2 text-right font-semibold">{inrShort(r.amount)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default function Leakage() {
  const centreId = useAuthStore((s) => s.activeCentreId);
  const [rows, setRows] = useState<LeakageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [months, setMonths] = useState(6);

  useEffect(() => {
    if (!centreId) return;
    setLoading(true);
    fetchLeakage(centreId).then((r) => { setRows(r); setLoading(false); });
  }, [centreId]);

  const recent = useMemo(() => {
    const from = new Date(); from.setMonth(from.getMonth() - months + 1); from.setDate(1);
    return rows.filter((r) => new Date(r.month) >= from);
  }, [rows, months]);

  const group = (key: (r: LeakageRow) => string, byReason = false, top = 10) => {
    const m = new Map<string, { amount: number; preventable?: boolean }>();
    for (const r of recent) {
      const k = key(r); const v = m.get(k) ?? { amount: 0, preventable: byReason ? r.is_preventable : undefined };
      v.amount += Number(r.amount); m.set(k, v);
    }
    return [...m.entries()].map(([label, v]) => ({ label, ...v })).sort((a, b) => b.amount - a.amount).slice(0, top);
  };

  const total = recent.reduce((s, r) => s + Number(r.amount), 0);
  const preventable = recent.filter((r) => r.is_preventable).reduce((s, r) => s + Number(r.amount), 0);
  const rejections = recent.filter((r) => r.kind === 'rejection').reduce((s, r) => s + r.items, 0);

  if (!centreId) return <NoCentre />;
  return (
    <div>
      <PageHeader title="Leakage" sub="Money claimed but not paid, by reason — approval cuts, short payments and settlement deductions" icon={TrendingDown}>
        <select value={months} onChange={(e) => setMonths(Number(e.target.value))} className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs">
          <option value={3}>Last 3 months</option><option value={6}>Last 6 months</option><option value={12}>Last 12 months</option>
        </select>
      </PageHeader>
      {loading ? <div className="p-6"><Skeleton rows={10} /></div> : rows.length === 0 ? (
        <div className="m-6 rounded-2xl border bg-white"><Empty icon={TrendingDown} title="No deductions recorded yet" sub="This fills when a claim is approved for less than billed, or a payment comes in short and its reason is given." /></div>
      ) : (
        <div className="space-y-4 px-6 py-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <StatCard label="Disallowed" value={inrShort(total)} icon={TrendingDown} tone="rose" />
            <StatCard label="Preventable" value={inrShort(preventable)} sub={total ? `${Math.round((100 * preventable) / total)}% — fixable at admission and billing` : undefined} icon={TrendingDown} tone="amber" />
            <StatCard label="Rejected claims" value={rejections} icon={TrendingDown} />
          </div>
          <Bars title="By reason" rows={group((r) => DISALLOWANCE_CATEGORIES[r.category as DisallowanceCategory]?.label ?? r.category, true)} />
          <div className="grid gap-4 lg:grid-cols-2">
            <Bars title="By payer" rows={group((r) => r.payer_name)} />
            <Bars title="By treating doctor" rows={group((r) => r.doctor_name)} />
          </div>
          <p className="flex items-center gap-4 text-xs text-slate-500">
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-rose-500" /> Preventable — process fix recovers it</span>
            <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-slate-400" /> Policy terms — not recoverable</span>
          </p>
        </div>
      )}
    </div>
  );
}
