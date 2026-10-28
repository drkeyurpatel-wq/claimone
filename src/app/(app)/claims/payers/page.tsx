'use client';
// Payer master + scorecard (across every centre this login can see).
import { useEffect, useMemo, useState } from 'react';
import { Building2, Search, Pencil } from 'lucide-react';
import { sb } from '@/lib/supabase/browser';
import { useAuthStore } from '@/lib/store/auth';
import { ROUTE_WORDS } from '@/lib/rcm/payer';
import type { PayerChannel } from '@/lib/claims/types';
import { fetchPayers, fetchPayerScorecard } from '@/lib/claims/api';
import type { Payer, PayerScorecard } from '@/lib/claims/types';
import { PageHeader, Skeleton, inrShort } from '@/components/ui';

const TYPE: Record<Payer['type'], { label: string; cls: string }> = {
  tpa: { label: 'TPA', cls: 'bg-blue-50 text-blue-700' }, insurer: { label: 'Insurer', cls: 'bg-purple-50 text-purple-700' },
  government: { label: 'Government', cls: 'bg-green-50 text-green-700' }, psu: { label: 'PSU', cls: 'bg-amber-50 text-amber-700' },
  corporate: { label: 'Corporate', cls: 'bg-slate-100 text-slate-700' },
};

function RouteCell({ p, isAdmin, onSaved }: { p: Payer; isAdmin: boolean; onSaved: () => void }) {
  const [edit, setEdit] = useState(false);
  const [channel, setChannel] = useState<PayerChannel>(p.channel ?? 'portal');
  const [code, setCode] = useState(p.nhcx_code ?? '');
  const [live, setLive] = useState(p.is_nhcx_live);
  const [err, setErr] = useState('');
  const save = async () => {
    const { error } = await sb().rpc('clm_set_payer_route', { p_payer: p.id, p_channel: channel, p_nhcx_code: code, p_live: live });
    if (error) { setErr(error.message); return; }
    setEdit(false); setErr(''); onSaved();
  };
  if (!edit) return (
    <span className="inline-flex items-center gap-1.5 text-xs">
      {p.is_nhcx_live ? <span className="rounded bg-indigo-50 px-1.5 py-0.5 font-semibold text-indigo-700">NHCX</span> : <span className="text-slate-600">{ROUTE_WORDS[p.channel ?? 'portal'].label}</span>}
      {isAdmin && <button aria-label={`Change how ${p.name} is reached`} onClick={() => setEdit(true)} className="text-slate-400 hover:text-slate-700"><Pencil className="h-3.5 w-3.5" /></button>}
    </span>
  );
  return (
    <div className="space-y-1 text-xs">
      <select value={channel} onChange={(e) => setChannel(e.target.value as PayerChannel)} className="w-full rounded border border-slate-200 px-1 py-1">
        {(['portal', 'email', 'tms', 'direct'] as const).map((c) => <option key={c} value={c}>{ROUTE_WORDS[c].label}</option>)}
      </select>
      <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="NHCX code e.g. 1000003538@hcx" className="w-full rounded border border-slate-200 px-1 py-1" />
      <label className="flex items-center gap-1"><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> Live on NHCX</label>
      {err && <p className="text-rose-600">{err}</p>}
      <div className="flex gap-1"><button onClick={save} className="rounded bg-teal-600 px-2 py-1 font-semibold text-white">Save</button><button onClick={() => setEdit(false)} className="rounded bg-slate-100 px-2 py-1">Cancel</button></div>
    </div>
  );
}

export default function Payers() {
  const isAdmin = useAuthStore((s) => s.staff?.role) === 'admin';
  const [reloadKey, setReloadKey] = useState(0);
  const [payers, setPayers] = useState<Payer[]>([]);
  const [score, setScore] = useState<Record<string, PayerScorecard>>({});
  const [q, setQ] = useState('');
  const [onlyActive, setOnlyActive] = useState(true);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([fetchPayers(), fetchPayerScorecard()]).then(([p, s]) => {
      setPayers(p); setScore(Object.fromEntries(s.map((x) => [x.payer_id, x]))); setLoading(false);
    });
  }, [reloadKey]);

  const rows = useMemo(() => payers
    .filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()))
    .filter((p) => !onlyActive || (score[p.id]?.total_claims ?? 0) > 0)
    .sort((a, b) => (score[b.id]?.total_claims ?? 0) - (score[a.id]?.total_claims ?? 0) || a.name.localeCompare(b.name)), [payers, score, q, onlyActive]);

  return (
    <div>
      <PageHeader title="Payers" sub="How each insurer, TPA and scheme treats our claims — all your centres" icon={Building2} />
      <div className="flex flex-wrap items-center gap-3 px-6 pt-4">
        <div className="relative"><Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search payers" className="w-56 rounded-lg border border-slate-200 py-1.5 pl-8 pr-3 text-xs" /></div>
        <label className="flex items-center gap-1.5 text-xs text-slate-600"><input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} /> Only payers with claims</label>
      </div>
      <div className="px-6 py-4">
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          {loading ? <Skeleton /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b bg-slate-50/80 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-3">Payer</th><th className="px-4 py-3">Type</th><th className="px-4 py-3">How claims go</th><th className="px-4 py-3 text-right">Claims</th>
                  <th className="px-4 py-3 text-right">Settled</th><th className="px-4 py-3 text-right">Rejection</th><th className="px-4 py-3 text-right">Deduction</th>
                  <th className="px-4 py-3 text-right">Avg days to pay</th><th className="px-4 py-3 text-right">Open queries</th><th className="px-4 py-3 text-right">Query reply window</th>
                </tr></thead>
                <tbody>
                  {rows.length === 0 ? <tr><td colSpan={10} className="py-10 text-center text-sm text-slate-400">{onlyActive ? 'No claims filed yet — untick the box to see every payer.' : 'No payers match.'}</td></tr> : rows.map((p) => {
                    const s = score[p.id];
                    return (
                      <tr key={p.id} className="border-b border-slate-100 last:border-0">
                        <td className="px-4 py-3 font-medium">{p.name}{p.tenant_id && <span className="ml-1.5 text-[10px] text-slate-400">(ours)</span>}</td>
                        <td className="px-4 py-3"><span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${TYPE[p.type].cls}`}>{TYPE[p.type].label}</span></td>
                        <td className="px-4 py-3"><RouteCell p={p} isAdmin={isAdmin} onSaved={() => setReloadKey((k) => k + 1)} /></td>
                        <td className="tabular px-4 py-3 text-right">{s?.total_claims ?? 0}</td>
                        <td className="tabular px-4 py-3 text-right">{s?.total_settled ? inrShort(s.total_settled) : '—'}</td>
                        <td className={`tabular px-4 py-3 text-right ${(s?.rejection_rate_pct ?? 0) > 10 ? 'font-semibold text-rose-600' : ''}`}>{s?.rejection_rate_pct != null ? `${s.rejection_rate_pct}%` : '—'}</td>
                        <td className={`tabular px-4 py-3 text-right ${(s?.deduction_pct ?? 0) > 10 ? 'font-semibold text-rose-600' : ''}`}>{s?.deduction_pct != null ? `${s.deduction_pct}%` : '—'}</td>
                        <td className="tabular px-4 py-3 text-right">{s?.avg_settlement_days ?? '—'}</td>
                        <td className="tabular px-4 py-3 text-right">{s?.pending_queries || '—'}</td>
                        <td className="tabular px-4 py-3 text-right text-slate-500">{p.query_tat_hours}h</td>
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
