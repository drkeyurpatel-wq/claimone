'use client';
// The ledger: one row per insurance / scheme / company patient, filled left
// to right from admission to money received. Yellow is ours to fill now,
// blue waits on the insurer, red needs a decision. The last column is the reminder.
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, Search, UserPlus, Download, Plus } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import { fetchJourneys, type Journey } from '@/lib/rcm/api';
import { COLUMNS, FILTERS, byReminder, inFilter, ledgerRow, toCsv, type Age, type Cell, type ColKey, type Filter, type LedgerRow } from '@/lib/rcm/ledger';
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

type Nav = { row: number; col: number };
function CellView({ cell, onOpen, nav }: { cell: Cell; onOpen: () => void; nav?: Nav }) {
  const cls = cell.tone ? TONE_CLS[cell.tone] : STATE_CLS[cell.state];
  const at = nav ? { 'data-cell': '', 'data-row': nav.row, 'data-col': nav.col } : {};
  const empty = !cell.text;
  const body = (
    <>
      <span className="block truncate">{empty ? (cell.state === 'ours' ? 'Action due' : cell.editable ? '' : '—') : cell.text}</span>
      {cell.tag && <span className="mt-0.5 inline-block rounded bg-violet-100 px-1.5 py-px text-[11px] font-semibold text-violet-800" title="Brought over from the old Excel sheet">{cell.tag}</span>}
      {cell.sub && <span className="block truncate text-xs font-normal opacity-80">{cell.sub}</span>}
      {empty && cell.editable && cell.state !== 'ours' && <span className="inline-flex items-center gap-0.5 text-sm"><Plus className="h-3.5 w-3.5" />Update</span>}
    </>
  );
  if (!cell.editable) return <div {...at} tabIndex={nav ? -1 : undefined} className={`min-h-[52px] rounded-md px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-inset focus:ring-teal-500 ${cls}`}>{body}</div>;
  return (
    <button type="button" onClick={onOpen} {...at}
      className={`min-h-[52px] w-full rounded-md px-2 py-1.5 text-left text-sm outline-none transition hover:bg-teal-50 hover:ring-2 hover:ring-inset hover:ring-teal-400 focus:ring-2 focus:ring-inset focus:ring-teal-600 ${cls}`}>
      {body}
    </button>
  );
}

