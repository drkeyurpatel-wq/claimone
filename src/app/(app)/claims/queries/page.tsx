'use client';
// Query desk: every open payer query across the centre, nearest deadline first.
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { MessageSquare, AlertTriangle, Clock, XCircle, Search, Send, Loader2 } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import { useClaimsStore } from '@/lib/claims/store';
import { respondToQuery } from '@/lib/claims/api';
import { PRIORITY_CONFIG } from '@/lib/claims/types';
import { PageHeader, StatCard, Skeleton, Empty, NoCentre, StatusPill, inrShort, dateTime, useToast } from '@/components/ui';

export default function QueryDesk() {
  const centreId = useAuthStore((s) => s.activeCentreId);
  const role = useAuthStore((s) => s.staff?.role);
  const canWrite = role === 'admin' || role === 'manager' || role === 'desk';
  const { openQueries, rejected, queriesLoading, loadQueryCentre, init } = useClaimsStore();
  const { flash, toastNode } = useToast();
  const [tab, setTab] = useState<'open' | 'rejected'>('open');
  const [q, setQ] = useState('');
  const [role2, setRole2] = useState('');
  const [replying, setReplying] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (centreId) init(centreId).then(loadQueryCentre); }, [centreId, init, loadQueryCentre]);

  const shown = useMemo(() => openQueries.filter((x) =>
    (!q || `${x.patient_name} ${x.claim_number} ${x.query_text} ${x.payer_name}`.toLowerCase().includes(q.toLowerCase()))
    && (!role2 || (x.routed_to_role ?? '') === role2)), [openQueries, q, role2]);

  if (!centreId) return <NoCentre />;
  const breached = openQueries.filter((x) => x.is_sla_breached).length;
  const dueToday = openQueries.filter((x) => !x.is_sla_breached && x.hours_left <= 24).length;

  const send = async (id: string) => {
    setSaving(true);
    try { await respondToQuery(id, text.trim()); setReplying(null); setText(''); flash('Reply saved'); await loadQueryCentre(); }
    catch (e) { flash((e as Error).message, 'err'); }
    setSaving(false);
  };

  return (
    <div>
      {toastNode}
      <PageHeader title="Queries" sub="Payer queries waiting for a reply — nearest deadline first" icon={MessageSquare} />
      <div className="grid grid-cols-2 gap-3 px-6 pt-4 md:grid-cols-4">
        <StatCard label="Open" value={openQueries.length} icon={MessageSquare} tone="orange" onClick={() => setTab('open')} />
        <StatCard label="Past deadline" value={breached} icon={AlertTriangle} tone="rose" />
        <StatCard label="Due in 24h" value={dueToday} icon={Clock} tone="amber" />
        <StatCard label="Rejected claims" value={rejected.length} icon={XCircle} tone="slate" onClick={() => setTab('rejected')} />
      </div>
      <div className="flex flex-wrap items-center gap-2 px-6 pt-4">
        {(['open', 'rejected'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`rounded-lg px-3 py-1.5 text-xs font-medium ${tab === t ? 'bg-teal-600 text-white' : 'border bg-white text-slate-600'}`}>
            {t === 'open' ? 'Open queries' : 'Rejected claims'}
          </button>
        ))}
        {tab === 'open' && <>
          <div className="relative"><Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" className="w-48 rounded-lg border border-slate-200 py-1.5 pl-8 pr-3 text-xs" /></div>
          <select value={role2} onChange={(e) => setRole2(e.target.value)} className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs">
            <option value="">Everyone</option><option value="doctor">Treating doctor</option><option value="billing">Billing</option><option value="mrd">Medical records</option>
          </select>
        </>}
      </div>

      <div className="space-y-2 px-6 py-4">
        {queriesLoading && !openQueries.length ? <Skeleton /> : tab === 'open' ? (
          shown.length === 0 ? <div className="rounded-2xl border bg-white"><Empty icon={MessageSquare} title="No open queries" sub="Nice — every payer query has a reply." /></div> :
          shown.map((x) => {
            const p = PRIORITY_CONFIG[x.priority];
            return (
              <div key={x.id} className={`rounded-xl border bg-white p-4 ${x.is_sla_breached ? 'border-rose-300' : 'border-slate-200'}`}>
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      <Link href={`/case/${x.claim_id}`} className="font-semibold text-slate-900 hover:underline">{x.patient_name}</Link>
                      <span className="font-mono text-slate-400">{x.claim_number}</span>
                      <span className="text-slate-500">· {x.payer_name}</span>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${p.bg} ${p.color}`}>{p.label}</span>
                      {x.routed_to_role && <span className="text-[10px] text-slate-400">→ {x.routed_to_role}</span>}
                    </div>
                    <p className="mt-2 text-sm text-slate-800">{x.query_text}</p>
                    <p className="mt-1 text-[11px] text-slate-400">Q{x.query_number} · raised {dateTime(x.raised_at)}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className={`tabular text-sm font-bold ${x.is_sla_breached ? 'text-rose-600' : x.hours_left < 12 ? 'text-orange-600' : 'text-slate-600'}`}>
                      {x.is_sla_breached ? `${Math.abs(Math.round(x.hours_left))}h over` : `${Math.round(x.hours_left)}h left`}</p>
                  </div>
                </div>
                {canWrite && (replying === x.id ? (
                  <div className="mt-3 space-y-2 border-t pt-3">
                    <textarea autoFocus rows={3} value={text} onChange={(e) => setText(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" placeholder="Reply sent to the payer" />
                    <div className="flex justify-end gap-2">
                      <button onClick={() => setReplying(null)} className="rounded-lg border px-3 py-1.5 text-xs">Cancel</button>
                      <button disabled={saving || !text.trim()} onClick={() => send(x.id)} className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
                        {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />} Save reply</button>
                    </div>
                  </div>
                ) : <button onClick={() => { setReplying(x.id); setText(''); }} className="mt-3 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700">Reply</button>)}
              </div>
            );
          })
        ) : (
          rejected.length === 0 ? <div className="rounded-2xl border bg-white"><Empty icon={XCircle} title="No rejected claims" /></div> : (
            <div className="overflow-hidden rounded-2xl border bg-white">
              <table className="w-full text-sm"><tbody>
                {rejected.map((c) => (
                  <tr key={c.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-3"><Link href={`/case/${c.id}`} className="font-medium hover:underline">{c.patient_name}</Link><p className="font-mono text-[11px] text-slate-400">{c.claim_number}</p></td>
                    <td className="px-4 py-3 text-xs text-slate-600">{c.clm_payers?.name}</td>
                    <td className="px-4 py-3"><StatusPill status={c.status} /></td>
                    <td className="tabular px-4 py-3 text-right font-semibold">{inrShort(c.claimed_amount ?? c.estimated_amount)}</td>
                    <td className="px-4 py-3 text-right text-xs text-slate-500">appeal or write off from the claim</td>
                  </tr>
                ))}
              </tbody></table>
            </div>
          )
        )}
      </div>
    </div>
  );
}
