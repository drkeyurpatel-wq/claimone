'use client';
// Master and the Archive. Master: one row per active insurance / scheme / company patient, filled left
// to right from admission to money received; settled files leave for the Archive. Yellow is ours to fill now,
// blue waits on the insurer, red needs a decision. The last column is the reminder.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Loader2, Search, UserPlus, Download, Plus, Archive, SlidersHorizontal, X, ArrowUp, ArrowDown, ChevronsUpDown, BadgeCheck } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import { fetchArchive, fetchJourneys, type Journey } from '@/lib/rcm/api';
import { VIEW_COLUMNS, FILTERS, PAY_STATES, isOld, firstDir, sortRows, doctorKey, doctorLabel, inFilter, inPayState, inBank, ledgerRow, rowPayerGroup, toCsv, type Age, type Cell, type ColKey, type Filter, type LedgerRow, type PayState, type Sort, type SortKey } from '@/lib/rcm/ledger';
import { PAYER_GROUPS, type PayerGroup } from '@/lib/rcm/payer';
import { CellEditor } from '@/components/ledger/CellEditor';
import { AddPatient } from '@/components/ledger/AddPatient';
import { NoCentre, useToast } from '@/components/ui';

// A cell is plain text. What needs someone shows a dot and a light tint: amber is ours to do,
// blue waits on the payer, red needs a decision.
const DOT: Record<string, string> = { ours: 'bg-amber-500', theirs: 'bg-sky-500', alert: 'bg-rose-500', warn: 'bg-amber-400' };
const TINT: Record<string, string> = { ours: 'bg-amber-50', theirs: '', alert: 'bg-rose-50', warn: 'bg-amber-50/60' };
const INK: Record<Cell['state'], string> = { done: 'text-slate-900', ours: 'font-semibold text-amber-900', theirs: 'text-sky-900', open: 'text-slate-400', blank: 'text-slate-300', na: 'text-slate-400' };

const SORT_HINT: Record<SortKey, string> = { patient: 'patient name', preauth: 'date pre-auth was sent', disch: 'discharge date', claim: 'date the claim was sent', pay: 'amount (due on Master, received in the Archive)' };

