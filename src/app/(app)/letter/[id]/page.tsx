'use client';
// Dispute letter for one deduction, ready to print on the hospital letterhead.
// 1 reconsideration to the payer · 2 escalation to the insurer · 3 the patient's
// own grievance to the insurer (only a policyholder can take it to IRDAI's
// Bima Bharosa or the Insurance Ombudsman). Every part of the letter can be
// edited before printing; "Mark as sent" starts the follow-up clock.
import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, Printer, Send, CheckCircle2 } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import { sb } from '@/lib/supabase/browser';
import { fetchCase, fetchMoneyFor, recordDisputeLetter } from '@/lib/rcm/api';
import { cutOf, LETTERS } from '@/lib/rcm/cut';
import type { Claim } from '@/lib/claims/types';
import type { CaseMoney } from '@/lib/rcm/journey';

const rs = (n: number | null | undefined) => (n == null ? '—' : `₹${Math.round(Number(n)).toLocaleString('en-IN')}`);
const day = (d: string | null | undefined) =>
  d ? new Date(d.length === 10 ? `${d}T12:00:00+05:30` : d).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '—';

/** Grounds the desk most often gives, matched to the payer's reason. */
function groundsFor(reason: string): string {
  const r = reason.toLowerCase();
  if (/consum|non.?pay|disposable/.test(r)) return 'The items deducted were used directly in the patient’s treatment, are billed as per our agreed tariff and are not listed as non-payable under the policy.';
  if (/room|rent|proportion/.test(r)) return 'The patient stayed in the room category eligible under the policy. Proportionate deduction does not apply to the charges deducted.';
  if (/tariff|rate|package/.test(r)) return 'The charges are as per the tariff / package agreed with us and in force on the date of admission.';
  if (/document|paper|report|missing/.test(r)) return 'All the documents asked for have been submitted. Copies are enclosed again for your reference.';
  if (/pre.?exist|ped/.test(r)) return 'The treatment was not for a pre-existing disease as defined in the policy. The treating doctor’s certificate is enclosed.';
  return 'The deduction is not justified under the policy terms and our agreement. The treatment and charges were medically necessary and are supported by the enclosed records.';
}

