'use client';
// One patient's file, on one screen, from pre-auth to money reconciled.
// The stage row is the file's journey: it opens on where the file is now;
// tap any stage to see what happened there or what will be needed.
// Every button is a normal status change — the database checks the move and the papers.
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Loader2, ArrowLeft, CheckCircle2, AlertTriangle, Inbox, Send, History } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import { useClaimsStore } from '@/lib/claims/store';
import { transition, updateClaimFields, fetchClaimTimeline } from '@/lib/claims/api';
import { addAdjustment, setDisputed, fetchReceivable } from '@/lib/recon/api';
import { sb } from '@/lib/supabase/browser';
import { fetchCase, fetchMoneyFor, fetchNhcxMessages, markNhcxHandled, paymentStep, type NhcxMessage } from '@/lib/rcm/api';
import { nextStep, dueText } from '@/lib/rcm/worklist';
import { STAGES, stageOf, stageStates, type CaseMoney, type StageKey } from '@/lib/rcm/journey';
import { actionsFor, type CaseAction } from '@/lib/rcm/actions';
import { routeFor, ROUTE_WORDS } from '@/lib/rcm/payer';
import { DISALLOWANCE_CATEGORIES } from '@/lib/engine/settlement';
import type { Claim, TimelineEvent } from '@/lib/claims/types';
import { ReadinessPanel } from '@/components/claim/ReadinessPanel';
import { NhcxDetails } from '@/components/case/NhcxDetails';
import { StageTracker } from '@/components/case/StageTracker';
import { inr, shortDate, dateTime, useToast } from '@/components/ui';

const TONE: Record<CaseAction['tone'], string> = {
  primary: 'bg-teal-600 hover:bg-teal-700 text-white', success: 'bg-emerald-600 hover:bg-emerald-700 text-white',
  warning: 'bg-amber-500 hover:bg-amber-600 text-white', danger: 'bg-rose-600 hover:bg-rose-700 text-white',
  neutral: 'bg-slate-600 hover:bg-slate-700 text-white',
};
const field = 'mt-1 min-h-12 w-full rounded-lg border border-slate-300 px-3 text-base focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100';
const money = (n: number | null | undefined) => (n == null ? '—' : inr(Number(n)));

function Facts({ rows }: { rows: [string, React.ReactNode][] }) {
  const shown = rows.filter(([, v]) => v != null && v !== '' && v !== '—');
  if (!shown.length) return null;
  return (
    <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
      {shown.map(([k, v]) => (
        <div key={k} className="rounded-xl bg-slate-50 p-3"><dt className="text-sm text-slate-500">{k}</dt><dd className="text-base font-semibold text-slate-900">{v}</dd></div>
      ))}
    </dl>
  );
}

function replyWords(m: NhcxMessage): string {
  const s = m.summary as { outcome?: string; approved_amount?: number; message?: string };
  const what = m.api_call === 'preauth' ? 'Pre-auth' : m.api_call === 'claim' ? 'Claim' : m.api_call === 'communication' ? 'Query' : 'Reply';
  return `${what}: ${s.outcome ?? 'received'}${s.approved_amount != null ? ` · ${inr(Number(s.approved_amount))}` : ''}${s.message ? ` — ${s.message}` : ''}`;
}

/** Which stage an action belongs to, so its buttons sit on the right tab. */
const STAGE_OF_STEP: Record<string, StageKey> = {
  send_preauth: 'preauth', wait_preauth: 'preauth', answer_preauth_query: 'preauth', preauth_rejected: 'preauth',
  in_hospital_approved: 'stay', send_claim: 'discharge', wait_claim: 'claim', answer_claim_query: 'claim', claim_rejected: 'claim', wait_payment: 'payment',
};