type Nav = { row: number; col: number };
function CellView({ cell, onOpen, nav, strong }: { cell: Cell; onOpen: () => void; nav?: Nav; strong?: boolean }) {
  const mark = cell.tone ?? (cell.state === 'ours' || cell.state === 'theirs' ? cell.state : '');
  const ink = cell.tone === 'alert' ? 'font-semibold text-rose-800' : INK[cell.state];
  const at = nav ? { 'data-cell': '', 'data-row': nav.row, 'data-col': nav.col } : {};
  const empty = !cell.text;
  const text = empty ? (cell.state === 'ours' ? 'Action due' : cell.editable ? 'Add' : '—') : cell.text;
  const body = (
    <>
      <span className={`flex items-center gap-1.5 text-[15px] leading-5 ${strong ? 'font-semibold text-slate-900' : ink}`}>
        {mark && <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[mark]}`} />}
        {empty && cell.editable && cell.state !== 'ours' && <Plus className="h-3.5 w-3.5 shrink-0" />}
        <span className="truncate" title={text}>{text}</span>
        {cell.verified && <span title="Verified in the bank statement" className="shrink-0"><BadgeCheck className="h-4 w-4 text-sky-600" aria-label="Verified in the bank statement" /></span>}
        {cell.tag && <span className="shrink-0 rounded bg-violet-100 px-1.5 text-[11px] font-semibold leading-4 text-violet-800" title={cell.tag === 'Old sheet' ? 'Brought over from the old Excel sheet' : 'Loaded from the PMJAY sheet'}>{cell.tag}</span>}
      </span>
      {cell.sub && <span className="mt-0.5 block truncate text-[13px] leading-4 text-slate-500" title={cell.sub}>{cell.sub}</span>}
    </>
  );
  const box = `block min-h-[44px] w-full rounded-md px-2.5 py-1.5 text-left outline-none ${TINT[mark] ?? ''}`;
  if (!cell.editable) return <div {...at} tabIndex={nav ? -1 : undefined} className={`${box} focus:ring-2 focus:ring-inset focus:ring-teal-500`}>{body}</div>;
  return (
    <button type="button" onClick={onOpen} {...at} className={`${box} transition hover:bg-teal-50 hover:ring-1 hover:ring-inset hover:ring-teal-400 focus:ring-2 focus:ring-inset focus:ring-teal-600`}>
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
  const tone = r.next.done ? 'text-slate-500' : r.next.late ? 'text-rose-800' : r.next.ours ? 'text-slate-900' : 'text-slate-600';
  return (
    <div className={`rounded-md px-2.5 py-1.5 ${r.next.late && !r.next.done ? 'bg-rose-50' : ''} ${tone}`}>
      <span className={`block text-[15px] leading-5 ${r.next.ours && !r.next.done ? 'font-semibold' : ''}`}>{r.next.text}</span>
      {r.next.due && <span className={`mt-0.5 block text-[13px] leading-4 ${r.next.late ? 'font-semibold' : ''}`}>{r.next.late ? r.next.due : `Due ${r.next.due}`}</span>}
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

/** Master (active files) and the Archive (settled and closed files) share one screen. */
/** `old`: the files discharged before 1 Nov (their own tab). Master and Archive hold only files from 1 Nov. */
export function LedgerScreen({ archive = false, old = false, source }: { archive?: boolean; old?: boolean; source?: (centreId: string) => Promise<Journey[]> }) {
  const router = useRouter();
  const params = useSearchParams();
  const { activeCentreId: centreId, tenantId, staff, centres } = useAuthStore();
  const role = staff?.role;
  const canWrite = role === 'admin' || role === 'manager' || role === 'desk';
  const isManager = role === 'admin' || role === 'manager';
  const { flash, toastNode } = useToast();

  const [all, setAll] = useState<Journey[] | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState(params.get('q') ?? '');
  const [bank, setBank] = useState<'' | 'in' | 'not'>('');
  const [ptype, setPtype] = useState<PayerGroup | ''>('');
  const [pay, setPay] = useState<PayState | ''>('');
  const [doc, setDoc] = useState('');
  const [edit, setEdit] = useState<{ id: string; col: ColKey } | null>(null);
  const [adding, setAdding] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sort, setSort] = useState<Sort | null>(null);
  // first click: the column's natural order; second: the reverse; third: back to the reminder order
  const sortBy = (key: SortKey) => setSort((s) => (s?.key !== key ? { key, dir: firstDir(key) } : s.dir === firstDir(key) ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : null));
  const [fresh, setFresh] = useState<string | null>(null);
  const asked = params.get('show');
  // Closed files now live in the Archive
  useEffect(() => { if (!archive && asked === 'closed') router.replace('/archive'); }, [archive, asked, router]);
  const filter = (archive ? 'closed' : old ? 'backlog' : FILTERS.some((f) => f.key === asked && f.key !== 'closed' && f.key !== 'backlog') ? asked : 'open') as Filter;

  // the centre being shown: a slow answer for a centre the user has left is dropped
  const current = useRef(centreId);
  current.current = centreId;
  const load = useCallback(async () => {
    if (!centreId) return;
    try {
      const j = source ? await source(centreId) : archive ? await fetchArchive(centreId) : await fetchJourneys(centreId);
      if (current.current !== centreId) return;
      setAll(j); setError('');
    } catch { if (current.current === centreId) setError(`Could not load ${archive ? 'the Archive' : 'Master'}. Please check the connection and refresh.`); }
  }, [centreId, archive, source]);
  useEffect(() => { setAll(null); load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);

  // demo patients made while building ClaimOne stay out of the team's view
  // Master holds the files still being worked; the Archive the ones paid and closed (no cut pending or disputed)
  const rows = useMemo(() => (all ?? []).filter((j) => !/^DEMO/i.test(j.c.admission_ref ?? '')).map((j) => ledgerRow(j, canWrite))
    .filter((r) => r.next.done === archive && isOld(r) === old), [all, canWrite, archive, old]);
  // payer type and payment narrow everything, including the counts on the status buttons
  const narrowed = useMemo(() => rows.filter((r) => (!ptype || rowPayerGroup(r) === ptype) && (!pay || inPayState(r, pay))
    && (!doc || doctorKey(r.j.c.treating_doctor_name) === doc) && (!bank || inBank(r) === (bank === 'in'))), [rows, ptype, pay, doc, bank]);
  // doctors on the files, most files first, for the filter and the New admission suggestions
  const doctors = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) { const k = doctorKey(r.j.c.treating_doctor_name); if (k) m.set(k, (m.get(k) ?? 0) + 1); }
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
  }, [rows]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.key, narrowed.filter((r) => inFilter(r, f.key)).length])), [narrowed]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return sortRows(narrowed
      .filter((r) => (s ? true : inFilter(r, filter)))
      .filter((r) => !s || [r.j.c.patient_name, r.j.c.admission_ref, r.j.c.patient_uhid, r.j.c.clm_payers?.name, r.j.c.treating_doctor_name, r.j.c.tpa_claim_number, r.j.c.tpa_preauth_number,
        r.j.c.bill_no, r.j.c.case_source === 'sheet' ? 'old sheet' : r.j.c.case_source === 'pmjay' ? 'pmjay sheet' : 'entered in claimone']
        .some((v) => v?.toLowerCase().includes(s))), sort, archive);
  }, [narrowed, filter, q, sort, archive]);
  const editing = edit ? rows.find((r) => r.j.c.id === edit.id) ?? null : null;
  const table = useRef<HTMLTableElement>(null);
  // after a cell's form closes, the cursor goes back to that cell
  const closeEdit = useCallback(() => {
    const was = edit;
    setEdit(null);
    if (was) setTimeout(() => table.current?.querySelector<HTMLElement>(`tr[data-id="${was.id}"] [data-key="${was.col}"] [data-cell]`)?.focus(), 50);
  }, [edit]);

  const active = [ptype, pay, doc, bank].filter(Boolean).length;

  if (!centreId || !tenantId) return <NoCentre />;
  const centreName = centres.find((c) => c.id === centreId)?.name;

  const download = () => {
    const blob = new Blob([toCsv(shown)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `ClaimOne ${old ? (archive ? 'Before 1 Nov settled' : 'Before 1 Nov pending') : archive ? 'Archive' : 'Master'} ${centreName ?? ''} ${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const saved = async (msg: string) => { closeEdit(); flash(msg); await load(); };

  return (
    <div className="px-3 py-4 md:px-5">
      {toastNode}
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-2xl font-bold text-slate-900">{old ? (archive ? 'Before 1 Nov — settled files' : 'Before 1 Nov — pending files') : archive ? 'Archive' : 'Master'}{centreName && centres.length > 1 ? ` — ${centreName}` : ''}
          {all && <span className="ml-2 text-base font-medium text-slate-500">{shown.length} case{shown.length === 1 ? '' : 's'}</span>}</h1>
        <label className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, IP, bill or claim no." aria-label={archive ? 'Search Archive' : 'Search Master'}
            className="min-h-11 w-full rounded-lg border border-slate-300 pl-9 pr-3 text-[15px] focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100" />
        </label>
        <div className="relative">
          <button type="button" onClick={() => setFiltersOpen((o) => !o)} aria-expanded={filtersOpen}
            className={`inline-flex min-h-11 items-center gap-2 rounded-lg border px-3 text-[15px] font-medium ${active ? 'border-teal-600 bg-teal-50 text-teal-800' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`}>
            <SlidersHorizontal className="h-4 w-4" /> Filter{active ? ` · ${active}` : ''}</button>
          {filtersOpen && <>
            <button type="button" aria-label="Close filters" className="fixed inset-0 z-30 cursor-default" onClick={() => setFiltersOpen(false)} />
            <div className="absolute right-0 z-40 mt-2 w-72 space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-lg">
              <label className="block text-sm font-medium text-slate-600">Payer type
                <select value={ptype} onChange={(e) => setPtype(e.target.value as PayerGroup | '')} className={`mt-1 min-h-11 w-full rounded-lg border px-3 text-[15px] font-medium ${ptype ? 'border-teal-600 bg-teal-50 text-teal-800' : 'border-slate-300 bg-white text-slate-800'}`}>
                  <option value="">All payer types</option>
                  {PAYER_GROUPS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
                </select></label>
              <label className="block text-sm font-medium text-slate-600">Payment
                <select value={pay} onChange={(e) => setPay(e.target.value as PayState | '')} className={`mt-1 min-h-11 w-full rounded-lg border px-3 text-[15px] font-medium ${pay ? 'border-teal-600 bg-teal-50 text-teal-800' : 'border-slate-300 bg-white text-slate-800'}`}>
                  <option value="">Any payment</option>
                  {PAY_STATES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                </select></label>
              <label className="block text-sm font-medium text-slate-600">Doctor
                <select value={doc} onChange={(e) => setDoc(e.target.value)} className={`mt-1 min-h-11 w-full rounded-lg border px-3 text-[15px] font-medium ${doc ? 'border-teal-600 bg-teal-50 text-teal-800' : 'border-slate-300 bg-white text-slate-800'}`}>
                  <option value="">All doctors</option>
                  {doctors.map((d) => <option key={d} value={d}>{doctorLabel(d)}</option>)}
                </select></label>
              {archive && <label className="block text-sm font-medium text-slate-600">Bank statement
                <select value={bank} onChange={(e) => setBank(e.target.value as '' | 'in' | 'not')} className={`mt-1 min-h-11 w-full rounded-lg border px-3 text-[15px] font-medium ${bank ? 'border-teal-600 bg-teal-50 text-teal-800' : 'border-slate-300 bg-white text-slate-800'}`}>
                  <option value="">All</option>
                  <option value="in">Verified (blue tick)</option>
                  <option value="not">Not verified yet</option>
                </select></label>}
              <div className="flex justify-between pt-1">
                <button type="button" disabled={!active} onClick={() => { setPtype(''); setPay(''); setDoc(''); setBank(''); }} className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-slate-600 disabled:opacity-40"><X className="h-4 w-4" /> Clear</button>
                <button type="button" onClick={() => setFiltersOpen(false)} className="min-h-11 rounded-lg bg-teal-600 px-4 text-sm font-semibold text-white hover:bg-teal-700">Done</button>
              </div>
            </div>
          </>}
        </div>
        <button type="button" onClick={download} disabled={!shown.length}
          className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-[15px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40">
          <Download className="h-4 w-4" /> Export</button>
        {canWrite && !archive && !old && <button type="button" onClick={() => setAdding(true)}
          className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-teal-600 px-4 text-[15px] font-semibold text-white hover:bg-teal-700">
          <UserPlus className="h-4 w-4" /> New admission</button>}
      </div>

      {!archive && !old && <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div role="tablist" className="flex flex-wrap gap-1.5">
          {FILTERS.filter((f) => f.key !== 'closed' && f.key !== 'backlog').map((f) => (
            <button key={f.key} type="button" role="tab" aria-selected={filter === f.key && !q}
              onClick={() => { setQ(''); router.replace(f.key === 'open' ? '/master' : `/master?show=${f.key}`, { scroll: false }); }}
              className={`min-h-10 rounded-lg px-3 text-[15px] font-medium ${filter === f.key && !q
                ? (f.key === 'backlog' ? 'bg-amber-600 text-white' : 'bg-slate-900 text-white')
                : f.key === 'backlog' ? 'bg-amber-50 text-amber-900 hover:bg-amber-100' : 'bg-white text-slate-700 ring-1 ring-inset ring-slate-200 hover:bg-slate-50'}`}>
              {f.label} <span className="ml-1 tabular-nums opacity-70">{all ? counts[f.key] : ''}</span>
            </button>
          ))}
        </div>
        <p className="ml-auto hidden items-center gap-4 text-sm text-slate-600 lg:flex">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-amber-500" />Action due</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-sky-500" />Awaiting payer</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-rose-500" />Decision needed</span>
        </p>
      </div>}

      {error && <p role="alert" className="mt-4 rounded-lg bg-rose-50 p-3 text-base text-rose-800">{error}</p>}
      {!all && !error && <div className="flex justify-center py-16"><Loader2 className="h-7 w-7 animate-spin text-teal-600" /></div>}

      {all && shown.length === 0 && (
        <div className="mt-6 rounded-xl border border-dashed border-slate-300 p-10 text-center">
          <p className="text-base text-slate-600">{q ? 'No case matches this search.' : archive ? 'No settled files yet.' : all.length === 0 ? 'No cases yet.' : filter === 'open' ? 'All caught up — no open cases.' : filter === 'backlog' ? 'No pending file from before 1 Nov.' : 'Nothing here right now.'}</p>
          {q && !archive && <Link href={`${old ? '/before/settled' : '/archive'}?q=${encodeURIComponent(q.trim())}`} className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-semibold text-teal-700 hover:bg-teal-50"><Archive className="h-4 w-4" /> {old ? 'Search settled files from before 1 Nov' : 'Search settled files in the Archive'}</Link>}
          {canWrite && !old && all.length === 0 && <button type="button" onClick={() => setAdding(true)} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-lg bg-teal-600 px-4 text-sm font-semibold text-white"><UserPlus className="h-4 w-4" /> Add first admission</button>}
        </div>
      )}

      {all && shown.length > 0 && (
        <div className="mt-3 hidden overflow-x-auto rounded-xl border border-slate-200 bg-white md:block">
          <table ref={table} onKeyDown={moveFocus} className="w-full min-w-[960px] table-fixed border-collapse text-left">
            <colgroup><col className="w-[25%]" /><col className="w-[15%]" /><col className="w-[10%]" /><col className="w-[16%]" /><col className="w-[16%]" /><col className="w-[18%]" /></colgroup>
            <thead className="sticky top-0 z-20 bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                {VIEW_COLUMNS.map((col, k) => {
                  const on = sort?.key === col.key;
                  const Icon = !on ? ChevronsUpDown : sort!.dir === 'asc' ? ArrowUp : ArrowDown;
                  return (
                    <th key={col.key} scope="col" aria-sort={on ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none'} className="border-b border-slate-200 p-0">
                      <button type="button" onClick={() => sortBy(col.key)} title={`Sort by ${SORT_HINT[col.key]}`}
                        className={`flex min-h-11 w-full items-center gap-1.5 ${k === 0 ? 'px-4' : 'px-3.5'} text-left text-xs font-semibold uppercase tracking-wide hover:bg-slate-100 hover:text-slate-800 ${on ? 'text-teal-700' : ''}`}>
                        {col.label} <Icon className={`h-3.5 w-3.5 shrink-0 ${on ? '' : 'text-slate-400'}`} />
                      </button>
                    </th>
                  );
                })}
                <th scope="col" className="border-b border-slate-200 p-0">
                  <button type="button" onClick={() => setSort(null)} title="Back to the reminder order: overdue first"
                    className={`flex min-h-11 w-full items-center gap-1.5 px-3.5 text-left text-xs font-semibold uppercase tracking-wide hover:bg-slate-100 hover:text-slate-800 ${sort ? '' : 'text-teal-700'}`}>
                    {archive ? 'Status' : 'Next action'} {!sort && <ArrowDown className="h-3.5 w-3.5 shrink-0" />}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r: LedgerRow, i) => (
                <tr key={r.j.c.id} className={`border-b border-slate-100 align-top last:border-0 hover:bg-slate-50/60 ${fresh === r.j.c.id ? 'bg-teal-50/60' : ''}`} data-id={r.j.c.id}>
                  <td className="px-1.5 py-1.5" data-key="patient">
                    <CellView strong cell={r.cells.patient} nav={{ row: i, col: 0 }} onOpen={() => setEdit({ id: r.j.c.id, col: 'patient' })} />
                    <div className="truncate px-2.5 pb-1 text-[13px] leading-4 text-slate-500" title={`${doctorLabel(r.j.c.treating_doctor_name) || 'Doctor not set'} · ${r.j.c.clm_payers?.name ?? r.j.c.sponsor_name ?? 'Payer not set'}`}>
                      <span className={r.j.c.treating_doctor_name ? 'text-slate-700' : 'font-medium text-rose-600'}>{doctorLabel(r.j.c.treating_doctor_name) || 'Doctor not set'}</span>
                      {' · '}{r.j.c.clm_payers?.name ?? r.j.c.sponsor_name ?? 'Payer not set'}
                    </div>
                  </td>
                  {VIEW_COLUMNS.slice(1).map((col, k) => (
                    <td key={col.key} className="px-1 py-1.5" data-key={col.key}>
                      <CellView cell={r.view[col.key]} nav={{ row: i, col: k + 1 }} onOpen={() => setEdit({ id: r.j.c.id, col: r.view[col.key].key })} />
                    </td>
                  ))}
                  <td className="px-1 py-1.5"><NextAction r={r} /></td>
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
                <span className="block text-sm text-slate-500">{[r.j.c.admission_ref, doctorLabel(r.j.c.treating_doctor_name) || 'Doctor not set', r.j.c.clm_payers?.name ?? r.j.c.sponsor_name].filter(Boolean).join(' · ')}</span>
              </button>
              <div className="mt-2"><NextAction r={r} /></div>
              <div className="mt-2 grid grid-cols-2 gap-1.5">
                {VIEW_COLUMNS.slice(1).filter((col) => r.view[col.key].state !== 'na').map((col) => (
                  <div key={col.key}>
                    <span className="block px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{col.label}</span>
                    <CellView cell={r.view[col.key]} onOpen={() => setEdit({ id: r.j.c.id, col: r.view[col.key].key })} />
                  </div>
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
      {all && shown.length > 0 && old && <p className="mt-2 text-sm text-slate-500">Files discharged before 1 Nov 2026.</p>}

      {editing && edit && <CellEditor r={editing} col={edit.col} canWrite={canWrite} isManager={isManager} onClose={closeEdit} onSaved={saved} />}
      {adding && <AddPatient tenantId={tenantId} centreId={centreId} doctors={doctors.map(doctorLabel)} onClose={() => setAdding(false)}
        onSaved={async (id) => { setAdding(false); setFresh(id); setQ(''); router.replace('/master', { scroll: false }); flash('Admission added to Master'); await load(); }} />}
    </div>
  );
}