function Letter() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const level = ([1, 2, 3].includes(Number(params.get('level'))) ? Number(params.get('level')) : 1) as 1 | 2 | 3;
  const { centres, activeCentreId, staff } = useAuthStore();
  const canWrite = staff?.role === 'admin' || staff?.role === 'manager' || staff?.role === 'desk';
  const centre = centres.find((x) => x.id === activeCentreId)?.name ?? '';

  const [c, setC] = useState<Claim | null>(null);
  const [m, setM] = useState<CaseMoney | null>(null);
  const [hospital, setHospital] = useState('');
  const [payerReason, setPayerReason] = useState('');
  const [loading, setLoading] = useState(true);
  const [to, setTo] = useState('');
  const [grounds, setGrounds] = useState('');
  const [signName, setSignName] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      const [cc, mm, tn] = await Promise.all([fetchCase(id), fetchMoneyFor(id), sb().from('clm_tenants').select('name').maybeSingle()]);
      setC(cc); setM(mm);
      // the hospital the patient was treated at (the case's centre, not the one selected now)
      const at = centres.find((x) => x.id === cc?.centre_id)?.name ?? centre;
      const hosp = [(tn.data as { name?: string } | null)?.name, at].filter(Boolean).join(', ');
      setHospital(hosp);
      // the payer's reason: the deduction booked from the letter, else the note on the partial approval
      let reason = '';
      if (mm) {
        const { data } = await sb().from('clm_adjustments').select('reason_text').eq('receivable_id', mm.receivable_id).eq('kind', 'deduction')
          .order('created_at', { ascending: false }).limit(1).maybeSingle();
        reason = (data as { reason_text?: string } | null)?.reason_text ?? '';
      }
      if (!reason) {
        const { data } = await sb().from('clm_state_transitions').select('notes').eq('claim_id', id).eq('to_status', 'claim_partial')
          .order('created_at', { ascending: false }).limit(1).maybeSingle();
        reason = (data as { notes?: string } | null)?.notes ?? '';
      }
      setPayerReason(reason);
      const payer = cc?.clm_payers?.name ?? 'the payer';
      setTo(level === 1 ? `The Claims Department\n${payer}` : level === 2 ? `The Head – Claims / Provider Network\n[Insurance company name]` : `The Grievance Redressal Officer\n[Insurance company name]`);
      setGrounds(cc?.cut_note?.trim() ? cc.cut_note.trim() : groundsFor(reason));
      setSignName(level === 3 ? cc?.patient_name ?? '' : staff?.full_name ?? '');
      setLoading(false);
    })().catch(() => { setError('Could not load this case.'); setLoading(false); });
  }, [id, level, centre, centres, staff?.full_name]);

  const cut = useMemo(() => (c ? cutOf(c, m) : null), [c, m]);
  if (loading) return <div className="flex justify-center py-16"><Loader2 className="h-7 w-7 animate-spin text-teal-600" /></div>;
  if (!c || !cut) return <p className="p-8 text-base text-rose-700">{error || 'Case not found.'}</p>;

  const amount = cut.amount;
  const claimNo = c.tpa_claim_number ?? c.claim_number;
  const today = day(new Date().toISOString());
  const earlier = c.dispute_sent_at && (c.dispute_level ?? 0) >= 1 ? day(c.dispute_sent_at) : '[date of our earlier letter]';
  const subject = level === 3
    ? `Grievance against deduction of ${rs(amount)} in my claim no. ${claimNo}`
    : level === 2
    ? `Escalation: deduction of ${rs(amount)} in claim no. ${claimNo} — patient ${c.patient_name}`
    : `Request for reconsideration of deduction of ${rs(amount)} — claim no. ${claimNo}, patient ${c.patient_name}`;

  const body: string[] = level === 1 ? [
    `We refer to the settlement of the above claim, in which ${rs(amount)} has been deducted${payerReason ? ` on the grounds of “${payerReason}”` : ''}.`,
    'We request you to reconsider this deduction for the following reasons:',
  ] : level === 2 ? [
    `On ${earlier} we requested the claims team to reconsider the deduction of ${rs(amount)} in the above claim${payerReason ? ` (reason given: “${payerReason}”)` : ''}. We have not received a satisfactory reply.`,
    'We therefore escalate the matter to you for review. Our grounds are:',
  ] : [
    `I was treated at ${hospital || 'the hospital'} from ${day(c.admitted_at ?? c.admission_date)} to ${day(c.discharged_at ?? c.discharge_date)} under the above policy. Out of the claim of ${rs(c.claimed_amount)}, ${rs(amount)} has been deducted${payerReason ? ` on the grounds of “${payerReason}”` : ''}.`,
    'I do not agree with this deduction, for the following reasons:',
  ];
  const close = level === 3
    ? [`I request you to review my claim and pay the balance of ${rs(amount)}. If my grievance is not resolved, I may take it to IRDAI’s Bima Bharosa portal or the Insurance Ombudsman.`]
    : [`We request you to review the claim and release the balance of ${rs(amount)} at the earliest. Supporting documents are enclosed${level === 1 ? ' / uploaded on the portal' : ''}.`];

  const markSent = async () => {
    setBusy(true); setError('');
    try { await recordDisputeLetter(c.id, level); setSent(true); }
    catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const rows: [string, string][] = [
    ['Patient', c.patient_name], ['IP number', c.admission_ref ?? '—'], ['Policy / member no.', [c.policy_number, c.member_id].filter(Boolean).join(' / ') || '—'],
    ['Claim no.', claimNo], ['Pre-auth no.', c.tpa_preauth_number ?? '—'],
    ['Admission – discharge', `${day(c.admitted_at ?? c.admission_date)} – ${day(c.discharged_at ?? c.discharge_date)}`],
    ['Amount claimed', rs(c.claimed_amount)], ['Amount approved', rs(c.approved_amount)], ['Amount deducted', rs(amount)],
  ];
  const edit = 'w-full resize-none rounded border border-dashed border-slate-300 bg-amber-50/40 p-1 print:border-0 print:bg-transparent print:p-0';

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 print:max-w-none print:p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <button type="button" onClick={() => router.back()} className="inline-flex min-h-11 items-center gap-1 text-base text-slate-600 hover:text-slate-900"><ArrowLeft className="h-4 w-4" /> Back</button>
        <div className="flex flex-wrap gap-2">
          {[1, 2, 3].map((lv) => (
            <Link key={lv} href={`/letter/${c.id}?level=${lv}`} replace
              className={`min-h-11 rounded-full border px-4 py-2.5 text-sm font-medium ${lv === level ? 'border-teal-600 bg-teal-600 text-white' : 'border-slate-200 bg-white text-slate-700'}`}>{LETTERS[lv].short}</Link>
          ))}
        </div>
      </div>
      <p className="mt-3 text-sm text-slate-500 print:hidden">Shaded parts can be edited. Print on the hospital letterhead{level === 3 ? ' — the patient signs and sends this one' : ''}.</p>

      <article className="mt-4 rounded-xl border border-slate-200 bg-white p-8 text-[15px] leading-relaxed text-slate-900 print:mt-0 print:rounded-none print:border-0 print:p-0 print:pt-28">
        <p className="text-right">{today}</p>
        <textarea aria-label="To" value={to} onChange={(e) => setTo(e.target.value)} rows={2} className={`${edit} mt-4`} />
        <p className="mt-4 font-semibold">Subject: {subject}</p>
        <table className="mt-3 w-full border-collapse text-sm">
          <tbody>{rows.map(([k, v]) => (
            <tr key={k} className="border-b border-slate-200"><td className="w-48 py-1 pr-3 text-slate-600">{k}</td><td className="py-1 font-medium">{v}</td></tr>
          ))}</tbody>
        </table>
        <p className="mt-4">Dear Sir / Madam,</p>
        {body.map((t, i) => <p key={i} className="mt-3">{t}</p>)}
        <textarea aria-label="Grounds" value={grounds} onChange={(e) => setGrounds(e.target.value)} rows={4} className={`${edit} mt-2`} />
        {close.map((t, i) => <p key={i} className="mt-3">{t}</p>)}
        <p className="mt-6">{level === 3 ? 'Yours faithfully,' : 'Thanking you,'}</p>
        <input aria-label="Signed by" value={signName} onChange={(e) => setSignName(e.target.value)} className={`${edit} mt-10 max-w-xs`} />
        <p className="text-sm text-slate-600">{level === 3 ? 'Patient / policyholder' : `Claims Department${hospital ? `, ${hospital}` : ''}`}</p>
      </article>

      <div className="mt-4 flex flex-wrap gap-2 print:hidden">
        <button type="button" onClick={() => window.print()} className="inline-flex min-h-12 items-center gap-2 rounded-xl border border-slate-300 bg-white px-5 text-base font-semibold text-slate-800 hover:bg-slate-50">
          <Printer className="h-5 w-5" /> Print / save as PDF</button>
        {canWrite && c.cut_decision === 'fought' && !sent && (
          <button type="button" onClick={markSent} disabled={busy} className="inline-flex min-h-12 items-center gap-2 rounded-xl bg-teal-600 px-5 text-base font-bold text-white hover:bg-teal-700 disabled:opacity-50">
            {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />} Mark as sent today</button>
        )}
        {sent && <span className="inline-flex min-h-12 items-center gap-2 rounded-xl bg-emerald-50 px-4 text-base font-semibold text-emerald-800"><CheckCircle2 className="h-5 w-5" /> Recorded — follow-up set on Master</span>}
        {sent && <Link href="/master?show=cuts" className="inline-flex min-h-12 items-center rounded-xl bg-slate-100 px-4 text-base font-medium text-slate-700">Back to Master</Link>}
      </div>
      {c.cut_decision !== 'fought' && <p className="mt-3 text-sm text-amber-800 print:hidden">Mark the deduction as disputed on Master before recording a letter as sent.</p>}
      {error && <p role="alert" className="mt-3 rounded-lg bg-rose-50 p-3 text-base text-rose-800 print:hidden">{error}</p>}
    </div>
  );
}

export default function LetterPage() {
  return <Suspense fallback={null}><Letter /></Suspense>;
}
