'use client';
// Pre-auth queue: everything between "patient admitted" and "final claim filed".
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shield, Clock, CheckCircle2, AlertTriangle, XCircle, FileText } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import { fetchClaims } from '@/lib/claims/api';
import type { Claim, ClaimStatus } from '@/lib/claims/types';
import { PageHeader, StatCard, StatusPill, Skeleton, Empty, NoCentre, inrShort, dateTime } from '@/components/ui';

const STATUSES: ClaimStatus[] = ['draft', 'preauth_pending', 'preauth_query', 'preauth_approved', 'preauth_enhanced', 'preauth_rejected'];
type Filter = 'all' | ClaimStatus;

export default function PreauthQueue() {
  const router = useRouter();
  const centreId = useAuthStore((s) => s.activeCentreId);
  const [rows, setRows] = useState<Claim[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');

  useEffect(() => {
    if (!centreId) return;
    setLoading(true);
    fetchClaims(centreId, { statuses: STATUSES, limit: 500 }).then((r) => { setRows(r.filter((c) => c.claim_type !== 'reimbursement')); setLoading(false); });
  }, [centreId]);

  const count = (s: ClaimStatus) => rows.filter((r) => r.status === s).length;
  const shown = useMemo(() => {
    const list = filter === 'all' ? rows : rows.filter((r) => r.status === filter);
    // oldest waiting first
    return [...list].sort((a, b) => (a.preauth_submitted_at ?? a.created_at).localeCompare(b.preauth_submitted_at ?? b.created_at));
  }, [rows, filter]);

  if (!centreId) return <NoCentre />;
  const hoursWaiting = (c: Claim) => c.preauth_submitted_at ? Math.round((Date.now() - new Date(c.preauth_submitted_at).getTime()) / 3600000) : null;

  return (
    <div>
      <PageHeader title="Pre-auth queue" sub="Cashless requests from draft to approval — oldest first" icon={Shield} />
      <div className="grid grid-cols-2 gap-3 px-6 pt-4 md:grid-cols-5">
        <StatCard label="Drafts" value={count('draft')} icon={FileText} onClick={() => setFilter('draft')} />
        <StatCard label="Waiting on payer" value={count('preauth_pending')} icon={Clock} tone="amber" onClick={() => setFilter('preauth_pending')} />
        <StatCard label="Query" value={count('preauth_query')} icon={AlertTriangle} tone="orange" onClick={() => setFilter('preauth_query')} />
        <StatCard label="Approved" value={count('preauth_approved') + count('preauth_enhanced')} icon={CheckCircle2} tone="emerald" onClick={() => setFilter('preauth_approved')} />
        <StatCard label="Rejected" value={count('preauth_rejected')} icon={XCircle} tone="rose" onClick={() => setFilter('preauth_rejected')} />
      </div>
      <div className="px-6 py-4">
        <div className="mb-2 flex gap-2">
          <button onClick={() => setFilter('all')} className={`rounded-lg px-3 py-1.5 text-xs font-medium ${filter === 'all' ? 'bg-teal-600 text-white' : 'border bg-white text-slate-600'}`}>All · {rows.length}</button>
        </div>
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          {loading ? <Skeleton /> : shown.length === 0 ? <Empty icon={Shield} title="Nothing in this queue" /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b bg-slate-50/80 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-3">Patient</th><th className="px-4 py-3">Payer</th><th className="px-4 py-3">Diagnosis</th>
                  <th className="px-4 py-3">Status</th><th className="px-4 py-3 text-right">Estimate</th><th className="px-4 py-3 text-right">Approved</th><th className="px-4 py-3">Filed</th>
                </tr></thead>
                <tbody>
                  {shown.map((c) => {
                    const h = c.status === 'preauth_pending' ? hoursWaiting(c) : null;
                    return (
                      <tr key={c.id} onClick={() => router.push(`/case/${c.id}`)} className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-teal-50/40">
                        <td className="px-4 py-3"><p className="font-medium">{c.patient_name}</p><p className="font-mono text-[11px] text-slate-500">{c.claim_number}</p></td>
                        <td className="px-4 py-3 text-xs text-slate-600">{c.clm_payers?.name}</td>
                        <td className="max-w-xs truncate px-4 py-3 text-xs text-slate-600">{c.primary_diagnosis ?? '—'}</td>
                        <td className="px-4 py-3"><StatusPill status={c.status} /></td>
                        <td className="tabular px-4 py-3 text-right">{inrShort(c.estimated_amount)}</td>
                        <td className="tabular px-4 py-3 text-right font-semibold text-emerald-700">{c.approved_amount != null ? inrShort(c.approved_amount) : '—'}</td>
                        <td className="px-4 py-3 text-xs">
                          {c.preauth_submitted_at ? dateTime(c.preauth_submitted_at) : <span className="text-slate-400">not filed</span>}
                          {h != null && h > 4 && <span className={`ml-1.5 rounded px-1.5 py-0.5 text-[10px] font-bold ${h > 24 ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-700'}`}>{h}h</span>}
                        </td>
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
