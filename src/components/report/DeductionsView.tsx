'use client';
// Deductions MIS: what was cut and why — by reason, speciality, procedure, consultant, centre and payer —
// the list of deductions still waiting for a reason, and what disputing got back.
import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import type { DeductionLine } from '@/lib/claims/types';
import type { DisputeMonth } from '@/lib/rcm/summary';
import { REASON_OPTIONS } from '@/lib/engine/settlement';
import { GROUPS, groupLines, inPeriod, linesCsv, reasonPending, type GroupKey, type GroupRow } from '@/lib/rcm/deductions';
import { setDeductionReason } from '@/lib/rcm/api';
import { inr, inrShort, shortDate } from '@/components/ui';
import { Panel, ReportPage, Tile, td, th } from './kit';

const monthName = (k: string) => new Date(`${k}-15T12:00:00+05:30`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
const select = 'min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700';

function GroupTable({ rows, column, byReason }: { rows: GroupRow[]; column: string; byReason: boolean }) {
  const [all, setAll] = useState(false);
  const max = Math.max(1, ...rows.map((r) => r.amount));
  const shown = all ? rows : rows.slice(0, 12);
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const cases = rows.reduce((s, r) => s + r.cases, 0);
  if (!rows.length) return <p className="px-5 pb-5 text-base text-slate-500">No deductions in this period.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse">
        <thead><tr>
          <th className={`${th} pl-5`}>{column}</th><th className={`${th} text-right`}>Deductions</th>
          <th className={`${th} text-right`}>Amount</th><th className={`${th} text-right`}>Share</th><th className={`${th} w-[28%] pr-5`} /></tr></thead>
        <tbody>
          {shown.map((r) => (
            <tr key={r.id}>
              <td className={`${td} pl-5`}><span className="font-medium text-slate-900">{r.label}</span>
                {r.sub && <span className="block max-w-md truncate text-sm text-slate-500" title={r.sub}>{r.sub}</span>}</td>
              <td className={`${td} text-right`}>{r.cases.toLocaleString('en-IN')}</td>
              <td className={`${td} text-right font-semibold`}>{inr(r.amount)}</td>
              <td className={`${td} text-right`}>{Math.round(r.share * 100)}%</td>
              <td className={`${td} pr-5`}><div className="h-3 rounded bg-slate-100">
                <div className={`h-3 rounded ${byReason && r.preventable === 0 ? 'bg-slate-400' : 'bg-rose-500'}`} style={{ width: `${Math.max(2, (100 * r.amount) / max)}%` }} /></div></td>
            </tr>
          ))}
          <tr className="bg-slate-50 font-bold"><td className={`${td} pl-5`}>Total{rows.length > shown.length ? ` (all ${rows.length})` : ''}</td>
            <td className={`${td} text-right`}>{cases.toLocaleString('en-IN')}</td><td className={`${td} text-right`}>{inr(total)}</td>
            <td className={`${td} text-right`}>100%</td><td className={`${td} pr-5`} /></tr>
        </tbody>
      </table>
      {rows.length > 12 && <button type="button" onClick={() => setAll((v) => !v)} className="m-3 min-h-11 rounded-lg px-3 text-sm font-semibold text-teal-700 hover:bg-teal-50 print:hidden">
        {all ? 'Show top 12' : `Show all ${rows.length}`}</button>}
    </div>
  );
}

