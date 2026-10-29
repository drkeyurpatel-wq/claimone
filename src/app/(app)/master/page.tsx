'use client';
// The ledger: one row per insurance / scheme / company patient, filled left
// to right from admission to money received. Yellow is ours to fill now,
// blue waits on the insurer, red needs a decision. The last column is the reminder.
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, Search, UserPlus, Download, Plus } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import { fetchJourneys, type Journey } from '@/lib/rcm/api';
import { COLUMNS, FILTERS, byReminder, inFilter, ledgerRow, toCsv, type Cell, type ColKey, type Filter, type LedgerRow } from '@/lib/rcm/ledger';
import { CellEditor } from '@/components/ledger/CellEditor';
import { AddPatient } from '@/components/ledger/AddPatient';
import { NoCentre, useToast } from '@/components/ui';

const STATE_CLS: Record<Cell['state'], string> = {
  done: 'text-slate-900',
  ours: 'bg-amber-50 ring-2 ring-inset ring-amber-400 text-amber-900 font-semibold',
  theirs: 'bg-sky-50 ring-1 ring-inset ring-sky-300 text-sky-900',
  open: 'text-slate-400',
  blank: 'text-slate-300',
  na: 'text-slate-400 italic',
};
const TONE_CLS = { alert: 'bg-rose-50 ring-2 ring-inset ring-rose-400 text-rose-800 font-semibold', warn: 'bg-amber-50 ring-1 ring-inset ring-amber-300 text-amber-900' };

function CellView({ cell, onOpen }: { cell: Cell; onOpen: () => void }) {
  const cls = cell.tone ? TONE_CLS[cell.tone] : STATE_CLS[cell.state];
  const empty = !cell.text;
  const body = (
    <>
      <span className="block truncate">{empty ? (cell.state === 'ours' ? 'Fill now' : cell.editable ? '' : '—') : cell.text}</span>
      {cell.sub && <span className="block truncate text-xs font-normal opacity-80">{cell.sub}</span>}
      {empty && cell.editable && cell.state !== 'ours' && <span className="inline-flex items-center gap-0.5 text-sm"><Plus className="h-3.5 w-3.5" />Add</span>}
    </>
  );
  if (!cell.editable) return <div className={`min-h-[52px] rounded-md px-2 py-1.5 text-sm ${cls}`}>{body}</div>;
  return (
    <button type="button" onClick={onOpen}
      className={`min-h-[52px] w-full rounded-md px-2 py-1.5 text-left text-sm transition hover:bg-teal-50 hover:ring-2 hover:ring-inset hover:ring-teal-400 ${cls}`}>
      {body}
    </button>
  );
}

