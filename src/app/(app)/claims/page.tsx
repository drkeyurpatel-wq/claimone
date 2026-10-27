'use client';
// Claims desk — the H1 Claims command centre with ClaimOne's "blocked" KPI.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  LayoutDashboard, FileText, AlertTriangle, IndianRupee, Clock, Search, Plus, CheckCircle2,
  Eye, RefreshCw, ArrowRight, Shield, Ban,
} from 'lucide-react';
import { CLAIM_TYPE_LABELS, type ClaimStatus, type ClaimType } from '@/lib/claims/types';
import { useClaimsStore } from '@/lib/claims/store';
import { useAuthStore } from '@/lib/store/auth';
import { StatCard, StatusPill, PageHeader, Empty, Skeleton, NoCentre, inrShort, btn } from '@/components/ui';

type Tab = 'all' | 'draft' | 'preauth' | 'active' | 'queries' | 'settlements' | 'closed';

const TABS: { id: Tab; label: string; statuses?: ClaimStatus[] }[] = [
  { id: 'all', label: 'All' },
  { id: 'draft', label: 'Drafts', statuses: ['draft'] },
  { id: 'preauth', label: 'Pre-auth', statuses: ['preauth_pending', 'preauth_approved', 'preauth_query', 'preauth_rejected', 'preauth_enhanced'] },
  { id: 'active', label: 'Submitted', statuses: ['claim_submitted', 'claim_under_review', 'claim_approved', 'claim_partial'] },
  { id: 'queries', label: 'Queries', statuses: ['preauth_query', 'claim_query'] },
  { id: 'settlements', label: 'Settlement', statuses: ['settlement_pending', 'settled'] },
  { id: 'closed', label: 'Closed', statuses: ['closed', 'written_off', 'claim_rejected'] },
];