/** One deduction with no reason yet: pick from the list, or "Other" and write it. */
function ReasonRow({ r, canWrite, onSaved }: { r: DeductionLine; canWrite: boolean; onSaved: () => void }) {
  const [cat, setCat] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    if (!cat) { setError('Select the reason.'); return; }
    if (cat === 'other' && !text.trim()) { setError('Write the reason.'); return; }
    setBusy(true); setError('');
    try { await setDeductionReason({ adjustmentId: r.adjustment_id, claimId: r.claim_id }, cat, text); onSaved(); }
    catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <tr>
      <td className={`${td} pl-5`}><span className="font-medium text-slate-900">{r.patient_name ?? '—'}</span>
        <span className="block text-sm text-slate-500">{r.claim_ref ?? ''}{r.file_date ? ` · ${shortDate(r.file_date)}` : ''}</span></td>
      <td className={td}>{r.speciality}<span className="block max-w-xs truncate text-sm text-slate-500" title={r.procedure_name}>{r.procedure_code !== '—' ? r.procedure_code : r.procedure_name}</span></td>
      <td className={`${td} text-right font-semibold text-rose-700`}>{inr(r.amount)}</td>
      <td className={`${td} pr-5`}>
        {canWrite ? (
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="Deduction reason" value={cat} onChange={(e) => setCat(e.target.value)} className={`${select} max-w-[16rem]`}>
              <option value="">Choose the reason…</option>
              {REASON_OPTIONS.map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <input value={text} onChange={(e) => setText(e.target.value)} aria-label="Remarks" placeholder={cat === 'other' ? 'Write the reason *' : 'Remarks (optional)'}
              className="min-h-11 w-48 rounded-lg border border-slate-300 px-3 text-sm" />
            <button type="button" onClick={save} disabled={busy} className="min-h-11 rounded-lg bg-teal-600 px-4 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50">Save</button>
            {error && <span role="alert" className="text-sm text-rose-700">{error}</span>}
          </div>
        ) : <span className="text-slate-500">Reason not entered</span>}
      </td>
    </tr>
  );
}

