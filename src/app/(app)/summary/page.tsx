'use client';
// Weekly summary for the manager: this week's movement, money owed by payer
// and age, what is stuck, deductions by reason and payer, and disputes won.
// One page, prints straight to A4.
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Loader2, Printer } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import { sb } from '@/lib/supabase/browser';
import { fetchJourneys, type Journey } from '@/lib/rcm/api';
import { fetchLeakage } from '@/lib/claims/api';
import { ledgerRow } from '@/lib/rcm/ledger';
import { BUCKETS, deductionGrid, disputesByMonth, outstandingByPayer, stuck, thisWeek, type DisputeCase } from '@/lib/rcm/summary';
import type { LeakageRow } from '@/lib/claims/types';
import { NoCentre } from '@/components/ui';

const rs = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const lakh = (n: number) => (Math.abs(n) >= 1e7 ? `₹${(n / 1e7).toFixed(2)} Cr` : Math.abs(n) >= 1e5 ? `₹${(n / 1e5).toFixed(1)} L` : rs(n));
const monthName = (k: string) => new Date(`${k}-15T12:00:00+05:30`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
const BUCKET_COLOR = ['#0d9488', '#d97706', '#ea580c', '#dc2626'];

function Exhibit({ n, title, children, note }: { n: number; title: string; children: React.ReactNode; note?: string }) {
  return (
    <section className="mt-8 break-inside-avoid">
      <h2 className="text-lg font-bold text-slate-900">{n}. {title}</h2>
      <div className="mt-2">{children}</div>
      {note && <p className="mt-1.5 text-sm text-slate-500">{note}</p>}
    </section>
  );
}
const th = 'border-b border-slate-300 px-2 py-2 text-left text-xs font-semibold uppercase tracking-wide text-slate-500';
const td = 'border-b border-slate-100 px-2 py-2 text-[15px] tabular-nums';

export default function SummaryPage() {
  const { activeCentreId: centreId, centres, staff } = useAuthStore();
  const isManager = staff?.role === 'admin' || staff?.role === 'manager';
  const [all, setAll] = useState<Journey[] | null>(null);
  const [leak, setLeak] = useState<LeakageRow[]>([]);
  const [disputes, setDisputes] = useState<DisputeCase[]>([]);
  const [approvals, setApprovals] = useState<{ amount: number }[] | undefined>(undefined);
  const [settled, setSettled] = useState<{ net: number }[] | undefined>(undefined);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!centreId || !isManager) return;
    setAll(null);
    Promise.all([
      fetchJourneys(centreId),
      fetchLeakage(centreId),
      sb().from('clm_claims').select('cut_decision, cut_decided_at, status, claimed_amount, approved_amount, deduction_amount')
        .eq('centre_id', centreId).not('cut_decision', 'is', null).limit(20000),
      // claim approvals in the last 7 days, from the status history (one per file)
      // (cases brought over from the old sheet were not approved this week)
      sb().from('clm_state_transitions').select('claim_id, clm_claims!inner(centre_id, approved_amount)')
        .in('to_status', ['claim_approved', 'claim_partial']).neq('trigger_source', 'sheet').eq('clm_claims.centre_id', centreId)
        .gte('created_at', new Date(Date.now() - 7 * 86_400_000).toISOString()).limit(5000),
      // settled this week: by the date the money was paid
      sb().from('clm_settlements').select('net_amount, clm_claims!inner(centre_id)').eq('clm_claims.centre_id', centreId)
        .gte('payment_date', new Date(Date.now() - 7 * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })).limit(5000),
    ]).then(([j, l, d, a, st]) => {
      setAll(j); setLeak(l); setDisputes((d.data ?? []) as DisputeCase[]);
      if (!a.error) {
        const one = new Map<string, number>();
        for (const x of (a.data ?? []) as unknown as { claim_id: string; clm_claims: { approved_amount: number | null } }[]) one.set(x.claim_id, Number(x.clm_claims?.approved_amount ?? 0));
        setApprovals([...one.values()].map((amount) => ({ amount })));
      }
      if (!st.error) setSettled(((st.data ?? []) as { net_amount: number }[]).map((x) => ({ net: Number(x.net_amount) })));
    })
      .catch(() => setError('Could not load the summary. Please refresh.'));
  }, [centreId, isManager]);

  const now = useMemo(() => new Date(), []);
  const rows = useMemo(() => (all ?? []).map((j) => ledgerRow(j, false, now)), [all, now]);
  const week = useMemo(() => thisWeek(rows, now, approvals, settled), [rows, now, approvals, settled]);
  const owed = useMemo(() => outstandingByPayer(rows), [rows]);
  const late = useMemo(() => stuck(rows), [rows]);
  const since = useMemo(() => { const d = new Date(now.getFullYear(), now.getMonth() - 5, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; }, [now]);
  const grid = useMemo(() => deductionGrid(leak, since), [leak, since]);
  const months = useMemo(() => disputesByMonth(disputes, 6, now), [disputes, now]);

  if (!centreId) return <NoCentre />;
  if (!isManager) return <div className="py-20 text-center text-base text-slate-500">The weekly summary is for admins and managers. <Link href="/master" className="inline-flex min-h-11 items-center text-teal-700 underline">Back to Master</Link></div>;
  if (error) return <p role="alert" className="m-6 rounded-lg bg-rose-50 p-3 text-base text-rose-800">{error}</p>;
  if (!all) return <div className="flex justify-center py-16"><Loader2 className="h-7 w-7 animate-spin text-teal-600" /></div>;

  const centre = centres.find((c) => c.id === centreId)?.name ?? '';
  const totalOwed = owed.reduce((s, p) => s + p.total, 0);
  const over60 = owed.reduce((s, p) => s + p.buckets[BUCKETS[2]] + p.buckets[BUCKETS[3]], 0);
  const maxOwed = Math.max(1, ...owed.map((p) => p.total));
  const recovered = months.reduce((s, m) => s + m.recovered, 0);
  const lateOurs = late.filter((s) => s.ours).reduce((s, x) => s + x.cases, 0);
  const latePayer = late.filter((s) => !s.ours).reduce((s, x) => s + x.cases, 0);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-6 print:max-w-none print:p-0">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-teal-700">Weekly summary{centre ? ` · ${centre}` : ''}</p>
          <h1 className="text-2xl font-bold text-slate-900">Claims and collections — week to {now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}</h1>
        </div>
        <button type="button" onClick={() => window.print()} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 print:hidden">
          <Printer className="h-4 w-4" /> Print / PDF</button>
      </div>

      <div className="mt-5 rounded-xl border-l-4 border-teal-600 bg-slate-50 p-4 text-base text-slate-800 print:bg-white">
        <p className="font-semibold">Key messages</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          <li>Payers owe <b>{lakh(totalOwed)}</b> on open files; <b>{lakh(over60)}</b> of it is over 60 days from discharge.</li>
          <li>This week: <b>{week.claimsSubmitted}</b> claims submitted ({lakh(week.claimed)}), <b>{week.approvals}</b> approved ({lakh(week.approved)}), <b>{week.settled}</b> settled ({lakh(week.settledNet)} net).</li>
          <li><b>{lateOurs}</b> files are overdue on our side and <b>{latePayer}</b> are overdue with the payer.</li>
          <li>Deductions in the last 6 months: <b>{lakh(grid.total)}</b>{grid.categories[0] ? <>, mostly <b>{grid.categories[0]}</b> ({lakh(grid.totals[grid.categories[0]])})</> : null}. Recovered by disputing: <b>{lakh(recovered)}</b>.</li>
        </ul>
      </div>

      <Exhibit n={1} title="This week (last 7 days)">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[['New admissions', String(week.admissions)], ['Claims submitted', `${week.claimsSubmitted} · ${lakh(week.claimed)}`],
            ['Claims approved', `${week.approvals} · ${lakh(week.approved)}`], ['Settled', `${week.settled} · ${lakh(week.settledNet)}`]].map(([k, v]) => (
            <div key={k} className="rounded-xl border border-slate-200 p-3"><p className="text-sm text-slate-500">{k}</p><p className="mt-1 text-xl font-bold text-slate-900">{v}</p></div>
          ))}
        </div>
      </Exhibit>

      <Exhibit n={2} title="Outstanding by payer and age" note="Age is days since discharge. Amount: unpaid balance, else the approval, else the claim.">
        {owed.length === 0 ? <p className="text-base text-slate-500">Nothing outstanding.</p> : <>
          <div className="space-y-2">
            {owed.slice(0, 10).map((p) => (
              <div key={p.payer}>
                <div className="flex justify-between text-[15px]"><span className="font-medium text-slate-800">{p.payer}</span><span className="tabular-nums font-semibold">{lakh(p.total)}</span></div>
                <div className="mt-1 flex h-5 overflow-hidden rounded bg-slate-100" style={{ width: `${Math.max(4, (p.total / maxOwed) * 100)}%` }}>
                  {BUCKETS.map((b, i) => p.buckets[b] > 0 && <div key={b} title={`${b}: ${rs(p.buckets[b])}`} style={{ width: `${(p.buckets[b] / p.total) * 100}%`, background: BUCKET_COLOR[i] }} />)}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-3 text-sm text-slate-600">{BUCKETS.map((b, i) => <span key={b} className="inline-flex items-center gap-1"><span className="h-3 w-3 rounded-sm" style={{ background: BUCKET_COLOR[i] }} />{b}</span>)}</div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse">
              <thead><tr><th className={th}>Payer</th><th className={`${th} text-right`}>Files</th>{BUCKETS.map((b) => <th key={b} className={`${th} text-right`}>{b}</th>)}<th className={`${th} text-right`}>Total</th></tr></thead>
              <tbody>
                {owed.map((p) => (
                  <tr key={p.payer}><td className={td}>{p.payer}</td><td className={`${td} text-right`}>{p.cases}</td>
                    {BUCKETS.map((b, i) => <td key={b} className={`${td} text-right ${i >= 2 && p.buckets[b] > 0 ? 'font-semibold text-rose-700' : ''}`}>{p.buckets[b] ? rs(p.buckets[b]) : '—'}</td>)}
                    <td className={`${td} text-right font-semibold`}>{rs(p.total)}</td></tr>
                ))}
                <tr className="bg-slate-50 font-bold"><td className={td}>Total</td><td className={`${td} text-right`}>{owed.reduce((s, p) => s + p.cases, 0)}</td>
                  {BUCKETS.map((b) => <td key={b} className={`${td} text-right`}>{rs(owed.reduce((s, p) => s + p.buckets[b], 0))}</td>)}
                  <td className={`${td} text-right`}>{rs(totalOwed)}</td></tr>
              </tbody>
            </table>
          </div>
        </>}
      </Exhibit>

      <Exhibit n={3} title="Files that are stuck" note="Overdue against the follow-up targets. Open Master → Follow-up overdue for the list.">
        {late.length === 0 ? <p className="text-base text-slate-500">Nothing overdue.</p> : (
          <table className="w-full border-collapse">
            <thead><tr><th className={th}>What is overdue</th><th className={th}>With</th><th className={`${th} text-right`}>Files</th><th className={th}>Oldest</th></tr></thead>
            <tbody>{late.map((s) => (
              <tr key={s.label}><td className={td}>{s.label}</td><td className={td}>{s.ours ? <span className="font-semibold text-rose-700">Our desk</span> : 'Payer'}</td>
                <td className={`${td} text-right font-semibold`}>{s.cases}</td><td className={td}>{s.oldest}</td></tr>
            ))}</tbody>
          </table>
        )}
      </Exhibit>

      <Exhibit n={4} title="Deductions by reason and payer — last 6 months" note="Reason as given by the payer. Fix the preventable ones (documents, room rent, tariff) at the desk; take the rest to the tariff talks.">
        {grid.payers.length === 0 ? <p className="text-base text-slate-500">No deductions recorded.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse">
              <thead><tr><th className={th}>Payer</th>{grid.categories.map((k) => <th key={k} className={`${th} text-right`}>{k}</th>)}<th className={`${th} text-right`}>Total</th></tr></thead>
              <tbody>
                {grid.payers.map((p) => (
                  <tr key={p.payer}><td className={td}>{p.payer}</td>{grid.categories.map((k) => <td key={k} className={`${td} text-right`}>{p.by[k] ? rs(p.by[k]) : '—'}</td>)}
                    <td className={`${td} text-right font-semibold`}>{rs(p.total)}</td></tr>
                ))}
                <tr className="bg-slate-50 font-bold"><td className={td}>Total</td>{grid.categories.map((k) => <td key={k} className={`${td} text-right`}>{rs(grid.totals[k])}</td>)}<td className={`${td} text-right`}>{rs(grid.total)}</td></tr>
                <tr><td className={`${td} text-slate-500`}>Share</td>{grid.categories.map((k) => <td key={k} className={`${td} text-right text-slate-500`}>{grid.total ? `${Math.round((grid.totals[k] / grid.total) * 100)}%` : ''}</td>)}<td className={td} /></tr>
              </tbody>
            </table>
          </div>
        )}
      </Exhibit>

      <Exhibit n={5} title="Deductions accepted, disputed and recovered — by month decided" note="Recovered: paid after the dispute, over the original approval.">
        <table className="w-full border-collapse">
          <thead><tr><th className={th}>Month</th><th className={`${th} text-right`}>Accepted</th><th className={`${th} text-right`}>Disputed</th><th className={`${th} text-right`}>Won</th><th className={`${th} text-right`}>Recovered</th><th className={`${th} text-right`}>Still open</th></tr></thead>
          <tbody>
            {months.map((m) => (
              <tr key={m.month}><td className={td}>{monthName(m.month)}</td>
                <td className={`${td} text-right`}>{m.accepted ? `${m.accepted} · ${rs(m.acceptedAmt)}` : '—'}</td>
                <td className={`${td} text-right`}>{m.disputed ? `${m.disputed} · ${rs(m.disputedAmt)}` : '—'}</td>
                <td className={`${td} text-right`}>{m.won || '—'}</td>
                <td className={`${td} text-right font-semibold text-emerald-700`}>{m.recovered ? rs(m.recovered) : '—'}</td>
                <td className={`${td} text-right`}>{m.open || '—'}</td></tr>
            ))}
            <tr className="bg-slate-50 font-bold"><td className={td}>6 months</td>
              <td className={`${td} text-right`}>{rs(months.reduce((s, m) => s + m.acceptedAmt, 0))}</td>
              <td className={`${td} text-right`}>{rs(months.reduce((s, m) => s + m.disputedAmt, 0))}</td>
              <td className={`${td} text-right`}>{months.reduce((s, m) => s + m.won, 0)}</td>
              <td className={`${td} text-right text-emerald-700`}>{rs(recovered)}</td>
              <td className={`${td} text-right`}>{months.reduce((s, m) => s + m.open, 0)}</td></tr>
          </tbody>
        </table>
      </Exhibit>
    </div>
  );
}