function Ledger() {
  const router = useRouter();
  const params = useSearchParams();
  const { activeCentreId: centreId, tenantId, staff, centres } = useAuthStore();
  const role = staff?.role;
  const canWrite = role === 'admin' || role === 'manager' || role === 'desk';
  const isManager = role === 'admin' || role === 'manager';
  const { flash, toastNode } = useToast();

  const [all, setAll] = useState<Journey[] | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<{ id: string; col: ColKey } | null>(null);
  const [adding, setAdding] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const filter = (FILTERS.some((f) => f.key === params.get('show')) ? params.get('show') : 'open') as Filter;

  const load = useCallback(async () => {
    if (!centreId) return;
    try { setAll(await fetchJourneys(centreId)); setError(''); }
    catch { setError('Could not load Master. Check the internet and refresh.'); }
  }, [centreId]);
  useEffect(() => { setAll(null); load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);

  const rows = useMemo(() => (all ?? []).map((j) => ledgerRow(j, canWrite)), [all, canWrite]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.key, rows.filter((r) => inFilter(r, f.key)).length])), [rows]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return rows
      .filter((r) => (s ? true : inFilter(r, filter)))
      .filter((r) => !s || [r.j.c.patient_name, r.j.c.admission_ref, r.j.c.patient_uhid, r.j.c.clm_payers?.name, r.j.c.tpa_claim_number, r.j.c.tpa_preauth_number]
        .some((v) => v?.toLowerCase().includes(s)))
      .sort(byReminder);
  }, [rows, filter, q]);
  const editing = edit ? rows.find((r) => r.j.c.id === edit.id) ?? null : null;

  if (!centreId || !tenantId) return <NoCentre />;
  const centreName = centres.find((c) => c.id === centreId)?.name;

  const download = () => {
    const blob = new Blob([toCsv(shown)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ClaimOne Master ${centreName ?? ''} ${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const saved = async (msg: string) => { setEdit(null); flash(msg); await load(); };

  return (
    <div className="px-3 py-6 md:px-6">
      {toastNode}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Master{centreName && centres.length > 1 ? ` — ${centreName}` : ''}</h1>
          <p className="mt-1 text-base text-slate-600">Tap a box to fill it. <span className="rounded bg-amber-100 px-1.5 font-semibold text-amber-900">Yellow</span> is ours to do now,{' '}
            <span className="rounded bg-sky-100 px-1.5 text-sky-900">blue</span> waits on the insurer, <span className="rounded bg-rose-100 px-1.5 font-semibold text-rose-800">red</span> needs a decision.</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={download} disabled={!shown.length}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40">
            <Download className="h-4 w-4" /> Download Excel</button>
          {canWrite && <button type="button" onClick={() => setAdding(true)}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-teal-600 px-4 text-sm font-semibold text-white hover:bg-teal-700">
            <UserPlus className="h-4 w-4" /> Add patient</button>}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div role="tablist" className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button key={f.key} type="button" role="tab" aria-selected={filter === f.key && !q}
              onClick={() => { setQ(''); router.replace(f.key === 'open' ? '/master' : `/master?show=${f.key}`, { scroll: false }); }}
              className={`min-h-11 rounded-full border px-4 text-sm font-medium ${filter === f.key && !q ? 'border-teal-600 bg-teal-600 text-white' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`}>
              {f.label} <span className="ml-1 tabular-nums opacity-80">{all ? counts[f.key] : ''}</span>
            </button>
          ))}
        </div>
        <label className="relative ml-auto w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, IP No., insurer, claim no." aria-label="Search Master"
            className="min-h-11 w-full rounded-full border border-slate-300 pl-9 pr-3 text-sm focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100" />
        </label>
      </div>

      {error && <p role="alert" className="mt-4 rounded-lg bg-rose-50 p-3 text-base text-rose-800">{error}</p>}
      {!all && !error && <div className="flex justify-center py-16"><Loader2 className="h-7 w-7 animate-spin text-teal-600" /></div>}

      {all && shown.length === 0 && (
        <div className="mt-6 rounded-xl border border-dashed border-slate-300 p-10 text-center">
          <p className="text-base text-slate-600">{q ? 'No patient matches that search.' : all.length === 0 ? 'Master is empty.' : filter === 'open' ? 'All caught up — no open files.' : 'Nothing here right now.'}</p>
          {canWrite && all.length === 0 && <button type="button" onClick={() => setAdding(true)} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-lg bg-teal-600 px-4 text-sm font-semibold text-white"><UserPlus className="h-4 w-4" /> Add the first patient</button>}
        </div>
      )}

      {all && shown.length > 0 && (
        <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[1080px] border-collapse text-left">
            <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="sticky left-0 z-10 w-48 border-b border-slate-200 bg-slate-50 px-3 py-2.5">Patient</th>
                <th scope="col" className="w-32 border-b border-slate-200 px-3 py-2.5">Insurer</th>
                {COLUMNS.slice(1).map((col) => (
                  <th key={col.key} scope="col" className="border-b border-slate-200 px-3 py-2.5">{col.label}</th>
                ))}
                <th scope="col" className="w-56 border-b border-slate-200 px-3 py-2.5">Next / reminder</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r: LedgerRow) => (
                <tr key={r.j.c.id} className={`border-b border-slate-100 align-top ${fresh === r.j.c.id ? 'bg-teal-50/60' : ''}`} data-id={r.j.c.id}>
                  <td className="sticky left-0 z-10 w-48 bg-white p-1 shadow-[1px_0_0_#e2e8f0]">
                    <CellView cell={r.cells.patient} onOpen={() => setEdit({ id: r.j.c.id, col: 'patient' })} />
                  </td>
                  <td className="p-1"><div className="px-2 py-1.5 text-sm text-slate-700">{r.j.c.clm_payers?.name ?? r.j.c.sponsor_name ?? '—'}</div></td>
                  {COLUMNS.slice(1).map((col) => (
                    <td key={col.key} className="p-1">
                      <CellView cell={r.cells[col.key]} onOpen={() => setEdit({ id: r.j.c.id, col: col.key })} />
                    </td>
                  ))}
                  <td className="p-1">
                    <div className={`rounded-md px-2 py-1.5 text-sm ${r.next.done ? 'text-slate-500' : r.next.late ? 'bg-rose-50 text-rose-800' : r.next.ours ? 'text-slate-900' : 'text-slate-600'}`}>
                      <span className={`block ${r.next.ours && !r.next.done ? 'font-semibold' : ''}`}>{r.next.text}</span>
                      {r.next.due && <span className={`block text-xs ${r.next.late ? 'font-semibold' : ''}`}>{r.next.late ? r.next.due : `Due ${r.next.due}`}</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {all && shown.length > 0 && <p className="mt-2 text-sm text-slate-500">{shown.length} patient{shown.length === 1 ? '' : 's'}{filter === 'closed' && !q ? ' closed in the last 60 days' : ''}</p>}

      {editing && edit && <CellEditor r={editing} col={edit.col} canWrite={canWrite} isManager={isManager} onClose={() => setEdit(null)} onSaved={saved} />}
      {adding && <AddPatient tenantId={tenantId} centreId={centreId} onClose={() => setAdding(false)}
        onSaved={async (id) => { setAdding(false); setFresh(id); setQ(''); router.replace('/master', { scroll: false }); flash('Patient added'); await load(); }} />}
    </div>
  );
}

export default function LedgerPage() {
  return <Suspense fallback={null}><Ledger /></Suspense>;
}
