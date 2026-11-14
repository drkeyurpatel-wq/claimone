'use client';
// After a payment file is saved: what it cleared, and what is still pending and where it stands.
import Link from 'next/link';
import { CHASE_AFTER_DAYS, type Outcome } from '@/lib/recon/pending';
import { inr, inrShort } from '@/components/ui';

const n = (x: number) => x.toLocaleString('en-IN');

export function UploadOutcome({ o }: { o: Outcome }) {
  const b = o.before1Nov; const oldMoved = b.filesBefore !== b.filesAfter || Math.abs(b.amountBefore - b.amountAfter) > 1;
  const who = o.changed.length === 1 ? o.changed[0].name : o.changed.length > 1 ? `${o.changed.length} payers` : '';
  const rows: { label: string; note?: string; files: number; amount: number; tone?: string }[] = [
    { label: 'Approved, payment awaited', files: o.awaited.files, amount: o.awaited.amount },
    { label: 'Claim submitted, not paid yet', files: o.submitted.files, amount: o.submitted.amount,
      note: o.chase.files ? `${n(o.chase.files)} of these (${inr(o.chase.amount)}) are over ${CHASE_AFTER_DAYS} days since discharge — follow up` : undefined, tone: o.chase.files ? 'text-rose-700' : undefined },
    { label: 'Deduction disputed', files: o.disputed.files, amount: o.disputed.amount },
    { label: 'Bills not on Master, unpaid or part-paid', files: o.old.files, amount: o.old.amount },
  ].filter((r) => r.files > 0);

  return (
    <div className="mt-2 rounded-xl border border-emerald-200 bg-white p-4 text-slate-900">
      {o.changed.length > 0 ? (
        <>
          <p className="text-lg font-semibold">
            Pending bills{who ? ` — ${who}` : ''}: {n(o.billsBefore)} → {n(o.billsAfter)}
            <span className="font-normal text-slate-600"> · {inrShort(o.amountBefore)} → {inrShort(o.amountAfter)}</span>
          </p>
          {o.changed.length > 1 && <ul className="mt-1 text-base text-slate-700">
            {o.changed.slice(0, 6).map((c) => <li key={c.payer}>{c.name}: {n(c.billsBefore)} → {n(c.billsAfter)} · {inrShort(c.amountBefore)} → {inrShort(c.amountAfter)}</li>)}
          </ul>}
          {o.archived > 0 && <p className="mt-1 text-base"><b>{n(o.archived)}</b> files paid and moved to Archive</p>}
        </>
      ) : (
        <p className="text-lg font-semibold">{oldMoved ? 'No pending bill from 1 Nov onwards changed' : 'No pending bill changed'}{!oldMoved && <span className="font-normal text-slate-600"> — every payment in this file was already saved.</span>}</p>
      )}

      {o.total.files > 0 ? (
        <table className="mt-3 w-full border-collapse text-base">
          <thead><tr className="border-b border-slate-200 text-left text-sm uppercase tracking-wide text-slate-500">
            <th className="py-1.5 font-semibold">Still pending — files from 1 Nov</th><th className="py-1.5 text-right font-semibold">Files</th><th className="py-1.5 text-right font-semibold">Amount</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-b border-slate-100 align-top">
                <td className="py-1.5">{r.label}{r.note && <span className={`block text-sm font-medium ${r.tone ?? 'text-slate-500'}`}>{r.note}</span>}</td>
                <td className="py-1.5 text-right">{n(r.files)}</td><td className="py-1.5 text-right">{inr(r.amount)}</td></tr>
            ))}
            <tr className="font-bold"><td className="py-1.5">Total still to come</td><td className="py-1.5 text-right">{n(o.total.files)}</td><td className="py-1.5 text-right">{inr(o.total.amount)}</td></tr>
          </tbody>
        </table>
      ) : <p className="mt-2 text-base font-semibold text-emerald-800">Nothing pending on files from 1 Nov.</p>}

      {(b.filesBefore > 0 || b.filesAfter > 0) && <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-base text-slate-700">
        <Link href="/before" className="font-semibold text-teal-700 underline">Before 1 Nov</Link>: {oldMoved
          ? <>{n(b.filesBefore)} → <b>{n(b.filesAfter)}</b> files pending · {inrShort(b.amountBefore)} → <b>{inrShort(b.amountAfter)}</b></>
          : <>{n(b.filesAfter)} files pending · {inrShort(b.amountAfter)} — not changed by this file</>}
      </p>}

      <p className="mt-3 flex flex-wrap gap-4 text-base">
        <Link href="/master" className="font-semibold text-teal-700 underline">Open Master</Link>
        <Link href="/claims/mis" className="font-semibold text-teal-700 underline">Money owed</Link>
        <Link href="/claims/leakage" className="font-semibold text-teal-700 underline">Deductions</Link>
      </p>
    </div>
  );
}