export default function ClaimsDesk() {
  const router = useRouter();
  const centreId = useAuthStore((s) => s.activeCentreId);
  const { stats, payers, claims, claimsLoading, init, loadClaims, refreshStats } = useClaimsStore();

  const [tab, setTab] = useState<Tab>('all');
  const [search, setSearch] = useState('');
  const [payer, setPayer] = useState('');
  const [type, setType] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!centreId) return;
    setReady(false);
    init(centreId).then(() => setReady(true));
  }, [centreId, init]);

  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => loadClaims({
      statuses: TABS.find((x) => x.id === tab)?.statuses,
      payer_id: payer || undefined,
      claim_type: (type || undefined) as ClaimType | undefined,
      search: search || undefined,
    }), search ? 250 : 0);
    return () => clearTimeout(t);
  }, [ready, tab, payer, type, search, loadClaims]);

  if (!centreId) return <NoCentre />;

  return (
    <div>
      <PageHeader title="Claims" sub="Pre-auth to settlement, one desk" icon={LayoutDashboard}>
        <button className={btn.ghost} onClick={() => { refreshStats(); loadClaims(useClaimsStore.getState().lastFilters); }}>
          <RefreshCw className={`h-3.5 w-3.5 ${claimsLoading ? 'animate-spin' : ''}`} /> Refresh
        </button>
        <button className={btn.primary} onClick={() => router.push('/claims/new')}><Plus className="h-4 w-4" /> New claim</button>
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 px-6 pt-4 md:grid-cols-3 xl:grid-cols-6">
        {stats ? <>
          <StatCard label="Blocked" value={stats.blocked} icon={Ban} tone="rose"
            sub={stats.blocked ? `${inrShort(stats.blocked_amount)} cannot be submitted` : 'Nothing blocked'}
            onClick={() => setTab('draft')} />
          <StatCard label="Pre-auth pending" value={stats.preauth_pending} icon={Clock} tone="amber" onClick={() => setTab('preauth')} />
          <StatCard label="Open queries" value={stats.open_queries} icon={AlertTriangle} tone="orange" onClick={() => router.push('/claims/queries')} />
          <StatCard label="With payer" value={stats.under_review} icon={Eye} tone="blue" onClick={() => setTab('active')} />
          <StatCard label="Outstanding" value={inrShort(stats.total_outstanding)} sub={`${stats.settlement_pending} approved, awaiting payment`}
            icon={IndianRupee} tone="purple" onClick={() => setTab('settlements')} />
          <StatCard label="Received" value={inrShort(stats.total_settled)} sub={`${stats.settled} claims settled`}
            icon={CheckCircle2} tone="emerald" onClick={() => router.push('/claims/settlements')} />
        </> : Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-24 animate-pulse rounded-xl border bg-white" />)}
      </div>

      <div className="flex flex-wrap items-center gap-2 px-6 pb-2 pt-4">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${tab === t.id ? 'bg-teal-600 text-white' : 'border border-slate-200 bg-white text-slate-600 hover:border-slate-300'}`}>
            {t.label}{tab === t.id && !claimsLoading ? ` · ${claims.length}` : ''}
          </button>
        ))}
        <div className="mx-1 h-5 w-px bg-slate-200" />
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input placeholder="Patient, UHID, claim #" value={search} onChange={(e) => setSearch(e.target.value)}
            className="w-52 rounded-lg border border-slate-200 bg-white py-1.5 pl-8 pr-3 text-xs focus:border-teal-500 focus:outline-none" />
        </div>
        <select value={payer} onChange={(e) => setPayer(e.target.value)} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs">
          <option value="">All payers</option>
          {payers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={type} onChange={(e) => setType(e.target.value)} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs">
          <option value="">All types</option>
          {Object.entries(CLAIM_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>

      <div className="px-6 pb-8">
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          {!ready || claimsLoading ? <Skeleton rows={8} /> : claims.length === 0 ? (
            <Empty icon={Shield} title="No claims here" sub="Create a claim or change the filters">
              <Link href="/claims/new" className={btn.primary}><Plus className="h-4 w-4" /> New claim</Link>
            </Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                    <th className="px-4 py-3">Claim #</th><th className="px-4 py-3">Patient</th><th className="px-4 py-3">Payer</th>
                    <th className="px-4 py-3">Type</th><th className="px-4 py-3">Status</th><th className="px-4 py-3 text-right">Amount</th>
                    <th className="px-4 py-3">Queries</th><th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {claims.map((c) => {
                    const amount = c.settled_amount ?? c.approved_amount ?? c.claimed_amount ?? c.estimated_amount;
                    return (
                      <tr key={c.id} onClick={() => router.push(`/claims/${c.id}`)}
                        className={`cursor-pointer border-b border-slate-100 last:border-0 hover:bg-teal-50/40 ${c.priority === 'critical' ? 'bg-rose-50/30' : ''}`}>
                        <td className="px-4 py-3 font-mono text-xs text-slate-500">{c.claim_number}</td>
                        <td className="px-4 py-3"><p className="font-medium text-slate-900">{c.patient_name}</p><p className="text-xs text-slate-500">{c.patient_uhid ?? ''}</p></td>
                        <td className="px-4 py-3 text-xs text-slate-600">{c.clm_payers?.name ?? '—'}</td>
                        <td className="px-4 py-3 text-xs text-slate-600">{CLAIM_TYPE_LABELS[c.claim_type]}</td>
                        <td className="px-4 py-3"><StatusPill status={c.status} /></td>
                        <td className="tabular px-4 py-3 text-right font-semibold">{inrShort(amount)}</td>
                        <td className="px-4 py-3">
                          {c.is_query_pending
                            ? <span className="inline-flex items-center gap-1 rounded-full bg-orange-50 px-2 py-0.5 text-[10px] font-semibold text-orange-600"><AlertTriangle className="h-3 w-3" /> open</span>
                            : c.query_count > 0 ? <span className="text-[10px] text-slate-400">{c.query_count} answered</span> : null}
                        </td>
                        <td className="px-4 py-3 text-right"><span className="inline-flex items-center gap-1 text-xs font-medium text-teal-700">Open <ArrowRight className="h-3 w-3" /></span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        {claims.length >= 200 && <p className="mt-2 text-xs text-slate-500"><FileText className="mr-1 inline h-3 w-3" />Showing the latest 200 — search to narrow down.</p>}
      </div>
    </div>
  );
}
