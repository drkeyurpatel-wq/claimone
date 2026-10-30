'use client';
// The form behind one ledger cell. Every save is a normal status change or
// field edit — the database still checks the move. One cell, one small form.
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Loader2, CheckCircle2, ExternalLink, FileText, MessageSquareWarning } from 'lucide-react';
import type { Claim } from '@/lib/claims/types';
import { transition, updateClaimFields } from '@/lib/claims/api';
import { fetchReceivable, reverse } from '@/lib/recon/api';
import { recordCasePayment, recordEnhancement, istDate, fetchOpenQuery } from '@/lib/rcm/api';
import { LETTERS, LETTER_WAIT_DAYS } from '@/lib/rcm/cut';
import { actionsFor, type CaseAction } from '@/lib/rcm/actions';
import { routeFor } from '@/lib/rcm/payer';
import { COLUMNS, rs, dd, stepColumn, type ColKey, type LedgerRow } from '@/lib/rcm/ledger';
import { DISALLOWANCE_CATEGORIES } from '@/lib/engine/settlement';
import { CutPanel } from '@/components/case/CutPanel';
import { Modal, field, label } from './Modal';

const TONE: Record<CaseAction['tone'], string> = {
  primary: 'bg-teal-600 hover:bg-teal-700 text-white', success: 'bg-emerald-600 hover:bg-emerald-700 text-white',
  warning: 'bg-amber-500 hover:bg-amber-600 text-white', danger: 'bg-rose-600 hover:bg-rose-700 text-white',
  neutral: 'bg-slate-600 hover:bg-slate-700 text-white',
};
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const dayOf = (d: string | null | undefined) => (d ? (d.length === 10 ? d : new Date(d).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })) : '');
const SENT_TO = new Set(['preauth_pending', 'claim_submitted']);

/** The status moves that belong to this cell. */
export function cellActions(col: ColKey, r: LedgerRow): CaseAction[] {
  const { c, step } = r.j;
  const route = routeFor(c.clm_payers, false); // the ledger records what was done; it never sends on NHCX
  return stepColumn(step) === col ? actionsFor(step, c, route) : [];
}

function Err({ text }: { text: string }) {
  return text ? <p role="alert" className="rounded-lg bg-rose-50 p-3 text-base text-rose-800">{text}</p> : null;
}

function SaveRow({ busy, onSave, onCancel, tone = 'bg-teal-600 hover:bg-teal-700 text-white', text = 'Save' }: {
  busy: boolean; onSave: () => void; onCancel: () => void; tone?: string; text?: string;
}) {
  return (
    <div className="flex gap-2 pt-1">
      <button type="button" onClick={onSave} disabled={busy} data-save
        className={`inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl text-base font-bold disabled:opacity-50 ${tone}`}>
        {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <CheckCircle2 className="h-5 w-5" />} {text}
      </button>
      <button type="button" onClick={onCancel} className="min-h-12 rounded-xl bg-slate-100 px-5 text-base font-medium text-slate-700 hover:bg-slate-200">Cancel</button>
    </div>
  );
}