const AGE_CLS: Record<Age['band'], string> = { ok: 'bg-slate-100 text-slate-600', warn: 'bg-amber-100 text-amber-900', late: 'bg-rose-100 text-rose-800' };
function AgeChip({ age }: { age: Age | null }) {
  if (!age) return null;
  const text = age.from === 'discharge' ? `${age.days} d since discharge` : `Day ${age.days + 1} in hospital`;
  return <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${AGE_CLS[age.band]}`}>{text}</span>;
}

function NextAction({ r }: { r: LedgerRow }) {
  return (
    <div className={`min-w-[13rem] rounded-md px-2 py-1.5 text-sm ${r.next.done ? 'text-slate-500' : r.next.late ? 'bg-rose-50 text-rose-800' : r.next.ours ? 'text-slate-900' : 'text-slate-600'}`}>
      <span className={`block ${r.next.ours && !r.next.done ? 'font-semibold' : ''}`}>{r.next.text}</span>
      {r.next.due && <span className={`block text-xs ${r.next.late ? 'font-semibold' : ''}`}>{r.next.late ? r.next.due : `Due ${r.next.due}`}</span>}
      <AgeChip age={r.age} />
    </div>
  );
}

/** Arrow keys move between cells like a spreadsheet; Enter opens the cell. */
function moveFocus(e: React.KeyboardEvent) {
  const dirs: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
  const d = dirs[e.key];
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-cell]');
  if (!d || !el) return;
  const row = Number(el.dataset.row) + d[0], col = Number(el.dataset.col) + d[1];
  const next = (e.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-cell][data-row="${row}"][data-col="${col}"]`);
  if (next) { e.preventDefault(); next.focus(); }
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
    catch { setError('Could not load Master. Please check the connection and refresh.'); }
  }, [centreId]);
  useEffect(() => { setAll(null); load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);

  const rows = useMemo(() => (all ?? []).map((j) => ledgerRow(j, canWrite)), [all, canWrite]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.key, rows.filter((r) => inFilter(r, f.key)).length])), [rows]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return rows
      .filter((r) => (s ? true : inFilter(r, filter)))
      .filter((r) => !s || [r.j.c.patient_name, r.j.c.admission_ref, r.j.c.patient_uhid, r.j.c.clm_payers?.name, r.j.c.tpa_claim_number, r.j.c.tpa_preauth_number,
        r.j.c.bill_no, r.j.c.case_source === 'sheet' ? 'old sheet' : 'entered in claimone']
        .some((v) => v?.toLowerCase().includes(s)))
      .sort(byReminder);
  }, [rows, filter, q]);
  const editing = edit ? rows.find((r) => r.j.c.id === edit.id) ?? null : null;
  const table = useRef<HTMLTableElement>(null);
  // after a cell's form closes, the cursor goes back to that cell
  const closeEdit = useCallback(() => {
    const was = edit;
    setEdit(null);
    if (was) setTimeout(() => table.current?.querySelector<HTMLElement>(`tr[data-id="${was.id}"] [data-key="${was.col}"] [data-cell]`)?.focus(), 50);
  }, [edit]);

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
  const saved = async (msg: string) => { closeEdit(); flash(msg); await load(); };

  return (
    <div className="px-3 py-6 md:px-6">
      {toastNode}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Master{centreName && centres.length > 1 ? ` — ${centreName}` : ''}</h1>
          <p className="mt-1 text-base text-slate-600">Cashless and credit cases, admission to settlement. Select a cell to update it<span className="hidden md:inline"> — arrow keys move, Enter opens</span>.</p>
          <div className="mt-2 flex flex-wrap gap-2 text-sm">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-0.5 font-medium text-amber-900 ring-1 ring-amber-300"><span className="h-2 w-2 rounded-full bg-amber-400" />Action due</span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-50 px-2.5 py-0.5 font-medium text-sky-900 ring-1 ring-sky-300"><span className="h-2 w-2 rounded-full bg-sky-400" />Awaiting payer</span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-50 px-2.5 py-0.5 font-medium text-rose-800 ring-1 ring-rose-300"><span className="h-2 w-2 rounded-full bg-rose-500" />Decision needed</span>
          </div>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={download} disabled={!shown.length}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40">
            <Download className="h-4 w-4" /> Export to Excel</button>
          {canWrite && <button type="button" onClick={() => setAdding(true)}
            className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-teal-600 px-4 text-sm font-semibold text-white hover:bg-teal-700">
            <UserPlus className="h-4 w-4" /> New admission</button>}
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
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search patient, IP / bill / claim no., payer or old sheet" aria-label="Search Master"
            className="min-h-11 w-full rounded-full border border-slate-300 pl-9 pr-3 text-sm focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100" />
        </label>
      </div>

      {error && <p role="alert" className="mt-4 rounded-lg bg-rose-50 p-3 text-base text-rose-800">{error}</p>}
      {!all && !error && <div className="flex justify-center py-16"><Loader2 className="h-7 w-7 animate-spin text-teal-600" /></div>}

      {all && shown.length === 0 && (
        <div className="mt-6 rounded-xl border border-dashed border-slate-300 p-10 text-center">
          <p className="text-base text-slate-600">{q ? 'No case matches this search.' : all.length === 0 ? 'No cases yet.' : filter === 'open' ? 'All caught up — no open cases.' : 'Nothing here right now.'}</p>
          {canWrite && all.length === 0 && <button type="button" onClick={() => setAdding(true)} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-lg bg-teal-600 px-4 text-sm font-semibold text-white"><UserPlus className="h-4 w-4" /> Add first admission</button>}
        </div>
      )}

      {all && shown.length > 0 && (
        <div className="mt-4 hidden overflow-x-auto rounded-xl border border-slate-200 bg-white md:block">
          <table ref={table} onKeyDown={moveFocus} className="w-full min-w-[1240px] border-collapse text-left">
            <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="sticky left-0 z-10 w-48 border-b border-slate-200 bg-slate-50 px-3 py-2.5">Patient</th>
                <th scope="col" className="w-32 border-b border-slate-200 px-3 py-2.5">Payer</th>
                {COLUMNS.slice(1).map((col) => (
                  <th key={col.key} scope="col" className="border-b border-slate-200 px-3 py-2.5">{col.label}</th>
                ))}
                <th scope="col" className="w-56 border-b border-slate-200 px-3 py-2.5">Next action</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r: LedgerRow, i) => (
                <tr key={r.j.c.id} className={`border-b border-slate-100 align-top ${fresh === r.j.c.id ? 'bg-teal-50/60' : ''}`} data-id={r.j.c.id}>
                  <td className="sticky left-0 z-10 w-48 min-w-[12rem] max-w-[14rem] bg-white p-1 shadow-[1px_0_0_#e2e8f0]" data-key="patient">
                    <CellView cell={r.cells.patient} nav={{ row: i, col: 0 }} onOpen={() => setEdit({ id: r.j.c.id, col: 'patient' })} />
                  </td>
                  <td className="p-1"><div className="min-w-[8rem] max-w-[10rem] px-2 py-1.5 text-sm text-slate-700">{r.j.c.clm_payers?.name ?? r.j.c.sponsor_name ?? '—'}</div></td>
                  {COLUMNS.slice(1).map((col, k) => (
                    <td key={col.key} className="p-1" data-key={col.key}>
                      <CellView cell={r.cells[col.key]} nav={{ row: i, col: k + 1 }} onOpen={() => setEdit({ id: r.j.c.id, col: col.key })} />
                    </td>
                  ))}
                  <td className="p-1"><NextAction r={r} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {all && shown.length > 0 && (
        <ul className="mt-4 space-y-3 md:hidden">
          {shown.map((r) => (
            <li key={r.j.c.id} className={`rounded-xl border border-slate-200 bg-white p-3 ${fresh === r.j.c.id ? 'ring-2 ring-teal-300' : ''}`}>
              <button type="button" onClick={() => setEdit({ id: r.j.c.id, col: 'patient' })} className="block w-full text-left">
                <span className="block text-base font-semibold text-slate-900">{r.j.c.patient_name}</span>
                <span className="block text-sm text-slate-500">{[r.j.c.admission_ref, r.j.c.clm_payers?.name ?? r.j.c.sponsor_name].filter(Boolean).join(' · ')}</span>
              </button>
              <div className="mt-2"><NextAction r={r} /></div>
              <div className="mt-2 grid grid-cols-2 gap-1.5">
                {COLUMNS.slice(1).filter((col) => r.cells[col.key].state !== 'na').map((col) => (
                  <div key={col.key}>
                    <span className="block px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{col.short}</span>
                    <CellView cell={r.cells[col.key]} onOpen={() => setEdit({ id: r.j.c.id, col: col.key })} />
                  </div>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
      {all && shown.length > 0 && <p className="mt-2 text-sm text-slate-500">{shown.length} case{shown.length === 1 ? '' : 's'}{filter === 'closed' && !q ? ' closed in the last 60 days' : ''}</p>}

      {editing && edit && <CellEditor r={editing} col={edit.col} canWrite={canWrite} isManager={isManager} onClose={closeEdit} onSaved={saved} />}
      {adding && <AddPatient tenantId={tenantId} centreId={centreId} onClose={() => setAdding(false)}
        onSaved={async (id) => { setAdding(false); setFresh(id); setQ(''); router.replace('/master', { scroll: false }); flash('Admission added to Master'); await load(); }} />}
    </div>
  );
}

export default function LedgerPage() {
  return <Suspense fallback={null}><Ledger /></Suspense>;
}
