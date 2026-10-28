'use client';
// One patient's case, in plain words: who pays, what to do next (one card),
// the papers, and replies that came in on NHCX. Every button is a normal
// status change — the database checks the move and the papers.
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Loader2, ArrowLeft, CheckCircle2, AlertTriangle, Inbox, ExternalLink, Send } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import { useClaimsStore } from '@/lib/claims/store';
import { transition, updateClaimFields } from '@/lib/claims/api';
import { sb } from '@/lib/supabase/browser';
import { fetchCase, fetchNhcxMessages, markNhcxHandled, type NhcxMessage } from '@/lib/rcm/api';
import { nextStep, dueText, STATUS_WORDS } from '@/lib/rcm/worklist';
import { actionsFor, type CaseAction } from '@/lib/rcm/actions';
import { routeFor, ROUTE_WORDS } from '@/lib/rcm/payer';
import type { Claim } from '@/lib/claims/types';
import { ReadinessPanel } from '@/components/claim/ReadinessPanel';
import { NhcxDetails } from '@/components/case/NhcxDetails';
import { inr, shortDate, dateTime, useToast } from '@/components/ui';

const TONE: Record<CaseAction['tone'], string> = {
  primary: 'bg-teal-600 hover:bg-teal-700 text-white', success: 'bg-emerald-600 hover:bg-emerald-700 text-white',
  warning: 'bg-amber-500 hover:bg-amber-600 text-white', danger: 'bg-rose-600 hover:bg-rose-700 text-white',
  neutral: 'bg-slate-600 hover:bg-slate-700 text-white',
};
const field = 'mt-1 min-h-12 w-full rounded-lg border border-slate-300 px-3 text-base focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100';

/** Plain words for a reply that came in on NHCX. */
function replyWords(m: NhcxMessage): string {
  const s = m.summary as { outcome?: string; approved_amount?: number; message?: string };
  const what = m.api_call === 'preauth' ? 'Pre-auth' : m.api_call === 'claim' ? 'Claim' : m.api_call === 'communication' ? 'Query' : 'Reply';
  const amt = s.approved_amount != null ? ` · ${inr(Number(s.approved_amount))}` : '';
  return `${what}: ${s.outcome ?? 'received'}${amt}${s.message ? ` — ${s.message}` : ''}`;
}

