'use client';
// Claim workstation: H1 Claims' detail page + ClaimOne's readiness gate.
import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Loader2, Shield, ArrowLeft, CheckCircle2, Clock, Stethoscope, User, Building2, Ban } from 'lucide-react';
import { useClaimsStore } from '@/lib/claims/store';
import { useAuthStore } from '@/lib/store/auth';
import { CLAIM_TYPE_LABELS, PRIORITY_CONFIG, type ClaimStatus } from '@/lib/claims/types';
import { TRANSITIONS, type TransitionAction } from '@/lib/engine/transitions';
import { nextStage } from '@/lib/engine/validation';
import { transition, updateClaimFields } from '@/lib/claims/api';
import { ReadinessPanel } from '@/components/claim/ReadinessPanel';
import { SettlementForm } from '@/components/claim/SettlementForm';
import { QueriesTab } from '@/components/claim/QueriesTab';
import { StatusPill, inr, shortDate, dateTime, daysSince, useToast, btn } from '@/components/ui';

type Tab = 'documents' | 'details' | 'queries' | 'timeline' | 'settlement';

const TONE: Record<TransitionAction['tone'], string> = {
  primary: 'bg-teal-600 hover:bg-teal-700', success: 'bg-emerald-600 hover:bg-emerald-700',
  warning: 'bg-amber-600 hover:bg-amber-700', danger: 'bg-rose-600 hover:bg-rose-700', neutral: 'bg-slate-600 hover:bg-slate-700',
};

