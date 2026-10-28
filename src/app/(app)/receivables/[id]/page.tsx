'use client';
// One bill: what was owed, what came in, every adjustment, and what is left.
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, Loader2, Undo2, Plus, Wallet } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import { fetchReceivable, addAdjustment, reverse, type ReceivableRow, type AllocationRow, type AdjustmentRow } from '@/lib/recon/api';
import { DISALLOWANCE_CATEGORIES } from '@/lib/engine/settlement';
import { inr, shortDate, dateTime, useToast, btn } from '@/components/ui';

const KIND: Record<string, string> = { tds: 'TDS', deduction: 'Payer deduction', discount: 'Discount', write_off: 'Write-off', refund_due: 'Refund owed', rounding: 'Rounding', financing_cost: 'Financing cost' };

export default function ReceivablePage() {
  const { id } = useParams<{ id: string }>();
  const role = useAuthStore((s) => s.staff?.role);
  const canWrite = role === 'admin' || role === 'manager' || role === 'desk';
  const isManager = role === 'admin' || role === 'manager';
  const { flash, toastNode } = useToast();
  const [rv, setRv] = useState<ReceivableRow | null>(null);
  const [allocs, setAllocs] = useState<(AllocationRow & { clm_receipts: { value_date: string; reference: string | null; narration: string | null; amount: number } | null })[]>([]);
  const [adjs, setAdjs] = useState<AdjustmentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<{ kind: string; amount: string; category: string; reason: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetchReceivable(id);
    setRv(r.receivable); setAllocs(r.allocations); setAdjs(r.adjustments); setLoading(false);
  }, [id]);
  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="flex min-h-[50vh] items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-teal-600" /></div>;
  if (!rv) return <div className="p-10 text-center text-sm text-slate-500">Bill not found. <Link href="/receivables" className="text-teal-700 underline">Back</Link></div>;

  const save = async () => {
    if (!form) return;
    setBusy(true);
    try {
      await addAdjustment(rv.id, { kind: form.kind, amount: Number(form.amount), category: form.kind === 'deduction' ? form.category : undefined, reason_text: form.reason || undefined });
      flash('Saved'); setForm(null); await load();
    } catch (e) { flash((e as Error).message, 'err'); }
    setBusy(false);
  };
  const undo = async (rid: string, table: 'allocation' | 'adjustment') => {
    const reason = window.prompt?.('Why is this being reversed?') ?? '';
    if (!reason || reason.trim().length < 3) { flash('Write a reason to reverse it', 'err'); return; }
    try { await reverse(rid, reason, table); flash('Reversed'); await load(); } catch (e) { flash((e as Error).message, 'err'); }
  };

  const kinds = Object.keys(KIND).filter((k) => k !== 'write_off' || isManager);
  const lines: [string, number, string][] = [
    ['Owed', rv.expected_amount, 'text-slate-900'], ['Received', -rv.allocated, 'text-emerald-700'], ['TDS', -rv.tds, 'text-slate-600'],
    ['Payer deductions', -rv.deduction, 'text-rose-700'], ['Discount', -rv.discount, 'text-slate-600'], ['Written off', -rv.write_off, 'text-rose-700'],
    ['Refund owed back', -rv.refund_due, 'text-purple-700'], ['Other', -rv.other_adj, 'text-slate-600'],
  ];

  return (
    <div className="mx-auto max-w-5xl px-4 pb-10 pt-4 md:px-6">
      {toastNode}
      <Link href="/receivables" className="mb-3 inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800"><ArrowLeft className="h-3.5 w-3.5" /> Receivables</Link>
      <div className="mb-4 rounded-xl border border-slate-200 bg-white p-4">
        <h1 className="flex items-center gap-2 text-xl font-bold"><Wallet className="h-5 w-5 text-teal-600" /> {rv.patient_name ?? rv.debtor_name}</h1>
        <p className="mt-1 text-xs text-slate-500">
          {rv.debtor_name} ({rv.debtor_type}) · bill {rv.bill_no ?? '—'} · {shortDate(rv.bill_date)} · {rv.age_days} days
          {rv.claim_ref ? ` · claim ${rv.claim_ref}` : ''}{rv.care_of ? ` · ${rv.care_of}` : ''}
          {rv.claim_id && <> · <Link href={`/case/${rv.claim_id}`} className="text-teal-700 underline">open patient file</Link></>}
        </p>
        {rv.recorded_utr && <p className="mt-1 text-xs text-slate-500">UTR recorded by the team: <span className="font-mono">{rv.recorded_utr}</span></p>}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Balance</h2>
          <table className="w-full text-sm"><tbody>
            {lines.filter(([k, v]) => k === 'Owed' || Math.abs(v) > 0).map(([k, v, c]) => (
              <tr key={k}><td className="py-1 text-slate-600">{k}</td><td className={`tabular py-1 text-right ${c}`}>{inr(v)}</td></tr>
            ))}
            <tr className="border-t border-slate-900"><td className="py-1.5 font-bold">Still owed</td><td className="tabular py-1.5 text-right font-bold">{inr(rv.balance)}</td></tr>
          </tbody></table>
        </div>

        <div className="space-y-4 md:col-span-2">
          <section className="rounded-xl border border-slate-200 bg-white p-4">
            <h2 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">Money received</h2>
            {allocs.length === 0 ? <p className="text-sm text-slate-400">Nothing matched yet. Use Reconcile after importing the bank statement.</p> : (
              <ul className="divide-y divide-slate-100 text-sm">
                {allocs.map((a) => (
                  <li key={a.id} className={`flex flex-wrap items-center gap-2 py-2 ${a.reversed_at ? 'opacity-50' : ''}`}>
                    <span className="tabular w-28 font-semibold">{inr(a.amount)}</span>
                    <span className="text-xs text-slate-500">{shortDate(a.clm_receipts?.value_date)} · {a.clm_receipts?.reference ?? 'no ref'} · {a.method}</span>
                    {a.reversed_at ? <span className="text-xs text-rose-600">reversed: {a.reverse_reason}</span>
                      : canWrite && <button onClick={() => undo(a.id, 'allocation')} className="ml-auto inline-flex items-center gap-1 text-xs text-slate-500 hover:text-rose-600"><Undo2 className="h-3 w-3" /> Reverse</button>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-xs font-bold uppercase tracking-wider text-slate-500">Adjustments</h2>
              {canWrite && !form && <button onClick={() => setForm({ kind: 'deduction', amount: rv.balance > 0 ? String(rv.balance) : '', category: 'non_payable', reason: '' })} className={btn.ghost}><Plus className="h-3.5 w-3.5" /> Add</button>}
            </div>
            {form && (
              <div className="mb-3 grid gap-2 rounded-lg bg-slate-50 p-3 md:grid-cols-4">
                <select aria-label="Kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} className="rounded border border-slate-200 px-2 py-1.5 text-xs">
                  {kinds.map((k) => <option key={k} value={k}>{KIND[k]}</option>)}
                </select>
                <input aria-label="Amount" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="₹" className="rounded border border-slate-200 px-2 py-1.5 text-xs tabular" />
                {form.kind === 'deduction' ? (
                  <select aria-label="Reason" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="rounded border border-slate-200 px-2 py-1.5 text-xs">
                    {Object.entries(DISALLOWANCE_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                  </select>
                ) : <span />}
                <input aria-label="Note" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })}
                  placeholder={form.kind === 'write_off' ? 'Why written off (required)' : form.kind === 'deduction' ? "Payer's reason (required)" : 'Note'} className="rounded border border-slate-200 px-2 py-1.5 text-xs md:col-span-3" />
                <div className="flex gap-2">
                  <button disabled={busy || !(Number(form.amount) > 0)} onClick={save} className="rounded bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">Save</button>
                  <button onClick={() => setForm(null)} className="text-xs text-slate-500">Cancel</button>
                </div>
              </div>
            )}
            {adjs.length === 0 ? <p className="text-sm text-slate-400">None.</p> : (
              <ul className="divide-y divide-slate-100 text-sm">
                {adjs.map((a) => (
                  <li key={a.id} className={`flex flex-wrap items-center gap-2 py-2 ${a.reversed_at ? 'opacity-50 line-through' : ''}`}>
                    <span className="w-32 font-medium">{KIND[a.kind] ?? a.kind}</span>
                    <span className="tabular w-24 text-right">{inr(Math.abs(Number(a.amount)))}</span>
                    <span className="text-xs text-slate-500">{a.category ? `${DISALLOWANCE_CATEGORIES[a.category as keyof typeof DISALLOWANCE_CATEGORIES]?.label ?? a.category} · ` : ''}{a.reason_text ?? ''} · {dateTime(a.created_at)}</span>
                    {!a.reversed_at && canWrite && <button onClick={() => undo(a.id, 'adjustment')} className="ml-auto inline-flex items-center gap-1 text-xs text-slate-500 hover:text-rose-600"><Undo2 className="h-3 w-3" /> Reverse</button>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