export function DeductionsView({ lines, centreId, months, setMonths, disputes, canWrite, onChanged }: {
  lines: DeductionLine[]; centreId: string; months: number; setMonths: (n: number) => void; disputes: DisputeMonth[]; canWrite: boolean; onChanged: () => void;
}) {
  const [by, setBy] = useState<GroupKey>('reason');
  const recent = useMemo(() => inPeriod(lines, months), [lines, months]);
  // centre-wise compares every centre the user can see; every other table is the centre chosen at the top
  const here = useMemo(() => recent.filter((r) => r.centre_id === centreId), [recent, centreId]);
  // cuts being disputed are not lost (yet): shown apart, left out of every total
  const lost = useMemo(() => here.filter((r) => r.kind !== 'fighting'), [here]);
  const fighting = here.filter((r) => r.kind === 'fighting');
  const sum = (xs: DeductionLine[]) => xs.reduce((s, r) => s + r.amount, 0);
  const total = sum(lost);
  const preventable = sum(lost.filter((r) => r.is_preventable));
  const noReason = lost.filter((r) => r.category === 'unspecified');
  const pending = useMemo(() => reasonPending(lines.filter((r) => r.centre_id === centreId)), [lines, centreId]);
  const recovered = disputes.reduce((s, m) => s + m.recovered, 0);
  const g = GROUPS.find((x) => x.key === by)!;
  const rows = useMemo(() => groupLines(by === 'centre' ? recent.filter((r) => r.kind !== 'fighting') : lost, by), [by, recent, lost]);

  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([`﻿${linesCsv(here)}`], { type: 'text/csv;charset=utf-8' }));
    a.download = `ClaimOne Deductions ${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
  };

  return (
    <ReportPage title="Deductions" sub="Money claimed but not paid — approval cuts, short payments and settlement deductions."
      actions={<>
        <select aria-label="Period" value={months} onChange={(e) => setMonths(Number(e.target.value))} className={select}>
          <option value={1}>This month</option><option value={3}>Last 3 months</option><option value={6}>Last 6 months</option>
          <option value={12}>Last 12 months</option><option value={36}>All</option>
        </select>
        <button type="button" onClick={download} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">
          <Download className="h-4 w-4" /> Excel</button>
      </>}>
      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Deducted" value={inrShort(total)} tone={total ? 'text-rose-700' : undefined} sub={`${lost.length.toLocaleString('en-IN')} deductions`} />
        <Tile label="Preventable" value={inrShort(preventable)} sub={total ? `${Math.round((100 * preventable) / total)}% of deducted — fixable at the desk` : undefined} />
        <Tile label="Reason not entered" value={inrShort(sum(noReason))} tone={pending.length ? 'text-amber-700' : undefined}
          sub={pending.length ? `${pending.length} from 1 Nov to complete below` : noReason.length ? 'older files only' : 'all have a reason'} />
        <Tile label="Being disputed" value={inrShort(sum(fighting))} sub={fighting.length ? `${fighting.length} files — left out of Deducted` : recovered ? `${inrShort(recovered)} recovered in 6 months` : undefined} />
      </div>

      {pending.length > 0 && (
        <Panel title={`Enter the reason — ${pending.length} deduction${pending.length === 1 ? '' : 's'} on files from 1 Nov`} flush>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] border-collapse">
              <thead><tr><th className={`${th} pl-5`}>Patient</th><th className={th}>Speciality · procedure</th><th className={`${th} text-right`}>Deducted</th><th className={`${th} pr-5`}>Reason</th></tr></thead>
              <tbody>{pending.map((r) => <ReasonRow key={r.adjustment_id ?? r.claim_id} r={r} canWrite={canWrite} onSaved={onChanged} />)}</tbody>
            </table>
          </div>
        </Panel>
      )}

      <Panel title={`Deductions by ${g.label.toLowerCase()}`} flush
        right={<div className="flex flex-wrap gap-1.5 print:hidden" role="tablist" aria-label="Group deductions by">
          {GROUPS.map((x) => (
            <button key={x.key} type="button" role="tab" aria-selected={by === x.key} onClick={() => setBy(x.key)}
              className={`min-h-10 rounded-full px-3.5 text-sm font-semibold ${by === x.key ? 'bg-teal-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}>{x.label}</button>
          ))}</div>}>
        <GroupTable key={by} rows={rows} column={g.column} byReason={by === 'reason'} />
        {by === 'reason' && <p className="flex flex-wrap items-center gap-4 px-5 pb-4 text-sm text-slate-600">
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-rose-500" /> Preventable at the desk</span>
          <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-slate-400" /> Scheme / policy terms, or reason not entered</span></p>}
      </Panel>

      <Panel title="Accepted, disputed and recovered — last 6 months" flush>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse">
            <thead><tr><th className={`${th} pl-5`}>Month decided</th><th className={`${th} text-right`}>Accepted</th><th className={`${th} text-right`}>Disputed</th><th className={`${th} text-right`}>Won</th><th className={`${th} text-right`}>Recovered</th><th className={`${th} pr-5 text-right`}>Still open</th></tr></thead>
            <tbody>
              {disputes.map((m) => (
                <tr key={m.month}><td className={`${td} pl-5`}>{monthName(m.month)}</td>
                  <td className={`${td} text-right`}>{m.accepted ? `${m.accepted} · ${inr(m.acceptedAmt)}` : '—'}</td>
                  <td className={`${td} text-right`}>{m.disputed ? `${m.disputed} · ${inr(m.disputedAmt)}` : '—'}</td>
                  <td className={`${td} text-right`}>{m.won || '—'}</td>
                  <td className={`${td} text-right font-semibold text-emerald-700`}>{m.recovered ? inr(m.recovered) : '—'}</td>
                  <td className={`${td} pr-5 text-right`}>{m.open || '—'}</td></tr>
              ))}
              <tr className="bg-slate-50 font-bold"><td className={`${td} pl-5`}>6 months</td>
                <td className={`${td} text-right`}>{inr(disputes.reduce((s, m) => s + m.acceptedAmt, 0))}</td>
                <td className={`${td} text-right`}>{inr(disputes.reduce((s, m) => s + m.disputedAmt, 0))}</td>
                <td className={`${td} text-right`}>{disputes.reduce((s, m) => s + m.won, 0)}</td>
                <td className={`${td} text-right text-emerald-700`}>{inr(recovered)}</td>
                <td className={`${td} pr-5 text-right`}>{disputes.reduce((s, m) => s + m.open, 0)}</td></tr>
            </tbody>
          </table>
        </div>
      </Panel>
    </ReportPage>
  );
}