export default function ClaimPage() {
  const { id } = useParams<{ id: string }>();
  const role = useAuthStore((s) => s.staff?.role);
  const canWrite = role === 'admin' || role === 'manager' || role === 'desk';
  const isManager = role === 'admin' || role === 'manager';
  const { activeClaim: claim, activeTimeline, activeQueries, activeDocuments, activeRules, loadClaimDetail, afterMutation } = useClaimsStore();
  const { flash, toastNode } = useToast();

  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('documents');
  const [pending, setPending] = useState<TransitionAction | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [blockers, setBlockers] = useState<string[]>([]);

  const reload = useCallback(() => loadClaimDetail(id), [id, loadClaimDetail]);
  useEffect(() => { setLoading(true); reload().finally(() => setLoading(false)); }, [reload]);

  if (loading && claim?.id !== id) return <div className="flex min-h-[60vh] items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-teal-600" /></div>;
  if (!claim) return (
    <div className="py-20 text-center">
      <Shield className="mx-auto mb-3 h-10 w-10 text-slate-300" /><p className="text-sm text-slate-500">Claim not found, or not at your centre.</p>
      <Link href="/claims" className="mt-2 inline-block text-sm text-teal-700 hover:underline">Back to claims</Link>
    </div>
  );

  const actions = (TRANSITIONS[claim.status] ?? []).filter((a) => !a.viaSettlement && (!a.managerOnly || isManager));
  const canSettle = ['claim_approved', 'claim_partial', 'settlement_pending'].includes(claim.status);
  const openQ = activeQueries.filter((q) => ['open', 'in_progress', 'escalated'].includes(q.status)).length;
  const stage = nextStage(claim.status, claim.claim_type);
  const pendingDays = daysSince(claim.submitted_at ?? claim.discharge_date ?? claim.created_at);
  const p = PRIORITY_CONFIG[claim.priority];

  const start = (a: TransitionAction) => {
    setBlockers([]); setNote('');
    const pre = a.needsAmount === 'approved_amount' ? claim.approved_amount ?? claim.estimated_amount
      : a.needsAmount === 'claimed_amount' ? claim.claimed_amount ?? claim.estimated_amount : null;
    setAmount(pre != null ? String(pre) : '');
    setPending(a);
  };

  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    const fields: Record<string, number> = {};
    if (pending.needsAmount) fields[pending.needsAmount] = Number(amount);
    try {
      await transition(claim.id, pending.to, fields, note.trim() || undefined);
      flash(`Moved to ${pending.label.toLowerCase()}`);
      setPending(null);
      await afterMutation(claim.id);
    } catch (e) {
      const err = e as Error & { blockers?: string[] };
      if (err.blockers?.length) { setBlockers(err.blockers); setTab('documents'); }
      else flash(err.message, 'err');
    }
    setBusy(false);
  };

  const saveField = async (field: 'tpa_claim_number' | 'tpa_preauth_number' | 'notes' | 'claimed_amount' | 'patient_payable', raw: string) => {
    const value = field === 'claimed_amount' || field === 'patient_payable' ? (raw.trim() === '' ? null : Number(raw)) : raw.trim() || null;
    if (value === claim[field]) return;
    try { await updateClaimFields(claim.id, { [field]: value }); flash('Saved'); await reload(); }
    catch (e) { flash((e as Error).message, 'err'); }
  };

  const tabs: [Tab, string, number | null][] = [
    ['documents', 'Documents', activeDocuments.length], ['details', 'Details', null],
    ['queries', 'Queries', activeQueries.length], ['timeline', 'Timeline', activeTimeline.length], ['settlement', 'Settlement', null],
  ];

  const Field = ({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) => (
    <div><p className="text-[11px] text-slate-400">{k}</p><p className={`text-sm text-slate-800 ${mono ? 'font-mono' : ''}`}>{v || '—'}</p></div>
  );

  return (
    <div className="mx-auto max-w-6xl px-4 pb-10 pt-4 md:px-6">
      {toastNode}
      <Link href="/claims" className="mb-1 inline-flex min-h-11 items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-3.5 w-3.5" /> Claims</Link>

      {/* Header */}
      <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-slate-900">{claim.patient_name}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
              <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono">{claim.claim_number}</span>
              {claim.patient_uhid && <span className="rounded bg-slate-100 px-1.5 py-0.5">{claim.patient_uhid}</span>}
              <StatusPill status={claim.status} />
              <span className="rounded bg-blue-50 px-1.5 py-0.5 font-medium text-blue-700">{CLAIM_TYPE_LABELS[claim.claim_type]}</span>
              <span className={`rounded px-1.5 py-0.5 font-medium ${p.bg} ${p.color}`}>{p.label}</span>
              <span>{claim.clm_payers?.name}</span>
              {pendingDays != null && pendingDays > 30 && !['settled', 'closed', 'written_off'].includes(claim.status) && (
                <span className={`rounded px-1.5 py-0.5 font-bold ${pendingDays > 90 ? 'bg-rose-600 text-white' : 'bg-amber-50 text-amber-700'}`}>{pendingDays} days</span>
              )}
              {openQ > 0 && <button onClick={() => setTab('queries')} className="rounded bg-orange-600 px-1.5 py-0.5 font-bold text-white">{openQ} open quer{openQ > 1 ? 'ies' : 'y'}</button>}
            </div>
            {claim.primary_diagnosis && <p className="mt-1.5 text-xs text-slate-600">{claim.primary_diagnosis}{claim.icd_code ? ` (${claim.icd_code})` : ''}{claim.procedure_name ? ` · ${claim.procedure_name}` : ''}</p>}
          </div>
          {canWrite && (
            <div className="flex flex-wrap justify-end gap-1.5">
              {actions.map((a) => (
                <button key={a.to} onClick={() => start(a)} className={`min-h-10 rounded-lg px-3.5 text-sm font-semibold text-white ${TONE[a.tone]}`}>{a.label}</button>
              ))}
              {canSettle && <button onClick={() => setTab('settlement')} className="min-h-10 rounded-lg bg-emerald-600 px-3.5 text-sm font-semibold text-white hover:bg-emerald-700">Record settlement</button>}
            </div>
          )}
        </div>
      </div>

      {/* Money strip */}
      <div className="mb-4 grid grid-cols-3 gap-2 md:grid-cols-6">
        {([['Estimated', claim.estimated_amount, 'text-slate-700'], ['Claimed', claim.claimed_amount, 'text-purple-700'],
           ['Approved', claim.approved_amount, 'text-blue-700'], ['Deducted', claim.deduction_amount, 'text-rose-700'],
           ['TDS', claim.tds_amount, 'text-slate-600'], ['Received', claim.settled_amount, 'text-emerald-700']] as const).map(([k, v, c]) => (
          <div key={k} className="rounded-xl border border-slate-200 bg-white p-3 text-center">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{k}</p>
            <p className={`tabular mt-0.5 text-base font-bold ${c}`}>{inr(v)}</p>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200">
        {tabs.map(([k, l, n]) => (
          <button key={k} onClick={() => setTab(k)} className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-xs font-semibold ${tab === k ? 'border-teal-600 text-teal-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
            {l}{n ? <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 text-[10px] text-slate-500">{n}</span> : null}
          </button>
        ))}
      </div>

      {tab === 'documents' && (
        <div className="space-y-3">
          {blockers.length > 0 && (
            <div className="flex gap-2.5 rounded-xl border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">
              <Ban className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
              <div><p className="font-semibold">The submission was blocked. Verify these first:</p><ul className="mt-1 list-disc pl-5">{blockers.map((b) => <li key={b}>{b}</li>)}</ul></div>
            </div>
          )}
          <ReadinessPanel claim={claim} rules={activeRules} documents={activeDocuments} defaultStage={stage}
            canWrite={canWrite} onChanged={reload} flash={flash} />
        </div>
      )}

      {tab === 'details' && (
        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-4 md:col-span-2">
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <h3 className="mb-3 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-slate-500"><Stethoscope className="h-3.5 w-3.5" /> Clinical</h3>
              <div className="grid grid-cols-2 gap-x-6 gap-y-2.5">
                <Field k="Diagnosis" v={claim.primary_diagnosis} /><Field k="ICD-10" v={claim.icd_code} mono />
                <Field k="Procedure" v={claim.procedure_name} /><Field k="Department" v={claim.department_name} />
                <Field k="Treating doctor" v={claim.treating_doctor_name} />
                <Field k="Package" v={claim.package_name ? `${claim.package_code ? claim.package_code + ' · ' : ''}${claim.package_name}${claim.package_amount ? ` (${inr(claim.package_amount)})` : ''}` : null} />
                <Field k="Admitted" v={shortDate(claim.admission_date)} /><Field k="Discharged" v={shortDate(claim.discharge_date)} />
                <Field k="Admission / IPD no." v={claim.admission_ref} mono />
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <h3 className="mb-3 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-slate-500"><User className="h-3.5 w-3.5" /> Patient and policy</h3>
              <div className="grid grid-cols-2 gap-x-6 gap-y-2.5">
                <Field k="Patient" v={claim.patient_name} /><Field k="UHID" v={claim.patient_uhid} mono />
                <Field k="Phone" v={claim.patient_phone} /><Field k="ABHA" v={claim.abha_id} mono />
                <Field k="Policy no." v={claim.policy_number} mono /><Field k="Policyholder" v={claim.policy_holder_name} />
              </div>
            </div>
          </div>
          <div className="space-y-4">
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <h3 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-slate-500"><Building2 className="h-3.5 w-3.5" /> Payer references</h3>
              <p className="text-sm font-medium">{claim.clm_payers?.name}</p>
              {(['tpa_preauth_number', 'tpa_claim_number'] as const).map((f) => (
                <div key={f} className="mt-3">
                  <label className="text-[10px] uppercase tracking-wider text-slate-400">{f === 'tpa_claim_number' ? 'Payer claim no.' : 'Payer pre-auth no.'}</label>
                  <input disabled={!canWrite} defaultValue={claim[f] ?? ''} onBlur={(e) => saveField(f, e.target.value)} className={`${btn.input} mt-0.5 w-full font-mono text-xs`} />
                </div>
              ))}
              {(['claimed_amount', 'patient_payable'] as const).map((f) => (
                <div key={f} className="mt-3">
                  <label className="text-[10px] uppercase tracking-wider text-slate-400">{f === 'claimed_amount' ? 'Final bill claimed (₹)' : 'Patient payable (₹)'}</label>
                  <input disabled={!canWrite} inputMode="decimal" defaultValue={claim[f] ?? ''} onBlur={(e) => saveField(f, e.target.value)} className={`${btn.input} mt-0.5 w-full text-xs tabular`} />
                </div>
              ))}
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4">
              <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Internal notes</label>
              <textarea disabled={!canWrite} rows={4} defaultValue={claim.notes ?? ''} onBlur={(e) => saveField('notes', e.target.value)} className={`${btn.input} mt-1 w-full resize-none text-xs`} />
            </div>
          </div>
        </div>
      )}

      {tab === 'queries' && <QueriesTab claimId={claim.id} queries={activeQueries} canWrite={canWrite} onChanged={() => afterMutation(claim.id)} flash={flash} />}

      {tab === 'timeline' && (
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          {activeTimeline.length === 0 ? <p className="py-8 text-center text-sm text-slate-400">Nothing recorded yet</p> : (
            <ol>
              {activeTimeline.map((e, i) => {
                const dot = e.event_type === 'status_change' ? 'bg-blue-500' : e.event_type.startsWith('query') ? 'bg-orange-500'
                  : e.event_type === 'settlement' ? 'bg-emerald-500' : e.event_type === 'submit_blocked' || e.event_type === 'doc_rejected' ? 'bg-rose-500' : 'bg-slate-400';
                return (
                  <li key={i} className="flex gap-3">
                    <div className="flex flex-col items-center"><span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${dot}`} />{i < activeTimeline.length - 1 && <span className="mt-1 w-px flex-1 bg-slate-200" />}</div>
                    <div className="flex-1 pb-4">
                      <div className="flex items-start justify-between gap-3">
                        <p className="text-sm text-slate-800">{e.event_text}</p>
                        <span className="shrink-0 text-[10px] text-slate-400">{dateTime(e.created_at)}</span>
                      </div>
                      {e.notes && <p className="mt-0.5 text-xs italic text-slate-500">{e.notes}</p>}
                      {e.source === 'bot' && <span className="text-[10px] text-slate-400">via portal bot</span>}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}

      {tab === 'settlement' && (
        ['settled', 'closed'].includes(claim.status) ? (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-6 text-center">
            <CheckCircle2 className="mx-auto mb-2 h-10 w-10 text-emerald-500" />
            <p className="text-lg font-bold text-emerald-800">{inr(claim.settled_amount)} received</p>
            <p className="mt-1 text-sm text-emerald-700">on {shortDate(claim.settlement_date)}{claim.settlement_utr ? ` · UTR ${claim.settlement_utr}` : ''}</p>
            <p className="mt-2 text-xs text-slate-600">Approved {inr(claim.approved_amount)} · TDS {inr(claim.tds_amount)} · Deducted {inr(claim.deduction_amount)}</p>
          </div>
        ) : canSettle && canWrite ? (
          <SettlementForm claim={claim} onDone={() => afterMutation(claim.id)} flash={flash} />
        ) : (
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-8 text-center">
            <Clock className="mx-auto mb-2 h-9 w-9 text-slate-300" />
            <p className="text-sm text-slate-500">Settlement can be recorded once the payer approves the claim.</p>
          </div>
        )
      )}

      {/* Transition dialog */}
      {pending && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4" onClick={() => !busy && setPending(null)}>
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-slate-900">{pending.label}</h3>
            <p className="mb-4 text-xs text-slate-500">{claim.claim_number} · {claim.patient_name}</p>
            {pending.needsAmount && (
              <div className="mb-3">
                <label className="text-[10px] font-semibold uppercase text-slate-500">{pending.needsAmount === 'approved_amount' ? 'Approved amount (₹)' : 'Final bill amount claimed (₹)'} *</label>
                <input autoFocus inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={`${btn.input} mt-1 w-full text-lg tabular`} />
              </div>
            )}
            <label className="text-[10px] font-semibold uppercase text-slate-500">Note for the timeline</label>
            <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} className={`${btn.input} mt-1 w-full text-sm`}
              placeholder={pending.to === 'written_off' ? 'Why is this being written off?' : 'Optional'} />
            {blockers.length > 0 && <p className="mt-2 text-xs text-rose-600">Blocked — see the Documents tab.</p>}
            <div className="mt-5 flex gap-3">
              <button disabled={busy} onClick={() => setPending(null)} className="flex-1 rounded-xl border py-2.5 text-sm font-medium">Cancel</button>
              <button onClick={confirm}
                disabled={busy || (!!pending.needsAmount && !(Number(amount) >= 0 && amount.trim() !== '')) || (pending.to === 'written_off' && !note.trim())}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-teal-600 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
                {busy && <Loader2 className="h-4 w-4 animate-spin" />} Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