// ─── Status cells: pre-auth sent / decided, claim sent / decided ────
function StatusForm({ r, col, isManager, onClose, onSaved }: {
  r: LedgerRow; col: ColKey; isManager: boolean; onClose: () => void; onSaved: (msg: string) => void;
}) {
  const c = r.j.c;
  const acts = useMemo(() => cellActions(col, r).filter((a) => !a.managerOnly || isManager), [col, r, isManager]);
  const [pick, setPick] = useState<CaseAction | null>(acts.length === 1 ? acts[0] : null);
  const [amount, setAmount] = useState('');
  const [ref, setRef] = useState('');
  const [note, setNote] = useState('');
  const [why, setWhy] = useState('');
  const [day, setDay] = useState(today());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState<{ query_text: string; raised_at: string } | null>(null);
  const answering = r.j.step.key === 'answer_claim_query' || r.j.step.key === 'answer_preauth_query';
  useEffect(() => { if (answering) fetchOpenQuery(c.id).then(setQuery).catch(() => setQuery(null)); }, [answering, c.id]);

  useEffect(() => {
    setAmount(pick?.amount?.value != null ? String(pick.amount.value) : '');
    setRef(pick?.ref?.value ?? ''); setNote(''); setWhy(''); setError('');
  }, [pick]);

  if (!acts.length) return <p className="text-base text-slate-600">No update is due here at this stage.</p>;
  const dated = !!pick && SENT_TO.has(pick.to);

  const save = async () => {
    if (!pick) return;
    if (pick.amount && !(amount !== '' && Number(amount) >= 0)) { setError('Enter the amount.'); return; }
    if (pick.note?.required && !note.trim()) { setError(`Fill in: ${pick.note.label}`); return; }
    if (pick.id === 'part' && !why) { setError('Select the deduction reason.'); return; }
    if (dated && day > today()) { setError('The date cannot be in the future.'); return; }
    setBusy(true); setError('');
    try {
      const fields: Record<string, unknown> = {};
      if (pick.amount) fields[pick.amount.field] = Number(amount);
      if (pick.ref && ref.trim()) fields[pick.ref.field] = ref.trim();
      // the reason heads the note so leakage files it under the right reason
      const fullNote = pick.id === 'part'
        ? `${DISALLOWANCE_CATEGORIES[why as keyof typeof DISALLOWANCE_CATEGORIES].label} — ${note.trim()}`
        : note.trim() || undefined;
      await transition(c.id, pick.to, fields, fullNote);
      const at = dated ? istDate(day) : null;
      // a reply keeps the first submission date; the date typed is the reply date
      if (at) await updateClaimFields(c.id, (pick.id === 'answered' ? { query_replied_at: at }
        : pick.to === 'preauth_pending' ? { preauth_submitted_at: at } : { submitted_at: at }) as Partial<Claim>);
      onSaved(`Updated — ${pick.label}`);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  return (
    <div className="space-y-4">
      {answering && query && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-base text-amber-900">
          <p className="flex items-center gap-1.5 text-sm font-semibold"><MessageSquareWarning className="h-4 w-4" /> Payer's query · raised {dd(query.raised_at)}</p>
          <p className="mt-1 whitespace-pre-wrap">{query.query_text}</p>
        </div>
      )}
      {acts.length > 1 && <p className="text-base font-medium text-slate-800">Select the outcome</p>}
      {acts.length > 1 && (
        <div className="grid grid-cols-2 gap-2">
          {acts.map((a) => (
            <button key={a.id} type="button" onClick={() => setPick(a)} aria-pressed={pick?.id === a.id}
              className={`min-h-12 rounded-xl px-3 text-base font-semibold ${pick?.id === a.id ? TONE[a.tone] : 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50'}`}>
              {a.label}
            </button>
          ))}
        </div>
      )}
      {pick && <>
        {dated && <label className={label}>{pick.id === 'answered' ? 'Reply date' : 'Submission date'}
          <input type="date" value={day} max={today()} onChange={(e) => setDay(e.target.value)} className={field} /></label>}
        {pick.amount && <label className={label}>{pick.amount.label}
          <input type="number" min="0" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={field} /></label>}
        {pick.ref && <label className={label}>{pick.ref.label}
          <input value={ref} onChange={(e) => setRef(e.target.value)} className={field} /></label>}
        {pick.id === 'part' && <label className={label}>Deduction reason *
          <select value={why} onChange={(e) => setWhy(e.target.value)} className={field}>
            <option value="">Select…</option>
            {Object.entries(DISALLOWANCE_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select></label>}
        {pick.note && <label className={label}>{pick.note.label}{pick.note.required ? ' *' : ''}
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} className={`${field} py-2`} /></label>}
        <Err text={error} />
        <SaveRow busy={busy} onSave={save} onCancel={onClose} tone={TONE[pick.tone]} />
      </>}
      {!pick && <button type="button" onClick={onClose} className="min-h-12 w-full rounded-xl bg-slate-100 text-base font-medium text-slate-700">Cancel</button>}
    </div>
  );
}

// ─── Enhancement (first or further) ─────────────────────────────────
function EnhancementForm({ r, onClose, onSaved }: { r: LedgerRow; onClose: () => void; onSaved: (msg: string) => void }) {
  const c = r.j.c;
  const current = Number(c.preauth_approved_amount ?? c.approved_amount ?? 0);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    const n = Number(amount);
    if (!(n > 0)) { setError('Enter the revised approved amount.'); return; }
    if (n <= current) { setError(`The revised amount must be above the current approval of ${rs(current)}.`); return; }
    setBusy(true); setError('');
    try {
      if (c.status === 'preauth_approved') await transition(c.id, 'preauth_enhanced', { approved_amount: n }, note.trim() || undefined);
      else await recordEnhancement(c.id, n, note.trim());
      onSaved(`Enhancement recorded — approval now ${rs(n)}`);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <div className="space-y-4">
      <p className="text-base text-slate-700">Current approval: <b>{rs(current)}</b></p>
      <label className={label}>Revised approved amount (₹) *
        <input type="number" min="0" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={field} /></label>
      <label className={label}>Remarks
        <input value={note} onChange={(e) => setNote(e.target.value)} className={field} placeholder="e.g. ICU stay extended" /></label>
      <Err text={error} />
      <SaveRow busy={busy} onSave={save} onCancel={onClose} />
    </div>
  );
}

// ─── Discharge date ─────────────────────────────────────────────────
function DischargeForm({ r, onClose, onSaved }: { r: LedgerRow; onClose: () => void; onSaved: (msg: string) => void }) {
  const c = r.j.c;
  const admitted = dayOf(c.admitted_at ?? c.admission_date);
  const [day, setDay] = useState(dayOf(c.discharged_at ?? c.discharge_date) || today());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    if (!day) { setError('Enter the discharge date.'); return; }
    if (day > today()) { setError('The date cannot be in the future.'); return; }
    if (admitted && day < admitted) { setError('Discharge date cannot be before the admission date.'); return; }
    setBusy(true); setError('');
    try {
      await updateClaimFields(c.id, { discharged_at: istDate(day) ?? new Date().toISOString(), discharge_date: day } as Partial<Claim>);
      onSaved('Discharge date updated');
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <div className="space-y-4">
      <label className={label}>Discharge date
        <input type="date" value={day} min={admitted || undefined} max={today()} onChange={(e) => setDay(e.target.value)} className={field} /></label>
      <Err text={error} />
      <SaveRow busy={busy} onSave={save} onCancel={onClose} />
    </div>
  );
}

// ─── Money received ─────────────────────────────────────────────────
type Pay = Awaited<ReturnType<typeof fetchReceivable>>;
function PaymentForm({ r, canWrite, onClose, onSaved }: { r: LedgerRow; canWrite: boolean; onClose: () => void; onSaved: (msg: string) => void }) {
  const { c, money: m } = r.j;
  const outstanding = m ? Math.max(0, Math.round(m.balance * 100) / 100) : 0;
  const [pay, setPay] = useState<Pay | null>(null);
  const [tds, setTds] = useState('');
  const [net, setNet] = useState(outstanding > 0 ? String(Math.round(outstanding)) : '');
  const [netTouched, setNetTouched] = useState(false);
  const [utr, setUtr] = useState('');
  const [day, setDay] = useState(today());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [undo, setUndo] = useState<string | null>(null);
  useEffect(() => { if (m) fetchReceivable(m.receivable_id).then(setPay).catch(() => setPay(null)); }, [m]);

  // the payer pays the approved amount less TDS: net follows TDS until the desk types its own figure
  const onTds = (v: string) => {
    setTds(v);
    if (!netTouched && outstanding > 0) setNet(String(Math.max(0, Math.round((outstanding - (Number(v) || 0)) * 100) / 100)));
  };
  const n = Number(net) || 0, t = Number(tds) || 0;
  const over = outstanding > 0 && n + t > outstanding + 1;

  const save = async () => {
    if (!(n > 0)) { setError('Enter the net amount received.'); return; }
    if (t < 0) { setError('TDS cannot be negative.'); return; }
    if (day > today()) { setError('The date cannot be in the future.'); return; }
    if (over) {
      setError(`Net + TDS (${rs(n + t)}) is more than the outstanding ${rs(outstanding)}. The net received is normally the approved amount less TDS — ${rs(outstanding - t)}.`);
      return;
    }
    if (utr.trim().length < 4) { setError('Enter the UTR / reference no. — it stops the same payment being counted twice when the statement is uploaded.'); return; }
    setBusy(true); setError('');
    try {
      await recordCasePayment(c.id, { net: n, tds: t, utr, date: day });
      onSaved('Settlement recorded');
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  // undo a wrong entry: the payment and its TDS line are reversed (kept on record)
  const reverseEntry = async (allocId: string, remId: string | null) => {
    setBusy(true); setError('');
    try {
      await reverse(allocId, 'Entered by mistake — corrected on Master', 'allocation');
      const tdsLines = (pay?.adjustments ?? []).filter((a) => !a.reversed_at && a.kind === 'tds' && remId && (a as { remittance_line_id?: string }).remittance_line_id === remId);
      for (const a of tdsLines) await reverse(a.id, 'Entered by mistake — corrected on Master', 'adjustment');
      onSaved('Payment entry reversed — enter the correct figures');
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };

  const done = (pay?.allocations ?? []).filter((a) => !a.reversed_at);
  const excess = m && m.balance < -1 ? -m.balance : 0;
  return (
    <div className="space-y-4">
      {m && <dl className="grid grid-cols-3 gap-2 text-center">
        {[['Approved', m.expected_amount], ['Received incl. TDS', m.allocated + m.tds], [excess ? 'Excess' : 'Outstanding', excess || m.balance]].map(([k, v]) => (
          <div key={k as string} className={`rounded-xl p-2 ${k === 'Excess' ? 'bg-rose-50' : 'bg-slate-50'}`}><dt className="text-sm text-slate-500">{k}</dt><dd className={`text-base font-bold ${k === 'Excess' ? 'text-rose-700' : 'text-slate-900'}`}>{rs(v as number)}</dd></div>
        ))}
      </dl>}
      {excess > 0 && <p className="rounded-lg bg-rose-50 p-3 text-sm text-rose-800">More has been recorded than approved. If an entry was wrong, reverse it below and enter the correct figures.</p>}
      {done.length > 0 && <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 text-sm">
        {done.map((a) => {
          const remId = (a as { remittance_line_id?: string | null }).remittance_line_id ?? null;
          const tdsOf = (pay?.adjustments ?? []).filter((x) => !x.reversed_at && x.kind === 'tds' && remId && (x as { remittance_line_id?: string }).remittance_line_id === remId)
            .reduce((s, x) => s + Number(x.amount), 0);
          return (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 p-2.5">
              <span>{dd(a.clm_receipts?.value_date)}{a.clm_receipts?.reference ? ` · UTR ${a.clm_receipts.reference}` : ''}{tdsOf ? ` · TDS ${rs(tdsOf)}` : ''}</span>
              <span className="flex items-center gap-3"><b>{rs(a.amount)}</b>
                {canWrite && (undo === a.id
                  ? <span className="flex gap-1"><button type="button" onClick={() => reverseEntry(a.id, remId)} disabled={busy} className="rounded-lg bg-rose-600 px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50">Confirm reverse</button>
                      <button type="button" onClick={() => setUndo(null)} className="rounded-lg bg-slate-100 px-2.5 py-1 text-xs">Keep</button></span>
                  : <button type="button" onClick={() => setUndo(a.id)} className="text-xs font-medium text-rose-700 underline">Reverse entry</button>)}
              </span>
            </li>
          );
        })}
      </ul>}
      {outstanding > 0 && <>
        <div className="grid grid-cols-2 gap-3">
          <label className={label}>TDS deducted (₹)
            <input type="number" min="0" inputMode="decimal" value={tds} onChange={(e) => onTds(e.target.value)} className={field} placeholder="0" /></label>
          <label className={label}>Net amount received (₹) *
            <input type="number" min="0" inputMode="decimal" value={net} onChange={(e) => { setNet(e.target.value); setNetTouched(true); }} className={`${field} ${over ? 'border-rose-400' : ''}`} /></label>
        </div>
        <p className={`text-sm ${over ? 'font-semibold text-rose-700' : 'text-slate-500'}`}>Net + TDS = {rs(n + t)} against {rs(outstanding)} outstanding.</p>
        <div className="grid grid-cols-2 gap-3">
          <label className={label}>UTR / reference no. *
            <input value={utr} onChange={(e) => setUtr(e.target.value)} className={field} autoComplete="off" /></label>
          <label className={label}>Credit date
            <input type="date" value={day} max={today()} onChange={(e) => setDay(e.target.value)} className={field} /></label>
        </div>
        <p className="text-sm text-slate-500">Any shortfall against the claim appears under Deduction, to accept or dispute.</p>
      </>}
      <Err text={error} />
      {outstanding > 0 ? <SaveRow busy={busy} onSave={save} onCancel={onClose} />
        : <button type="button" onClick={onClose} className="min-h-12 w-full rounded-xl bg-slate-100 text-base font-medium text-slate-700">Close</button>}
    </div>
  );
}

// ─── The cut: accept or fight ───────────────────────────────────────
function CutForm({ r, canWrite, onPay, onSaved }: { r: LedgerRow; canWrite: boolean; onPay: () => void; onSaved: (msg: string) => void }) {
  const { c, money: m } = r.j;
  const [pay, setPay] = useState<Pay | null>(null);
  useEffect(() => { if (m) fetchReceivable(m.receivable_id).then(setPay).catch(() => setPay(null)); }, [m]);
  const reason = pay?.adjustments.filter((a) => a.kind === 'deduction').map((a) => a.reason_text
    ?? (a.category ? DISALLOWANCE_CATEGORIES[a.category as keyof typeof DISALLOWANCE_CATEGORIES]?.label ?? a.category : null)).pop() ?? null;
  const hasDeduction = !!pay?.adjustments.some((a) => a.kind === 'deduction' && !a.reversed_at);
  return (
    <div>
      <CutPanel c={c} cut={r.cut} canWrite={canWrite} reason={reason}
        shortfall={m && m.allocated > 0 && !hasDeduction ? m.balance : 0} onDone={onSaved} />
      {r.cut.state === 'fought' && r.cut.amount >= 1 && (
        <div className="mt-4 rounded-xl border border-slate-200 p-3">
          <p className="text-base font-semibold text-slate-900">Dispute letters</p>
          <p className="mt-0.5 text-sm text-slate-600">
            {r.cut.letter ? `${LETTERS[r.cut.letter.level]?.short} sent ${dd(r.cut.letter.sentAt)} — next step after ${LETTER_WAIT_DAYS[r.cut.letter.level]} days without a reply.`
              : 'Send the reconsideration letter first. Escalate if there is no reply in 15 days.'}
          </p>
          <div className="mt-2 grid gap-2">
            {[1, 2, 3].map((lv) => {
              const sent = (r.cut.letter?.level ?? 0) >= lv;
              const nextLv = (r.cut.letter?.level ?? 0) + 1 === lv;
              return (
                <Link key={lv} href={`/letter/${c.id}?level=${lv}`}
                  className={`flex min-h-12 items-center gap-2 rounded-xl px-3 text-base font-medium ${nextLv ? 'bg-teal-600 text-white hover:bg-teal-700' : 'border border-slate-200 text-slate-700 hover:bg-slate-50'}`}>
                  <FileText className="h-4 w-4" /> {lv}. {LETTERS[lv].title}{sent ? ' · sent' : ''}
                </Link>
              );
            })}
          </div>
        </div>
      )}
      {r.cut.state === 'fought' && canWrite && c.status !== 'settled' && (
        <button type="button" onClick={onPay} className="mt-3 min-h-12 w-full rounded-xl border border-teal-600 bg-white text-base font-semibold text-teal-700 hover:bg-teal-50">
          Record recovery payment
        </button>
      )}
    </div>
  );
}

// ─── Patient details ────────────────────────────────────────────────
function PatientForm({ r, canWrite, onClose, onSaved }: { r: LedgerRow; canWrite: boolean; onClose: () => void; onSaved: (msg: string) => void }) {
  const c = r.j.c;
  const [f, setF] = useState({
    patient_name: c.patient_name ?? '', admission_ref: c.admission_ref ?? '', patient_uhid: c.patient_uhid ?? '',
    admitted: dayOf(c.admitted_at ?? c.admission_date), estimated_amount: c.estimated_amount != null ? String(c.estimated_amount) : '',
    treating_doctor_name: c.treating_doctor_name ?? '', patient_phone: c.patient_phone ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  const save = async () => {
    if (!f.patient_name.trim()) { setError('Enter the patient name.'); return; }
    if (!f.admission_ref.trim()) { setError('Enter the IP number.'); return; }
    if (f.admitted && f.admitted > today()) { setError('Admission date cannot be in the future.'); return; }
    setBusy(true); setError('');
    try {
      const was = dayOf(c.admitted_at ?? c.admission_date);
      await updateClaimFields(c.id, {
        patient_name: f.patient_name.trim(), admission_ref: f.admission_ref.trim(), patient_uhid: f.patient_uhid.trim() || null,
        estimated_amount: f.estimated_amount === '' ? null : Number(f.estimated_amount),
        treating_doctor_name: f.treating_doctor_name.trim() || null, patient_phone: f.patient_phone.trim() || null,
        ...(f.admitted && f.admitted !== was ? { admission_date: f.admitted, admitted_at: new Date(`${f.admitted}T12:00:00+05:30`).toISOString() } : {}),
      } as Partial<Claim>);
      onSaved('Patient details updated');
    } catch (e) {
      const m = (e as Error).message;
      setError(/admission_uq|duplicate/i.test(m) ? 'This IP number already belongs to another patient.' : m);
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <p className="text-base text-slate-700">Payer: <b>{c.clm_payers?.name ?? c.sponsor_name ?? '—'}</b></p>
      {canWrite ? <>
        <label className={label}>Patient name *<input value={f.patient_name} onChange={set('patient_name')} className={field} autoComplete="off" /></label>
        <div className="grid grid-cols-2 gap-3">
          <label className={label}>IP number *<input value={f.admission_ref} onChange={set('admission_ref')} className={field} /></label>
          <label className={label}>UHID<input value={f.patient_uhid} onChange={set('patient_uhid')} className={field} /></label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className={label}>Admission date<input type="date" value={f.admitted} max={today()} onChange={set('admitted')} className={field} /></label>
          <label className={label}>Estimated amount (₹)<input type="number" min="0" inputMode="numeric" value={f.estimated_amount} onChange={set('estimated_amount')} className={field} /></label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className={label}>Treating doctor<input value={f.treating_doctor_name} onChange={set('treating_doctor_name')} className={field} /></label>
          <label className={label}>Mobile<input type="tel" value={f.patient_phone} onChange={set('patient_phone')} className={field} /></label>
        </div>
        <Err text={error} />
        <SaveRow busy={busy} onSave={save} onCancel={onClose} />
      </> : <p className="text-base text-slate-600">{[c.admission_ref, c.patient_uhid, dd(c.admitted_at ?? c.admission_date)].filter(Boolean).join(' · ')}</p>}
      <Link href={`/case/${c.id}`} className="flex min-h-12 items-center justify-center gap-2 rounded-xl border border-slate-200 text-base font-medium text-slate-700 hover:bg-slate-50">
        <ExternalLink className="h-4 w-4" /> Open full case file (documents & history)
      </Link>
    </div>
  );
}

export function CellEditor({ r, col, canWrite, isManager, onClose, onSaved }: {
  r: LedgerRow; col: ColKey; canWrite: boolean; isManager: boolean; onClose: () => void; onSaved: (msg: string) => void;
}) {
  const [view, setView] = useState<ColKey>(col);
  const c = r.j.c;
  // once the pre-auth is approved, this cell records enhancements
  const enhance = view === 'pa_ok' && (c.status === 'preauth_approved' || c.status === 'preauth_enhanced');
  const title = view === 'patient' ? c.patient_name : view === 'cut' ? 'Deduction' : enhance ? 'Enhancement' : COLUMNS.find((x) => x.key === view)!.label;
  const sub = view === 'patient' ? (c.clm_payers?.name ?? undefined) : `${c.patient_name}${c.admission_ref ? ` · ${c.admission_ref}` : ''} · ${c.clm_payers?.name ?? ''}`;
  return (
    <Modal title={title} sub={sub} onClose={onClose}>
      {view === 'patient' && <PatientForm r={r} canWrite={canWrite} onClose={onClose} onSaved={onSaved} />}
      {enhance && <EnhancementForm r={r} onClose={onClose} onSaved={onSaved} />}
      {(view === 'pa_sent' || (view === 'pa_ok' && !enhance) || view === 'cl_sent' || view === 'cl_ok') &&
        <StatusForm r={r} col={view} isManager={isManager} onClose={onClose} onSaved={onSaved} />}
      {view === 'disch' && <DischargeForm r={r} onClose={onClose} onSaved={onSaved} />}
      {view === 'paid' && <PaymentForm r={r} canWrite={canWrite} onClose={onClose} onSaved={onSaved} />}
      {view === 'cut' && <CutForm r={r} canWrite={canWrite} onPay={() => setView('paid')} onSaved={onSaved} />}
    </Modal>
  );
}
