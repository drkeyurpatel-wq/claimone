'use client';
// The insurer's cut, on the patient's file: Accept the cut, or Fight it.
// Nothing here closes a file by itself — the database settles the file
// only after "Accept" (clm_decide_cut / clm_settle_from_receivable).
import { useState } from 'react';
import { Scale, Copy, Check } from 'lucide-react';
import type { Claim } from '@/lib/claims/types';
import type { Cut } from '@/lib/rcm/cut';
import { CUT_FLOOR } from '@/lib/rcm/cut';
import { decideCut } from '@/lib/rcm/api';
import { DISALLOWANCE_CATEGORIES } from '@/lib/engine/settlement';
import { inr, shortDate } from '@/components/ui';

const field = 'mt-1 min-h-12 w-full rounded-lg border border-slate-300 px-3 text-base focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100';

/** Common grounds, so the desk does not have to compose one. */
const GROUNDS = [
  'Items are payable as per the policy terms',
  'Room was within the eligible category',
  'Charges are as per the agreed tariff / package',
  'All documents were submitted — please re-verify',
  'Medically necessary as per the treating doctor',
];

function appealText(c: Claim, cut: Cut, reason: string | null, grounds: string): string {
  const payer = c.clm_payers?.name ?? 'the insurer';
  return [
    `To the Claims Team, ${payer}`,
    '',
    `Subject: Request to reconsider the deduction of ${inr(cut.amount)} — Claim no. ${c.tpa_claim_number ?? c.claim_number}`,
    '',
    `Patient: ${c.patient_name}${c.patient_uhid ? ` (UHID ${c.patient_uhid})` : ''}`,
    `Claimed: ${inr(Number(c.claimed_amount ?? 0))}`,
    reason ? `Deduction given as: ${reason}` : null,
    '',
    `We do not agree with this deduction. ${grounds}`,
    `Kindly review and release the balance of ${inr(cut.amount)}.`,
    '',
    'Regards,',
    'Claims Desk',
  ].filter((l) => l !== null).join('\n');
}