export default function CasePage() {
  const { id } = useParams<{ id: string }>();
  const role = useAuthStore((s) => s.staff?.role);
  const centreId = useAuthStore((s) => s.activeCentreId);
  const canWrite = role === 'admin' || role === 'manager' || role === 'desk';
  const isManager = role === 'admin' || role === 'manager';
  const { activeDocuments, activeRules, activeClaim, loadClaimDetail } = useClaimsStore();
  const { flash, toastNode } = useToast();

  const [c, setC] = useState<Claim | null | undefined>(undefined);
  const [msgs, setMsgs] = useState<NhcxMessage[]>([]);
  const [centreOnNhcx, setCentreOnNhcx] = useState(false);
  const [open, setOpen] = useState<CaseAction | null>(null);
  const [amount, setAmount] = useState('');
  const [ref, setRef] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [blockers, setBlockers] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [discharge, setDischarge] = useState('');

  const reload = useCallback(async () => {
    const [x, m] = await Promise.all([fetchCase(id), fetchNhcxMessages(id), loadClaimDetail(id)]);
    setC(x); setMsgs(m);
  }, [id, loadClaimDetail]);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    if (!centreId) return;
    sb().from('clm_centres').select('nhcx_participant_code').eq('id', centreId).maybeSingle()
      .then(({ data }: { data: { nhcx_participant_code: string | null } | null }) => setCentreOnNhcx(!!data?.nhcx_participant_code));
  }, [centreId]);

  const step = useMemo(() => (c ? nextStep(c) : null), [c]);
  const route = routeFor(c?.clm_payers, centreOnNhcx);
  const actions = useMemo(() => (c && step ? actionsFor(step, c, route).filter((a) => !a.managerOnly || isManager) : []), [c, step, route, isManager]);
  const replies = msgs.filter((m) => m.direction === 'in' && m.status === 'received');

  const start = (a: CaseAction, prefill?: { amount?: number; ref?: string; note?: string }) => {
    setOpen(a); setBlockers([]); setError('');
    setAmount(String(prefill?.amount ?? a.amount?.value ?? ''));
    setRef(prefill?.ref ?? a.ref?.value ?? '');
    setNote(prefill?.note ?? '');
  };

  const run = async () => {
    if (!c || !open) return;
    if (open.amount && !(Number(amount) >= 0 && amount !== '')) { setError('Enter the amount.'); return; }
    if (open.note?.required && !note.trim()) { setError(`Fill in: ${open.note.label}`); return; }
    setBusy(true); setError(''); setBlockers([]);
    try {
      const fields: Record<string, unknown> = {};
      if (open.amount) fields[open.amount.field] = Number(amount);
      if (open.ref && ref.trim()) fields[open.ref.field] = ref.trim();
      if (open.nhcx) {
        const res = await fetch('/api/nhcx/send', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ claimId: c.id, kind: open.nhcx, amount: open.amount ? Number(amount) : undefined, note: note.trim() || undefined }),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) { setBlockers(j.blockers ?? []); throw new Error(j.error || 'NHCX send failed'); }
      } else {
        await transition(c.id, open.to, fields, note.trim() || (open.ref || open.nhcx ? `Sent via ${ROUTE_WORDS[route].label}` : undefined));
      }
      setOpen(null);
      flash('Saved');
      await reload();
    } catch (e) {
      const err = e as Error & { blockers?: string[] };
      if (err.blockers?.length) setBlockers(err.blockers);
      setError(err.message);
    }
    setBusy(false);
  };

  const applyReply = async (m: NhcxMessage) => {
    const s = m.summary as { outcome?: string; approved_amount?: number; reference?: string; message?: string };
    const want = /approv/i.test(s.outcome ?? '') ? (s.approved_amount != null && c?.claimed_amount != null && s.approved_amount < Number(c.claimed_amount) ? ['part', 'approved', 'full'] : ['approved', 'full', 'enhanced'])
      : /query|pend/i.test(s.outcome ?? '') ? ['query'] : /reject|denied/i.test(s.outcome ?? '') ? ['rejected'] : [];
    const a = actions.find((x) => want.includes(x.id));
    if (a) start(a, { amount: s.approved_amount, ref: s.reference, note: s.message });
    else flash('Nothing to apply for this reply — mark it as seen.', 'err');
  };

  const saveDischarge = async () => {
    if (!c || !discharge) return;
    try {
      const d = new Date(discharge);
      await updateClaimFields(c.id, { discharged_at: d.toISOString(), discharge_date: d.toISOString().slice(0, 10) } as Partial<Claim>);
      flash('Discharge saved'); setDischarge(''); await reload();
    } catch { flash('Could not save the discharge date', 'err'); }
  };

  if (c === undefined) return <div className="flex min-h-[60vh] items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-teal-600" /></div>;
  if (!c || !step) return <div className="py-20 text-center text-base text-slate-500">Case not found, or not at your centre. <Link href="/desk/admission" className="text-teal-700 underline">Back</Link></div>;

  const due = dueText(step);
  const back = step.desk === 'claims' || step.desk === 'payment' ? '/desk/claims' : '/desk/admission';

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 md:px-6">
      {toastNode}
      <Link href={back} className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Back to the desk</Link>

      <div className="mt-2">
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

      <div className="mt-4 grid grid-cols-3 gap-3 text-center">
        {[['Estimate', c.estimated_amount], ['Bill', c.claimed_amount ?? c.bill_amount], ['Approved', c.approved_amount]].map(([l, v]) => (
          <div key={l as string} className="rounded-xl border border-slate-200 bg-white p-3">
            <p className="text-sm text-slate-500">{l}</p><p className="text-lg font-bold text-slate-900">{v != null ? inr(Number(v)) : '—'}</p>
          </div>
        ))}
      </div>

      {/* Next step */}
      <section className={`mt-5 rounded-2xl border-2 p-5 ${step.overdue ? 'border-rose-300 bg-rose-50' : step.ours ? 'border-teal-300 bg-teal-50' : 'border-slate-200 bg-white'}`}>
        <p className="text-sm font-medium uppercase tracking-wide text-slate-500">{STATUS_WORDS[c.status]}</p>
        <p className="mt-1 text-xl font-bold text-slate-900">{step.label}</p>
        {due && <p className={`mt-1 text-base ${step.overdue ? 'font-semibold text-rose-700' : 'text-slate-600'}`}>{step.overdue ? `Late — ${due}` : `Due ${due}`}</p>}

        {step.key === 'wait_payment' && (
          <p className="mt-3 text-base text-slate-700">Nothing to do here. When the payment letter or PMJAY sheet comes, upload it on <Link href="/pay" className="font-semibold text-teal-700 underline">Upload payments</Link> — it matches by itself.</p>
        )}

        {canWrite && actions.length > 0 && !open && (
          <div className="mt-4 flex flex-wrap gap-2">
            {actions.map((a) => (
              <button key={a.id} onClick={() => start(a)} className={`inline-flex min-h-12 items-center gap-2 rounded-xl px-5 text-base font-semibold ${TONE[a.tone]}`}>
                {a.nhcx && <Send className="h-4 w-4" />} {a.label}
              </button>
            ))}
          </div>
        )}

        {open && (
          <div className="mt-4 space-y-3 rounded-xl bg-white p-4">
            <p className="text-lg font-semibold text-slate-900">{open.label}</p>
            {open.amount && <label className="block text-base font-medium text-slate-800">{open.amount.label}
              <input type="number" min="0" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={field} autoFocus /></label>}
            {open.ref && <label className="block text-base font-medium text-slate-800">{open.ref.label}
              <input value={ref} onChange={(e) => setRef(e.target.value)} className={field} /></label>}
            {open.note && <label className="block text-base font-medium text-slate-800">{open.note.label}{open.note.required ? ' *' : ''}
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} className={`${field} py-2`} /></label>}
            {error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-base text-rose-800">{error}</p>}
            {blockers.length > 0 && (
              <div className="rounded-lg bg-amber-50 p-3 text-base text-amber-900">
                <p className="font-semibold">Needed first — fill these in below:</p>
                <ul className="mt-1 list-disc pl-5">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>
              </div>
            )}
            <div className="flex gap-2">
              <button onClick={run} disabled={busy} className={`inline-flex min-h-12 flex-1 items-center justify-center gap-2 rounded-xl text-base font-bold ${TONE[open.tone]} disabled:opacity-50`}>
                {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <CheckCircle2 className="h-5 w-5" />} Save
              </button>
              <button onClick={() => setOpen(null)} className="min-h-12 rounded-xl bg-slate-100 px-5 text-base font-medium text-slate-700 hover:bg-slate-200">Cancel</button>
            </div>
          </div>
        )}

        {canWrite && !c.discharged_at && !c.discharge_date && c.case_source !== 'ecw' && (
          <div className="mt-4 flex flex-wrap items-end gap-2 border-t border-slate-200 pt-4">
            <label className="text-base font-medium text-slate-800">Patient discharged on
              <input type="datetime-local" value={discharge} onChange={(e) => setDischarge(e.target.value)} className={field} /></label>
            <button onClick={saveDischarge} disabled={!discharge} className="min-h-12 rounded-xl bg-slate-700 px-4 text-base font-semibold text-white disabled:opacity-40">Save</button>
          </div>
        )}
      </section>

      {route === 'nhcx' && step.desk !== 'payment' && step.desk !== 'done' && (
        <NhcxDetails key={c.updated_at} c={c} kind={step.desk === 'admission' ? 'preauth' : 'claim'} canWrite={canWrite} onSaved={reload} />
      )}

      {/* Replies on NHCX */}
      {replies.length > 0 && (
        <section className="mt-5 rounded-2xl border border-indigo-200 bg-indigo-50 p-5">
          <p className="flex items-center gap-2 text-lg font-semibold text-indigo-900"><Inbox className="h-5 w-5" /> Reply from the insurer (NHCX)</p>
          <ul className="mt-2 space-y-2">
            {replies.map((m) => (
              <li key={m.id} className="rounded-xl bg-white p-3">
                <p className="text-base text-slate-900">{replyWords(m)}</p>
                <p className="text-sm text-slate-500">{dateTime(m.created_at)}</p>
                {canWrite && <div className="mt-2 flex gap-2">
                  <button onClick={() => applyReply(m)} className="min-h-11 rounded-lg bg-indigo-600 px-4 text-base font-semibold text-white hover:bg-indigo-700">Use this reply</button>
                  <button onClick={async () => { await markNhcxHandled(m.id, 'ignored'); await reload(); }} className="min-h-11 rounded-lg bg-slate-100 px-4 text-base text-slate-700">Seen</button>
                </div>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {step.overdue && !step.ours && (
        <p className="mt-5 flex items-start gap-2 rounded-xl bg-amber-50 p-4 text-base text-amber-900">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" /> The insurer is late. Call the TPA desk or email them with the {c.tpa_preauth_number || c.tpa_claim_number ? `reference ${c.tpa_claim_number ?? c.tpa_preauth_number}` : 'IP No.'}.
        </p>
      )}

      {/* Papers */}
      {activeClaim?.id === c.id && (
        <section className="mt-5">
          <h2 className="mb-2 text-lg font-semibold text-slate-900">Papers</h2>
          <ReadinessPanel claim={activeClaim} rules={activeRules} documents={activeDocuments}
            defaultStage={step.desk === 'admission' ? 'preauth' : 'final'} canWrite={canWrite}
            onChanged={reload} flash={flash} />
        </section>
      )}

      <Link href={`/claims/${c.id}`} className="mt-6 inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        All details and history <ExternalLink className="h-3.5 w-3.5" />
      </Link>
    </div>
  );
}