export default function CasePage() {
  const { id } = useParams<{ id: string }>();
  const role = useAuthStore((s) => s.staff?.role);
  const centreId = useAuthStore((s) => s.activeCentreId);
  const canWrite = role === 'admin' || role === 'manager' || role === 'desk';
  const isManager = role === 'admin' || role === 'manager';
  const { activeDocuments, activeRules, activeClaim, loadClaimDetail } = useClaimsStore();
  const { flash, toastNode } = useToast();

  const [c, setC] = useState<Claim | null | undefined>(undefined);
  const [m, setM] = useState<CaseMoney | null>(null);
  const [pay, setPay] = useState<Awaited<ReturnType<typeof fetchReceivable>> | null>(null);
  const [msgs, setMsgs] = useState<NhcxMessage[]>([]);
  const [history, setHistory] = useState<TimelineEvent[]>([]);
  const [centreOnNhcx, setCentreOnNhcx] = useState(false);
  const [view, setView] = useState<StageKey | null>(null);
  const [open, setOpen] = useState<CaseAction | null>(null);
  const [amount, setAmount] = useState('');
  const [ref, setRef] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [blockers, setBlockers] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [discharge, setDischarge] = useState('');
  const [why, setWhy] = useState({ cat: '', text: '' });
  const [cutWhy, setCutWhy] = useState('');

  const reload = useCallback(async () => {
    const [x, mm, msg, hist] = await Promise.all([fetchCase(id), fetchMoneyFor(id), fetchNhcxMessages(id), fetchClaimTimeline(id), loadClaimDetail(id)]);
    setC(x); setM(mm); setMsgs(msg); setHistory(hist);
    setPay(mm ? await fetchReceivable(mm.receivable_id) : null);
  }, [id, loadClaimDetail]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    if (!centreId) return;
    sb().from('clm_centres').select('nhcx_participant_code').eq('id', centreId).maybeSingle()
      .then(({ data }: { data: { nhcx_participant_code: string | null } | null }) => setCentreOnNhcx(!!data?.nhcx_participant_code));
  }, [centreId]);

  const raw = useMemo(() => (c ? nextStep(c) : null), [c]);
  const stage = c && raw ? stageOf(c, m, raw) : 'preauth';
  const step = raw ? paymentStep(raw, stage, m) : null;
  const shown = view ?? stage;
  const states = c ? stageStates(c, stage) : null;
  const route = routeFor(c?.clm_payers, centreOnNhcx);
  const actions = useMemo(() => (c && raw ? actionsFor(raw, c, route).filter((a) => !a.managerOnly || isManager) : []), [c, raw, route, isManager]);
  const actionStage = raw ? STAGE_OF_STEP[raw.key] : undefined;
  // a reply belongs to the stage it answers; once used or seen it is gone
  const replyStages: Record<string, StageKey[]> = { preauth: ['preauth', 'stay'], claim: ['claim'], communication: ['preauth', 'stay', 'claim'] };
  const replies = msgs.filter((x) => x.direction === 'in' && x.status === 'received' && (replyStages[x.api_call] ?? []).includes(actionStage ?? 'closed'));
  const [fromReply, setFromReply] = useState<string | null>(null);

  const start = (a: CaseAction, prefill?: { amount?: number; ref?: string; note?: string }) => {
    if (!prefill) setFromReply(null);
    setOpen(a); setBlockers([]); setError('');
    setAmount(String(prefill?.amount ?? a.amount?.value ?? ''));
    setRef(prefill?.ref ?? a.ref?.value ?? ''); setNote(prefill?.note ?? '');
  };

  const run = async () => {
    if (!c || !open) return;
    if (open.amount && (amount === '' || !(Number(amount) >= 0))) { setError('Enter the amount.'); return; }
    if (open.note?.required && !note.trim()) { setError(`Fill in: ${open.note.label}`); return; }
    if (open.id === 'part' && !cutWhy) { setError('Pick the reason for the cut.'); return; }
    // the reason heads the note so leakage files it under the right reason
    const fullNote = open.id === 'part' ? `${DISALLOWANCE_CATEGORIES[cutWhy as keyof typeof DISALLOWANCE_CATEGORIES].label} — ${note.trim()}` : note.trim();
    setBusy(true); setError(''); setBlockers([]);
    try {
      if (open.nhcx) {
        const res = await fetch('/api/nhcx/send', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ claimId: c.id, kind: open.nhcx, amount: open.amount ? Number(amount) : undefined, note: note.trim() || undefined }) });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) { setBlockers(j.blockers ?? []); throw new Error(j.error || 'NHCX send failed'); }
      } else {
        const fields: Record<string, unknown> = {};
        if (open.amount) fields[open.amount.field] = Number(amount);
        if (open.ref && ref.trim()) fields[open.ref.field] = ref.trim();
        await transition(c.id, open.to, fields, fullNote || (open.ref ? `Sent via ${ROUTE_WORDS[route].label}` : undefined));
      }
      if (fromReply) await markNhcxHandled(fromReply, 'applied').catch(() => {});
      setFromReply(null); setOpen(null); setView(null); flash('Saved'); await reload();
    } catch (e) {
      const err = e as Error & { blockers?: string[] };
      if (err.blockers?.length) setBlockers(err.blockers);
      setError(err.message);
    }
    setBusy(false);
  };

  const applyReply = (x: NhcxMessage) => {
    const s = x.summary as { outcome?: string; approved_amount?: number; reference?: string; message?: string };
    const o = s.outcome ?? '';
    const want = /partial/i.test(o) ? ['part', 'approved', 'enhanced'] : /approv/i.test(o) ? ['approved', 'full', 'enhanced'] : /quer/i.test(o) ? ['query'] : /reject/i.test(o) ? ['rejected'] : [];
    const a = actions.find((y) => want.includes(y.id));
    if (a) { setView(actionStage ?? null); start(a, { amount: s.approved_amount, ref: s.reference, note: s.message }); setFromReply(x.id); }
    else flash('Nothing to apply for this reply — mark it as seen.', 'err');
  };

  const saveDischarge = async () => {
    if (!c || !discharge) return;
    try {
      const d = new Date(discharge);
      // the date as typed (IST), not the UTC date
      await updateClaimFields(c.id, { discharged_at: d.toISOString(), discharge_date: discharge.slice(0, 10) } as Partial<Claim>);
      flash('Discharge saved'); setDischarge(''); setView(null); await reload();
    } catch { flash('Could not save the discharge date', 'err'); }
  };

  const payAction = async (kind: 'reason' | 'small' | 'dispute') => {
    if (!m) return;
    setBusy(true); setError('');
    try {
      if (kind === 'reason') {
        if (!why.cat || !why.text.trim()) throw new Error('Pick the reason and write what the letter says.');
        await addAdjustment(m.receivable_id, { kind: 'deduction', amount: Math.round(m.balance * 100) / 100, category: why.cat, reason_text: why.text.trim() });
      } else if (kind === 'small') {
        await addAdjustment(m.receivable_id, { kind: 'rounding', amount: Math.round(m.balance * 100) / 100, reason_text: 'Small difference closed' });
      } else {
        if (!why.text.trim()) throw new Error('Write why you are disputing it.');
        await setDisputed(m.receivable_id, why.text.trim());
      }
      setWhy({ cat: '', text: '' }); flash('Saved'); await reload();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  if (c === undefined) return <div className="flex min-h-[60vh] items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-teal-600" /></div>;
  if (!c || !step || !states) return <div className="py-20 text-center text-base text-slate-500">Patient not found, or not at your centre. <Link href="/patients" className="text-teal-700 underline">Back</Link></div>;

  const due = dueText(step);
  const st = states[shown];
  const info = STAGES.find((s) => s.key === shown)!;
  const isNow = shown === stage && stage !== 'closed';
  const claimed = c.claimed_amount ?? c.bill_amount;
  const cut = claimed != null && c.approved_amount != null && Number(claimed) > Number(c.approved_amount) ? Number(claimed) - Number(c.approved_amount) : null;

  const actionCard = canWrite && actionStage === shown && actions.length > 0 && (
    <div className="mt-4">
      {!open && <div className="flex flex-wrap gap-2">
        {actions.map((a) => (
          <button key={a.id} onClick={() => start(a)} className={`inline-flex min-h-12 items-center gap-2 rounded-xl px-5 text-base font-semibold ${TONE[a.tone]}`}>
            {a.nhcx && <Send className="h-4 w-4" />} {a.label}
          </button>
        ))}
      </div>}
      {open && (
        <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-lg font-semibold text-slate-900">{open.label}</p>
          {open.amount && <label className="block text-base font-medium text-slate-800">{open.amount.label}
            <input type="number" min="0" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={field} autoFocus /></label>}
          {open.ref && <label className="block text-base font-medium text-slate-800">{open.ref.label}
            <input value={ref} onChange={(e) => setRef(e.target.value)} className={field} /></label>}
          {open.id === 'part' && <label className="block text-base font-medium text-slate-800">Reason for the cut *
            <select value={cutWhy} onChange={(e) => setCutWhy(e.target.value)} className={field}>
              <option value="">Choose…</option>
              {Object.entries(DISALLOWANCE_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select></label>}
          {open.note && <label className="block text-base font-medium text-slate-800">{open.note.label}{open.note.required ? ' *' : ''}
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} className={`${field} py-2`} /></label>}
          {error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-base text-rose-800">{error}</p>}
          {blockers.length > 0 && <div className="rounded-lg bg-amber-50 p-3 text-base text-amber-900">
            <p className="font-semibold">Needed first — fill these in below:</p>
            <ul className="mt-1 list-disc pl-5">{blockers.map((b) => <li key={b}>{b}</li>)}</ul></div>}
          <div className="flex gap-2">
            <button onClick={run} disabled={busy} className={`inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl text-base font-bold ${TONE[open.tone]} disabled:opacity-50`}>
              {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <CheckCircle2 className="h-5 w-5" />} Save</button>
            <button onClick={() => setOpen(null)} className="min-h-12 rounded-xl bg-slate-100 px-5 text-base font-medium text-slate-700 hover:bg-slate-200">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 md:px-6">
      {toastNode}
      <Link href={`/patients?stage=${stage}`} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Patients</Link>

      {/* The file cover */}
      <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{c.patient_name}</h1>
          <p className="mt-1 text-base text-slate-600">
            {c.admission_ref ?? 'No IP No.'}{c.patient_uhid ? ` · ${c.patient_uhid}` : ''} · <b>{c.clm_payers?.name}</b>
            <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-sm text-slate-600">{ROUTE_WORDS[route].label}</span>
          </p>
          <p className="mt-1 text-sm text-slate-500">
            Admitted {shortDate(c.admitted_at ?? c.admission_date)}{c.discharged_at || c.discharge_date ? ` · Discharged ${shortDate(c.discharged_at ?? c.discharge_date)}` : ' · In hospital'}
            {c.treating_doctor_name ? ` · ${c.treating_doctor_name}` : ''}
          </p>
        </div>
        {stage !== 'closed' && (
          <div className={`rounded-xl px-4 py-2 text-right ${step.overdue ? 'bg-rose-50 text-rose-800' : step.ours ? 'bg-amber-50 text-amber-900' : 'bg-slate-100 text-slate-700'}`}>
            <p className="text-sm">{step.ours ? 'Your turn' : 'Waiting on insurer'}</p>
            <p className="text-base font-semibold">{step.label}</p>
            {due && <p className="text-sm">{step.overdue ? `Late — ${due}` : `Due ${due}`}</p>}
          </div>
        )}
      </div>

      {/* The journey */}
      <div className="mt-5 rounded-2xl bg-slate-100 p-2">
        <StageTracker states={states} selected={shown} onSelect={(k) => { setView(k); setOpen(null); setError(''); }} late={step.overdue} />
      </div>

      {/* The selected stage */}
      <section className={`mt-4 rounded-2xl border-2 p-5 ${isNow ? (step.overdue ? 'border-rose-300 bg-rose-50/40' : 'border-teal-300 bg-teal-50/40') : 'border-slate-200 bg-white'}`}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-xl font-bold text-slate-900">{STAGES.indexOf(info) + 1}. {info.label}</h2>
          <span className={`rounded-full px-3 py-1 text-sm font-semibold ${st === 'done' ? 'bg-teal-100 text-teal-800' : st === 'current' ? 'bg-amber-100 text-amber-900' : 'bg-slate-100 text-slate-500'}`}>
            {st === 'done' ? 'Done' : st === 'current' ? 'Now' : st === 'skipped' ? 'Not needed' : 'Later'}
          </span>
        </div>
        <p className="mt-1 text-base text-slate-600">{info.hint}</p>

        {shown === 'preauth' && <Facts rows={[
          ['Estimate', money(c.estimated_amount)], ['Sent on', c.preauth_submitted_at ? dateTime(c.preauth_submitted_at) : '—'],
          ['Pre-auth no.', c.tpa_preauth_number ?? '—'], ['Approved', c.approved_amount != null ? money(c.approved_amount) : '—'],
        ]} />}
        {shown === 'stay' && <Facts rows={[
          ['Estimate', money(c.estimated_amount)], ['Approved so far', c.approved_amount != null ? money(c.approved_amount) : '—'],
          ['Room', c.bed_category ?? '—'],
        ]} />}
        {shown === 'discharge' && <Facts rows={[
          ['Discharged', c.discharged_at ? dateTime(c.discharged_at) : c.discharge_date ? shortDate(c.discharge_date) : '—'], ['Bill no.', c.bill_no ?? '—'],
          ['Bill', money(c.bill_amount)], ['Discount', c.discount_amount ? money(c.discount_amount) : '—'], ['Paid by patient', c.patient_paid ? money(c.patient_paid) : '—'],
          ['To claim', money(claimed)],
        ]} />}
        {shown === 'claim' && <Facts rows={[
          ['Sent on', c.submitted_at ? dateTime(c.submitted_at) : '—'], ['Claim no.', c.tpa_claim_number ?? '—'], ['Claimed', money(claimed)],
          ['Approved', c.approved_amount != null ? money(c.approved_amount) : '—'], ['Cut at approval', cut ? money(cut) : '—'],
        ]} />}
        {(shown === 'payment' || shown === 'closed') && m && <Facts rows={[
          ['Owed', money(m.expected_amount)], ['Received', money(m.allocated)], ['TDS', m.tds ? money(m.tds) : '—'],
          ['Deductions', m.deduction ? money(m.deduction) : '—'], ['Still due', money(m.balance)],
        ]} />}
        {shown === 'payment' && !m && <p className="mt-4 text-base text-slate-700">No bill on the money list yet. It appears when the eCW file with the bill is uploaded, or when the claim is approved.</p>}

        {actionCard}

        {/* In hospital: discharge by hand for patients not in eCW */}
        {shown === 'stay' && isNow && canWrite && c.case_source !== 'ecw' && (
          <div className="mt-4 flex flex-wrap items-end gap-2">
            <label className="text-base font-medium text-slate-800">Patient discharged on
              <input type="datetime-local" value={discharge} onChange={(e) => setDischarge(e.target.value)} className={field} /></label>
            <button onClick={saveDischarge} disabled={!discharge} className="min-h-12 rounded-xl bg-slate-700 px-4 text-base font-semibold text-white disabled:opacity-40">Save discharge</button>
          </div>
        )}
        {shown === 'stay' && isNow && c.case_source === 'ecw' && <p className="mt-3 text-sm text-slate-500">Discharge and the final bill come in with the next eCW upload.</p>}

        {/* Payment: money in, and the reason for anything short */}
        {(shown === 'payment' || shown === 'closed') && pay && (pay.allocations.length > 0 || pay.adjustments.length > 0) && (
          <ul className="mt-4 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white text-base">
            {pay.allocations.filter((a) => !a.reversed_at).map((a) => (
              <li key={a.id} className="flex justify-between gap-3 p-3"><span>Payment {a.clm_receipts?.value_date ? shortDate(a.clm_receipts.value_date) : ''}{a.clm_receipts?.reference ? ` · UTR ${a.clm_receipts.reference}` : ''}</span><b>{money(a.amount)}</b></li>
            ))}
            {pay.adjustments.filter((a) => !a.reversed_at).map((a) => (
              <li key={a.id} className="flex justify-between gap-3 p-3 text-slate-600"><span>{a.kind === 'tds' ? 'TDS' : a.kind === 'deduction' ? `Deduction — ${a.reason_text ?? a.category}` : a.kind === 'rounding' ? 'Small difference closed' : a.kind}</span><span>{money(a.amount)}</span></li>
            ))}
          </ul>
        )}
        {shown === 'payment' && isNow && canWrite && m && m.balance > 1 && m.allocated > 0 && m.recon_status !== 'disputed' && (
          <div className="mt-4 space-y-3 rounded-xl border border-slate-200 bg-white p-4">
            {m.balance <= 100 ? (
              <button onClick={() => payAction('small')} disabled={busy} className="min-h-12 rounded-xl bg-slate-700 px-5 text-base font-semibold text-white">Close the small difference of {money(m.balance)}</button>
            ) : <>
              <p className="text-lg font-semibold text-slate-900">Paid {money(m.balance)} less — why?</p>
              <select value={why.cat} onChange={(e) => setWhy((w) => ({ ...w, cat: e.target.value }))} className={field} aria-label="Reason">
                <option value="">Choose the reason…</option>
                {Object.entries(DISALLOWANCE_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
              <input value={why.text} onChange={(e) => setWhy((w) => ({ ...w, text: e.target.value }))} placeholder="What the letter says" className={field} />
              <div className="flex flex-wrap gap-2">
                <button onClick={() => payAction('reason')} disabled={busy} className="min-h-12 rounded-xl bg-teal-600 px-5 text-base font-semibold text-white">Save reason</button>
                <button onClick={() => payAction('dispute')} disabled={busy} className="min-h-12 rounded-xl bg-amber-500 px-5 text-base font-semibold text-white">We will fight it</button>
              </div>
            </>}
            {error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-base text-rose-800">{error}</p>}
          </div>
        )}
        {shown === 'payment' && m?.recon_status === 'disputed' && <p className="mt-4 rounded-xl bg-amber-50 p-3 text-base text-amber-900">Disputed with the insurer — follow up until it is paid.</p>}
        {shown === 'payment' && isNow && m && m.allocated === 0 && <p className="mt-4 text-base text-slate-700">When the payment letter or PMJAY sheet comes, upload it on <Link href="/pay" className="font-semibold text-teal-700 underline">Upload payments</Link> — it lands here by itself.</p>}

        {/* NHCX replies sit on the stage they answer */}
        {replies.length > 0 && actionStage === shown && (
          <div className="mt-4 rounded-xl border border-indigo-200 bg-indigo-50 p-4">
            <p className="flex items-center gap-2 text-base font-semibold text-indigo-900"><Inbox className="h-5 w-5" /> Reply from the insurer (NHCX)</p>
            <ul className="mt-2 space-y-2">{replies.map((x) => (
              <li key={x.id} className="rounded-lg bg-white p-3">
                <p className="text-base text-slate-900">{replyWords(x)}</p><p className="text-sm text-slate-500">{dateTime(x.created_at)}</p>
                {canWrite && <div className="mt-2 flex gap-2">
                  <button onClick={() => applyReply(x)} className="min-h-11 rounded-lg bg-indigo-600 px-4 text-base font-semibold text-white">Use this reply</button>
                  <button onClick={async () => { try { await markNhcxHandled(x.id, 'ignored'); await reload(); } catch { flash('Could not save. Try again.', 'err'); } }} className="min-h-11 rounded-lg bg-slate-100 px-4 text-base text-slate-700">Seen</button>
                </div>}
              </li>))}</ul>
          </div>
        )}

        {step.overdue && !step.ours && actionStage === shown && (
          <p className="mt-4 flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-base text-amber-900">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" /> The insurer is late. Call the TPA desk or email them with the {c.tpa_claim_number || c.tpa_preauth_number ? `reference ${c.tpa_claim_number ?? c.tpa_preauth_number}` : 'IP No.'}.
          </p>
        )}

        {/* NHCX details where a request goes out */}
        {route === 'nhcx' && (shown === 'preauth' || shown === 'discharge') && st !== 'done' && st !== 'skipped' && (
          <NhcxDetails key={c.updated_at} c={c} kind={shown === 'preauth' ? 'preauth' : 'claim'} canWrite={canWrite} onSaved={reload} />
        )}

        {/* Papers for this stage */}
        {activeClaim?.id === c.id && (shown === 'preauth' || shown === 'discharge' || shown === 'claim') && st !== 'skipped' && (
          <div className="mt-5">
            <h3 className="mb-2 text-lg font-semibold text-slate-900">Papers</h3>
            <ReadinessPanel key={shown} claim={activeClaim} rules={activeRules} documents={activeDocuments}
              defaultStage={shown === 'preauth' ? 'preauth' : 'final'} canWrite={canWrite} onChanged={reload} flash={flash} />
          </div>
        )}
      </section>

      {/* The file's history */}
      {history.length > 0 && (
        <details className="mt-5 rounded-2xl border border-slate-200 bg-white p-5">
          <summary className="flex cursor-pointer items-center gap-2 text-lg font-semibold text-slate-900"><History className="h-5 w-5 text-slate-500" /> History ({history.length})</summary>
          <ol className="mt-3 space-y-2">{history.map((h, i) => (
            <li key={i} className="flex gap-3 text-base"><span className="w-36 shrink-0 text-sm text-slate-500">{dateTime(h.created_at)}</span>
              <span className="text-slate-800">{h.event_text}{h.notes ? <span className="text-slate-500"> — {h.notes}</span> : null}</span></li>))}</ol>
        </details>
      )}
    </div>
  );
}
