'use client';
// Every insurance / scheme / company patient as a file moving through the
// hospital. Tabs are the stages of the journey; the number on each tab is
// how many files sit there. Late files come first. Tap a patient to work the file.
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, Search, ChevronRight, UserPlus } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import { fetchJourneys, type Journey } from '@/lib/rcm/api';
import { STAGES, WORKSPACE_STAGE, stageStates, type StageKey } from '@/lib/rcm/journey';
import { byUrgency, dueText } from '@/lib/rcm/worklist';
import { StageDots } from '@/components/case/StageTracker';
import { NoCentre, inrShort } from '@/components/ui';

function Row({ j }: { j: Journey }) {
  const { c, step, money, stage } = j;
  const due = dueText(step);
  const amount = stage === 'payment' && money ? money.balance : c.approved_amount ?? c.claimed_amount ?? c.estimated_amount;
  const line = stage === 'payment' && money
    ? (money.allocated > 0 ? `Received ${inrShort(money.allocated)} · ${inrShort(money.balance)} still due` : 'Approved — waiting for the money')
    : stage === 'closed' ? 'Paid and reconciled' : step.label;
  return (
    <li>
      <Link href={`/case/${c.id}`} className={`flex items-center gap-3 rounded-xl border bg-white p-4 transition hover:border-teal-400 hover:shadow-sm ${step.overdue && stage !== 'closed' ? 'border-rose-300' : 'border-slate-200'}`}>
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-slate-900">{c.patient_name}</p>
          <p className="truncate text-sm text-slate-500">{c.admission_ref ?? '—'} · {c.clm_payers?.name ?? c.sponsor_name}{amount ? ` · ${inrShort(Number(amount))}` : ''}</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <StageDots states={stageStates(c, stage)} late={step.overdue} />
            <span className={`text-sm ${step.ours ? 'font-medium text-slate-800' : 'text-slate-600'}`}>{line}</span>
          </div>
        </div>
        {due && stage !== 'closed' && (
          <span className={`shrink-0 rounded-full px-3 py-1 text-sm font-semibold ${step.overdue ? 'bg-rose-100 text-rose-800' : 'bg-slate-100 text-slate-600'}`}>
            {step.overdue ? (step.ours ? due : `Chase — ${due}`) : due}
          </span>
        )}
        <ChevronRight className="h-5 w-5 shrink-0 text-slate-300" />
      </Link>
    </li>
  );
}

function Patients() {
  const router = useRouter();
  const params = useSearchParams();
  const centreId = useAuthStore((s) => s.activeCentreId);
  const workspace = useAuthStore((s) => s.staff?.workspace);
  const [all, setAll] = useState<Journey[] | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const stage = (params.get('stage') as StageKey | 'all' | null) ?? (workspace ? WORKSPACE_STAGE[workspace] : 'all');

  const load = useCallback(async () => {
    if (!centreId) return;
    try { setAll(await fetchJourneys(centreId)); setError(''); } catch { setError('Could not load patients. Check the internet and refresh.'); }
  }, [centreId]);
  useEffect(() => { setAll(null); load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);

  const counts = useMemo(() => {
    const m: Record<string, { n: number; late: number }> = {};
    for (const j of all ?? []) { const x = (m[j.stage] ??= { n: 0, late: 0 }); x.n++; if (j.step.overdue) x.late++; }
    return m;
  }, [all]);

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (all ?? [])
      .filter((j) => (s ? true : stage === 'all' ? j.stage !== 'closed' : j.stage === stage))
      .filter((j) => !s || [j.c.patient_name, j.c.admission_ref, j.c.patient_uhid, j.c.clm_payers?.name, j.c.bill_no, j.c.tpa_claim_number]
        .some((v) => v?.toLowerCase().includes(s)))
      .sort(byUrgency);
  }, [all, stage, q]);

  if (!centreId) return <NoCentre />;
  const pick = (k: string) => router.replace(`/patients?stage=${k}`, { scroll: false });
  const open = (all ?? []).filter((j) => j.stage !== 'closed');
  const ours = rows.filter((j) => j.step.ours && j.stage !== 'closed');
  const rest = rows.filter((j) => !(j.step.ours && j.stage !== 'closed'));

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 md:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Patients</h1>
          <p className="mt-1 text-base text-slate-600">Every insurance, scheme and company patient — from pre-auth to money received.</p>
        </div>
        <Link href="/cases/new" className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"><UserPlus className="h-4 w-4" /> Add patient</Link>
      </div>

      {/* Stage tabs = the file journey */}
      <div className="-mx-4 mt-5 overflow-x-auto px-4">
        <div role="tablist" className="flex min-w-max gap-2">
          <button role="tab" aria-selected={stage === 'all'} onClick={() => pick('all')}
            className={`min-h-14 rounded-xl border px-4 text-left ${stage === 'all' ? 'border-teal-500 bg-teal-50' : 'border-slate-200 bg-white'}`}>
            <span className="block text-sm text-slate-500">All open</span><span className="text-lg font-bold text-slate-900">{open.length}</span>
          </button>
          {STAGES.map((s, i) => {
            const n = counts[s.key] ?? { n: 0, late: 0 };
            return (
              <button key={s.key} role="tab" aria-selected={stage === s.key} onClick={() => pick(s.key)}
                className={`min-h-14 rounded-xl border px-4 text-left ${stage === s.key ? 'border-teal-500 bg-teal-50' : 'border-slate-200 bg-white'}`}>
                <span className="block text-sm text-slate-500">{i + 1}. {s.label}</span>
                <span className="text-lg font-bold text-slate-900">{n.n}</span>
                {n.late > 0 && s.key !== 'closed' && <span className="ml-2 text-sm font-semibold text-rose-700">{n.late} late</span>}
              </button>
            );
          })}
        </div>
      </div>
      {stage !== 'all' && <p className="mt-3 text-base text-slate-600">{STAGES.find((s) => s.key === stage)?.hint}</p>}

      <label className="relative mt-4 block">
        <Search className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, IP No., UHID, insurer, claim no." aria-label="Search patients"
          className="min-h-12 w-full rounded-xl border border-slate-300 pl-10 pr-3 text-base focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100" />
      </label>

      {error && <p role="alert" className="mt-4 rounded-lg bg-rose-50 p-3 text-base text-rose-800">{error}</p>}
      {!all && !error && <div className="flex justify-center py-16"><Loader2 className="h-7 w-7 animate-spin text-teal-600" /></div>}

      {all && (rows.length === 0
        ? <p className="mt-6 rounded-xl border border-dashed border-slate-200 p-8 text-center text-base text-slate-500">No patients here.</p>
        : <>
          {ours.length > 0 && <>
            <h2 className="mt-6 text-lg font-semibold text-slate-900">Your turn ({ours.length})</h2>
            <ul className="mt-2 space-y-2">{ours.map((j) => <Row key={j.c.id} j={j} />)}</ul>
          </>}
          {rest.length > 0 && <>
            <h2 className="mt-8 text-lg font-semibold text-slate-900">{stage === 'closed' ? 'Closed' : `Waiting on insurer (${rest.length})`}</h2>
            {stage !== 'closed' && <p className="text-sm text-slate-500">Red ones are late — call or email the TPA.</p>}
            <ul className="mt-2 space-y-2">{rest.map((j) => <Row key={j.c.id} j={j} />)}</ul>
          </>}
        </>)}
    </div>
  );
}

export default function PatientsPage() {
  return <Suspense fallback={null}><Patients /></Suspense>;
}
