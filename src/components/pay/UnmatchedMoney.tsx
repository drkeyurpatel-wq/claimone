'use client';
// To check, part 1: bank money ClaimOne could not tie to a bill on its own.
// A suggested bill is confirmed with one tap; otherwise the desk picks the bill.
import { useMemo, useState } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import type { Open } from '@/lib/recon/auto';
import { confirmMatches, manualMatch, type ReceivableRow } from '@/lib/recon/api';
import { inr, shortDate } from '@/components/ui';

export function UnmatchedMoney({ open, canWrite, onChanged, flash }: {
  open: Open; canWrite: boolean; onChanged: () => void; flash: (t: string, tone?: 'ok' | 'err') => void;
}) {
  const { bills, receipts, result } = open;
  const [busy, setBusy] = useState('');
  const [pick, setPick] = useState<Record<string, string>>({});
  const [find, setFind] = useState<Record<string, string>>({});
  const billById = useMemo(() => new Map(bills.map((b) => [b.id, b])), [bills]);
  const suggested = useMemo(() => new Map(result.proposals.map((p) => [p.receipt_id, p])), [result]);
  const fits = useMemo(() => new Map(result.ambiguous.map((a) => [a.receipt_id, a.candidates])), [result]);

  const label = (b: ReceivableRow) => `${b.patient_name ?? '—'} · ${b.debtor_name} · ${inr(b.balance)} due`;
  const confirm = async (receiptId: string) => {
    const p = suggested.get(receiptId); if (!p) return;
    setBusy(receiptId);
    try { await confirmMatches([p]); flash('Matched'); onChanged(); } catch (e) { flash((e as Error).message, 'err'); }
    setBusy('');
  };
  const match = async (receiptId: string, amount: number) => {
    const bill = pick[receiptId]; if (!bill) return;
    setBusy(receiptId);
    try { await manualMatch(receiptId, bill, Math.min(amount, billById.get(bill)?.balance ?? amount)); flash('Matched'); onChanged(); }
    catch (e) { flash((e as Error).message, 'err'); }
    setBusy('');
  };

  return (
    <ul className="divide-y divide-slate-100">
      {receipts.map((r) => {
        const s = suggested.get(r.id);
        const sb = s ? billById.get(s.receivable_id) : undefined;
        const q = (find[r.id] ?? '').trim().toLowerCase();
        const cands = fits.get(r.id);
        const options = (cands?.length ? cands.map((id) => billById.get(id)!).filter(Boolean) : bills)
          .filter((b) => !q || [b.patient_name, b.debtor_name, b.claim_ref, b.bill_no].some((v) => v?.toLowerCase().includes(q)))
          .slice(0, 200);
        return (
          <li key={r.id} className="space-y-2 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-base"><b className="tabular">{inr(r.unallocated)}</b> <span className="text-slate-600">received {shortDate(r.value_date)}</span>{r.reference && <span className="text-slate-500"> · {r.reference}</span>}</p>
            </div>
            {r.narration && <p className="truncate text-sm text-slate-500" title={r.narration}>{r.narration}</p>}
            {canWrite && (s && sb ? (
              <div className="flex flex-wrap items-center gap-2 rounded-lg bg-teal-50 p-3">
                <span className="text-base text-teal-900">Looks like <b>{sb.patient_name ?? sb.claim_ref ?? 'this bill'}</b> · {sb.debtor_name}</span>
                <button onClick={() => confirm(r.id)} disabled={!!busy}
                  className="ml-auto inline-flex min-h-11 items-center gap-2 rounded-lg bg-teal-600 px-4 text-base font-semibold text-white hover:bg-teal-700 disabled:opacity-50">
                  {busy === r.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Yes, match
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <input value={find[r.id] ?? ''} onChange={(e) => setFind((x) => ({ ...x, [r.id]: e.target.value }))} placeholder="Type patient or payer"
                  aria-label="Find the bill" className="min-h-11 w-44 rounded-lg border border-slate-300 px-3 text-base" />
                <select value={pick[r.id] ?? ''} onChange={(e) => setPick((x) => ({ ...x, [r.id]: e.target.value }))} aria-label="Bill"
                  className="min-h-11 min-w-0 flex-1 rounded-lg border border-slate-300 px-2 text-base">
                  <option value="">{cands?.length ? `${cands.length} bills fit — choose` : 'Choose the bill…'}</option>
                  {options.map((b) => <option key={b.id} value={b.id}>{label(b)}</option>)}
                </select>
                <button onClick={() => match(r.id, r.unallocated)} disabled={!pick[r.id] || !!busy}
                  className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-teal-600 px-4 text-base font-semibold text-white hover:bg-teal-700 disabled:opacity-40">
                  {busy === r.id && <Loader2 className="h-4 w-4 animate-spin" />} Match
                </button>
              </div>
            ))}
          </li>
        );
      })}
    </ul>
  );
}
