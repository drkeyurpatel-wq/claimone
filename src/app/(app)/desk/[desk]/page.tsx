'use client';
// A desk's work list: what the hospital must do now (late first), then what
// we are waiting on the insurer for. One tap opens the case.
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Loader2, Search, AlertTriangle, Clock, ChevronRight, Upload, UserPlus, Wallet } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import { fetchOpenCases, type CaseWithStep } from '@/lib/rcm/api';
import { byUrgency, dueText } from '@/lib/rcm/worklist';
import { NoCentre, inrShort } from '@/components/ui';

const TITLES = {
  admission: { title: 'Admission desk', sub: 'Pre-auth and enhancement for patients in hospital.' },
  claims: { title: 'Claims desk', sub: 'Final bills and claims after discharge, and their queries.' },
} as const;
type DeskKey = keyof typeof TITLES;

function CaseCard({ x }: { x: CaseWithStep }) {
  const { c, step } = x;
  const due = dueText(step);
  const amount = c.approved_amount ?? c.claimed_amount ?? c.estimated_amount;
  return (
    <li>
      <Link href={`/case/${c.id}`}
        className={`flex items-center gap-3 rounded-xl border bg-white p-4 transition hover:border-teal-400 hover:shadow-sm ${step.overdue ? 'border-rose-300' : 'border-slate-200'}`}>
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-slate-900">{c.patient_name}</p>
          <p className="truncate text-sm text-slate-500">{c.admission_ref ?? '—'} · {c.clm_payers?.name ?? c.sponsor_name ?? ''}{amount ? ` · ${inrShort(Number(amount))}` : ''}</p>
          <p className={`mt-1 text-base ${step.ours ? 'font-medium text-slate-800' : 'text-slate-600'}`}>{step.label}</p>
        </div>
        {due && (
          <span className={`shrink-0 rounded-full px-3 py-1 text-sm font-semibold ${step.overdue ? 'bg-rose-100 text-rose-800' : 'bg-slate-100 text-slate-600'}`}>
            {step.overdue ? (step.ours ? due : `Chase — ${due}`) : due}
          </span>
        )}
        <ChevronRight className="h-5 w-5 shrink-0 text-slate-300" />
      </Link>
    </li>
  );
}

export default function DeskPage() {
  const { desk } = useParams<{ desk: string }>();
  const centreId = useAuthStore((s) => s.activeCentreId);
  const [cases, setCases] = useState<CaseWithStep[] | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    if (!centreId) return;
    try { setCases(await fetchOpenCases(centreId)); setError(''); } catch (e) { setError((e as Error).message); }
  }, [centreId]);
  useEffect(() => { setCases(null); load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);

  const key = (desk in TITLES ? desk : 'admission') as DeskKey;
  const mine = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (cases ?? [])
      .filter((x) => x.step.desk === key)
      .filter((x) => !s || [x.c.patient_name, x.c.admission_ref, x.c.patient_uhid, x.c.clm_payers?.name, x.c.bill_no]
        .some((v) => v?.toLowerCase().includes(s)))
      .sort(byUrgency);
  }, [cases, key, q]);
  const paymentWaiting = (cases ?? []).filter((x) => x.step.desk === 'payment');

  if (!centreId) return <NoCentre />;

  const todo = mine.filter((x) => x.step.ours);
  const waiting = mine.filter((x) => !x.step.ours && x.step.key !== 'in_hospital_approved');
  const approved = mine.filter((x) => x.step.key === 'in_hospital_approved');
  const late = mine.filter((x) => x.step.overdue).length;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 md:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{TITLES[key].title}</h1>
          <p className="mt-1 text-base text-slate-600">{TITLES[key].sub}</p>
        </div>
        <div className="flex gap-2">
          <Link href="/cases/upload" className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"><Upload className="h-4 w-4" /> eCW file</Link>
          {key === 'admission' && <Link href="/cases/new" className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"><UserPlus className="h-4 w-4" /> Add patient</Link>}
        </div>
      </div>

      <div className="mt-5 grid grid-cols-3 gap-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-sm text-slate-500">To do</p><p className="text-2xl font-bold text-slate-900">{todo.length}</p></div>
        <div className={`rounded-xl border p-4 ${late ? 'border-rose-200 bg-rose-50' : 'border-slate-200 bg-white'}`}><p className="text-sm text-slate-500">Late</p><p className={`text-2xl font-bold ${late ? 'text-rose-700' : 'text-slate-900'}`}>{late}</p></div>
        <div className="rounded-xl border border-slate-200 bg-white p-4"><p className="text-sm text-slate-500">Waiting on insurer</p><p className="text-2xl font-bold text-slate-900">{waiting.length}</p></div>
      </div>

      <label className="relative mt-5 block">
        <Search className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, IP No., UHID, insurer" aria-label="Search cases"
          className="min-h-12 w-full rounded-xl border border-slate-300 pl-10 pr-3 text-base focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100" />
      </label>

      {error && <p role="alert" className="mt-4 rounded-lg bg-rose-50 p-3 text-base text-rose-800">{error}</p>}
      {!cases && !error && <div className="flex justify-center py-16"><Loader2 className="h-7 w-7 animate-spin text-teal-600" /></div>}

      {cases && (
        <>
          <h2 className="mt-6 flex items-center gap-2 text-lg font-semibold text-slate-900"><AlertTriangle className="h-5 w-5 text-amber-600" /> Do now</h2>
          {todo.length ? <ul className="mt-2 space-y-2">{todo.map((x) => <CaseCard key={x.c.id} x={x} />)}</ul>
            : <p className="mt-2 rounded-xl border border-dashed border-slate-200 p-6 text-center text-base text-slate-500">Nothing to do right now.</p>}

          {waiting.length > 0 && <>
            <h2 className="mt-8 flex items-center gap-2 text-lg font-semibold text-slate-900"><Clock className="h-5 w-5 text-slate-500" /> Waiting on insurer</h2>
            <p className="text-sm text-slate-500">Red ones are late — call or email the TPA.</p>
            <ul className="mt-2 space-y-2">{waiting.map((x) => <CaseCard key={x.c.id} x={x} />)}</ul>
          </>}

          {approved.length > 0 && <details className="mt-8">
            <summary className="cursor-pointer text-lg font-semibold text-slate-900">In hospital, approved ({approved.length})</summary>
            <ul className="mt-2 space-y-2">{approved.map((x) => <CaseCard key={x.c.id} x={x} />)}</ul>
          </details>}

          {key === 'claims' && paymentWaiting.length > 0 && (
            <Link href="/pay/check" className="mt-8 flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 text-base hover:border-teal-400">
              <Wallet className="h-5 w-5 text-teal-600" />
              <span className="flex-1"><b>{paymentWaiting.length}</b> approved claims waiting for money · {paymentWaiting.filter((x) => x.step.overdue).length} late</span>
              <ChevronRight className="h-5 w-5 text-slate-300" />
            </Link>
          )}
        </>
      )}
    </div>
  );
}