export function CutPanel({ c, cut, reason, shortfall, canWrite, onDone }: {
  c: Claim; cut: Cut;
  /** What the insurer wrote as the reason, if known. */
  reason: string | null;
  /** Rupees short with no reason booked yet (accepting then needs a reason). */
  shortfall: number;
  canWrite: boolean;
  onDone: (msg: string) => void;
}) {
  const [mode, setMode] = useState<'accept' | 'fight' | null>(null);
  const [cat, setCat] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  if (cut.state === 'none') return null;
  if (cut.state === 'small') {
    return <p className="mt-4 text-sm text-slate-500">Deduction of {inr(cut.amount)} is below {inr(CUT_FLOOR)} and closes automatically.</p>;
  }
  if (cut.state === 'accepted') {
    return <p className="mt-4 rounded-xl bg-slate-50 p-3 text-base text-slate-700">
      Deduction of {inr(cut.amount)} accepted{cut.decidedAt ? ` on ${shortDate(cut.decidedAt)}` : ''}{c.cut_note ? ` — ${c.cut_note}` : ''}.
    </p>;
  }

  const go = async (decision: 'accept' | 'fight') => {
    setError('');
    if (decision === 'fight' && !text.trim()) { setError('Enter the grounds for dispute, or select one above.'); return; }
    if (decision === 'accept' && shortfall > 1 && !cat) { setError('Select the deduction reason.'); return; }
    setBusy(true);
    try {
      await decideCut(c.id, decision, text.trim() || undefined, cat || undefined);
      setMode(null); setText(''); setCat('');
      onDone(decision === 'fight' ? 'Dispute raised — amount remains outstanding' : 'Deduction accepted');
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(appealText(c, cut, reason, c.cut_note ?? text)); setCopied(true); setTimeout(() => setCopied(false), 2000); }
    catch { setError('Copy failed — please select the text and copy it manually.'); }
  };

  const fighting = cut.state === 'fought';
  const aw = cut.awaited;
  return (
    <div className={`mt-4 rounded-xl border-2 p-4 ${aw ? 'border-sky-300 bg-sky-50' : fighting ? 'border-amber-300 bg-amber-50' : 'border-rose-300 bg-rose-50'}`}>
      <p className="flex items-center gap-2 text-lg font-semibold text-slate-900">
        <Scale className="h-5 w-5" />
        {aw ? `Balance awaited — ${inr(aw.amount)}` : fighting ? `Disputed deduction — ${inr(cut.amount)}` : `Deduction — ${inr(cut.amount)}`}
      </p>
      {reason && <p className="mt-1 text-base text-slate-700">Payer's reason: <b>{reason}</b></p>}
      {aw ? (
        <p className="mt-1 text-base text-slate-700">
          Paid in part ({aw.parts} payment{aw.parts === 1 ? '' : 's'}{aw.lastPaid ? `, last on ${shortDate(aw.lastPaid)}` : ''}). The balance is not treated as a deduction
          {aw.dueAt ? ` until ${shortDate(aw.dueAt.toISOString())}` : ' yet'} — record each further payment under Settlement.
          If the payer has said this is the final payment, accept or dispute the shortfall now.
        </p>
      ) : fighting ? (
        <p className="mt-1 text-base text-slate-700">
          Dispute raised{cut.decidedAt ? ` on ${shortDate(cut.decidedAt)}` : ''}{c.cut_note ? ` — grounds: ${c.cut_note}` : ''}.
          The amount remains outstanding until the payer settles it. Submit the appeal on the payer portal or by email and follow up.
        </p>
      ) : (
        <p className="mt-1 text-base text-slate-700">
          {c.status === 'settled' ? 'This case closed before deduction decisions were required. It can still be disputed.' : 'This case stays open until a decision is recorded.'}
        </p>
      )}

      {canWrite && !mode && (
        <div className="mt-3 flex flex-wrap gap-2">
          {!fighting && <button onClick={() => setMode('fight')} className="min-h-12 rounded-xl bg-amber-500 px-5 text-base font-semibold text-white hover:bg-amber-600">{aw ? 'Final — dispute the shortfall' : 'Dispute'}</button>}
          {fighting && <button onClick={copy} className="inline-flex min-h-12 items-center gap-2 rounded-xl bg-teal-600 px-5 text-base font-semibold text-white hover:bg-teal-700">
            {copied ? <Check className="h-5 w-5" /> : <Copy className="h-5 w-5" />} {copied ? 'Copied' : 'Copy appeal letter'}</button>}
          <button onClick={() => setMode('accept')} className="min-h-12 rounded-xl border border-slate-300 bg-white px-5 text-base font-semibold text-slate-800 hover:bg-slate-50">
            {fighting ? 'Close dispute — accept deduction' : aw ? 'Final — accept the shortfall' : 'Accept deduction'}</button>
        </div>
      )}

      {mode === 'fight' && (
        <div className="mt-3 space-y-3 rounded-xl bg-white p-4">
          <p className="text-base font-semibold text-slate-900">Grounds for dispute</p>
          <div className="flex flex-wrap gap-2">
            {GROUNDS.map((g) => (
              <button key={g} type="button" onClick={() => setText(g)}
                className={`min-h-11 rounded-full border px-3 text-sm ${text === g ? 'border-amber-500 bg-amber-100 font-semibold' : 'border-slate-300 bg-white'}`}>{g}</button>
            ))}
          </div>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} className={`${field} py-2`} placeholder="Or enter the grounds" />
          <div className="flex flex-wrap gap-2">
            <button onClick={() => go('fight')} disabled={busy} className="min-h-12 rounded-xl bg-amber-500 px-5 text-base font-semibold text-white disabled:opacity-50">Raise dispute</button>
            <button onClick={() => { setMode(null); setError(''); }} className="min-h-12 rounded-xl px-4 text-base text-slate-600">Back</button>
          </div>
        </div>
      )}

      {mode === 'accept' && (
        <div className="mt-3 space-y-3 rounded-xl bg-white p-4">
          <p className="text-base font-semibold text-slate-900">Accept a deduction of {inr(cut.amount)}? It cannot be claimed later.</p>
          {shortfall > 1 && <label className="block text-base font-medium text-slate-800">Deduction reason *
            <select value={cat} onChange={(e) => setCat(e.target.value)} className={field}>
              <option value="">Choose…</option>
              {Object.entries(DISALLOWANCE_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select></label>}
          <input value={text} onChange={(e) => setText(e.target.value)} className={field} placeholder="Remarks (optional) — e.g. appeal declined" />
          <div className="flex flex-wrap gap-2">
            <button onClick={() => go('accept')} disabled={busy} className="min-h-12 rounded-xl bg-slate-700 px-5 text-base font-semibold text-white disabled:opacity-50">Confirm & accept</button>
            <button onClick={() => { setMode(null); setError(''); }} className="min-h-12 rounded-xl px-4 text-base text-slate-600">Back</button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-3 rounded-lg bg-rose-100 p-3 text-base text-rose-800">{error}</p>}
    </div>
  );
}
