'use client';
// Reconcile: the engine proposes which bank receipt pays which bill; a person
// ticks and confirms. Nothing is saved until "Confirm".
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { GitMerge, Loader2, ArrowLeft, CheckCircle2, AlertTriangle, Banknote } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import { proposeMatches, type MatchResult, type Proposal } from '@/lib/recon/match';
import { fetchReceivables, fetchReceipts, fetchUnusedAdvice, toOpenReceivable, toOpenReceipt, confirmMatches, manualMatch,
  type ReceivableRow, type ReceiptRow } from '@/lib/recon/api';
import { PageHeader, NoCentre, Skeleton, StatCard, inr, inrShort, shortDate, useToast, btn } from '@/components/ui';

const METHOD: Record<string, string> = { advice: 'Settlement advice', utr: 'UTR on bill', amount: 'Same amount', bulk: 'Bulk payment', manual: 'Manual' };

export default function Reconcile() {
  const centreId = useAuthStore((s) => s.activeCentreId);
  const role = useAuthStore((s) => s.staff?.role);
  const canWrite = role === 'admin' || role === 'manager' || role === 'desk';
  const { flash, toastNode } = useToast();
  const [bills, setBills] = useState<ReceivableRow[]>([]);
  const [receipts, setReceipts] = useState<ReceiptRow[]>([]);
  const [result, setResult] = useState<MatchResult | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [manual, setManual] = useState<{ receipt: string; bill: string; amount: string } | null>(null);

  const load = useCallback(async () => {
    if (!centreId) return;
    setLoading(true);
    const [b, r, a] = await Promise.all([fetchReceivables(centreId, { openOnly: true }), fetchReceipts(centreId, { unallocatedOnly: true }), fetchUnusedAdvice(centreId)]);
    const openBills = b.filter((x) => x.balance > 1);
    setBills(openBills); setReceipts(r);
    const res = proposeMatches(openBills.map(toOpenReceivable), r.map(toOpenReceipt), a);
    setResult(res);
    setPicked(new Set(res.proposals.map((p, i) => (p.confidence === 'high' ? i : -1)).filter((i) => i >= 0)));
    setLoading(false);
  }, [centreId]);
  useEffect(() => { load(); }, [load]);

  const billById = useMemo(() => new Map(bills.map((b) => [b.id, b])), [bills]);
  const rcById = useMemo(() => new Map(receipts.map((r) => [r.id, r])), [receipts]);

  if (!centreId) return <NoCentre />;

  const confirm = async () => {
    if (!result) return;
    const items: Proposal[] = result.proposals.filter((_, i) => picked.has(i));
    if (!items.length) return;
    setSaving(true);
    try { const r = await confirmMatches(items); flash(`${r.saved} matches saved`); await load(); }
    catch (e) { flash((e as Error).message, 'err'); }
    setSaving(false);
  };

  const saveManual = async () => {
    if (!manual) return;
    const amt = Number(manual.amount);
    if (!(amt > 0)) { flash('Enter an amount', 'err'); return; }
    setSaving(true);
    try { await manualMatch(manual.receipt, manual.bill, amt); flash('Matched'); setManual(null); await load(); }
    catch (e) { flash((e as Error).message, 'err'); }
    setSaving(false);
  };

  const groups: [string, number[]][] = result ? [
    ['Strong evidence', result.proposals.map((p, i) => (p.confidence === 'high' ? i : -1)).filter((i) => i >= 0)],
    ['Check before confirming', result.proposals.map((p, i) => (p.confidence === 'medium' ? i : -1)).filter((i) => i >= 0)],
  ] : [];
  const pickedTotal = result ? result.proposals.filter((_, i) => picked.has(i)).reduce((s, p) => s + p.amount, 0) : 0;
  const unmatched = result ? result.unmatchedReceipts.map((id) => rcById.get(id)!).filter(Boolean) : [];

  return (
    <div>
      {toastNode}
      <PageHeader title="Reconcile" sub="Match bank receipts to bills. Strong matches are ticked; check the rest before confirming." icon={GitMerge}>
        <Link href="/receivables" className={btn.ghost}><ArrowLeft className="h-3.5 w-3.5" /> Receivables</Link>
        {canWrite && <button onClick={confirm} disabled={saving || picked.size === 0} className={btn.primary}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Confirm {picked.size} ({inrShort(pickedTotal)})
        </button>}
      </PageHeader>

      {loading || !result ? <div className="p-6"><Skeleton rows={10} /></div> : (
        <div className="space-y-4 px-6 py-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="Receipts to match" value={receipts.length} sub={inrShort(receipts.reduce((s, r) => s + r.unallocated, 0))} icon={Banknote} />
            <StatCard label="Proposed" value={result.proposals.length} sub={inrShort(result.proposals.reduce((s, p) => s + p.amount, 0))} icon={GitMerge} tone="teal" />
            <StatCard label="Two bills fit" value={result.ambiguous.length} sub="choose by hand" icon={AlertTriangle} tone="amber" />
            <StatCard label="No match found" value={result.unmatchedReceipts.length} sub="see below" icon={AlertTriangle} tone="rose" />
          </div>

          {receipts.length === 0 && (
            <div className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-600">
              No unmatched receipts. <Link href="/receivables/import" className="font-semibold text-teal-700 underline">Import a bank statement</Link> to start.
            </div>
          )}

          {groups.map(([title, idx]) => idx.length > 0 && (
            <section key={title} className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
              <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                <h2 className="text-sm font-bold text-slate-900">{title} · {idx.length}</h2>
                <button className="text-xs font-semibold text-teal-700" onClick={() => {
                  const all = idx.every((i) => picked.has(i)); const n = new Set(picked);
                  idx.forEach((i) => (all ? n.delete(i) : n.add(i))); setPicked(n);
                }}>{idx.every((i) => picked.has(i)) ? 'Untick all' : 'Tick all'}</button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                    <th className="w-8 px-3 py-2" /><th className="px-3 py-2">Receipt</th><th className="px-3 py-2">Bill</th><th className="px-3 py-2">Evidence</th>
                    <th className="px-3 py-2 text-right">Owed</th><th className="px-3 py-2 text-right">Apply</th><th className="px-3 py-2">Result</th>
                  </tr></thead>
                  <tbody>
                    {idx.map((i) => {
                      const p = result.proposals[i]; const b = billById.get(p.receivable_id); const r = rcById.get(p.receipt_id);
                      return (
                        <tr key={i} className="border-t border-slate-100 align-top">
                          <td className="px-3 py-2.5"><input type="checkbox" aria-label="Confirm this match" checked={picked.has(i)} onChange={() => {
                            const n = new Set(picked); if (n.has(i)) n.delete(i); else n.add(i); setPicked(n); }} /></td>
                          <td className="px-3 py-2.5"><p className="tabular font-semibold">{inr(r?.amount)}</p><p className="text-[11px] text-slate-500">{shortDate(r?.value_date)} · {r?.reference ?? 'no ref'}</p>
                            <p className="max-w-[240px] truncate text-[11px] text-slate-400" title={r?.narration ?? ''}>{r?.narration}</p></td>
                          <td className="px-3 py-2.5"><p className="font-medium">{b?.patient_name ?? '—'}</p><p className="text-[11px] text-slate-500">{b?.debtor_name} · {b?.bill_no ?? b?.claim_ref}</p></td>
                          <td className="px-3 py-2.5 text-xs text-slate-600">{METHOD[p.method]}</td>
                          <td className="tabular px-3 py-2.5 text-right">{inr(b?.balance)}</td>
                          <td className="tabular px-3 py-2.5 text-right font-semibold">{inr(p.amount)}</td>
                          <td className="px-3 py-2.5 text-xs">
                            {p.adjustments.map((a, k) => <span key={k} className="mr-1 rounded bg-slate-100 px-1.5 py-0.5">{a.kind === 'tds' ? 'TDS' : a.kind} {inr(a.amount)}</span>)}
                            <span className={p.residual > 0 ? 'text-amber-700' : p.residual < 0 ? 'text-purple-700' : 'text-emerald-700'}>{p.note}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ))}

          {(result.ambiguous.length > 0 || unmatched.length > 0) && (
            <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
              <h2 className="border-b border-slate-100 px-4 py-3 text-sm font-bold text-slate-900">Match by hand</h2>
              <div className="divide-y divide-slate-100">
                {[...result.ambiguous.map((a) => ({ id: a.receipt_id, cands: a.candidates })), ...unmatched.map((r) => ({ id: r.id, cands: [] as string[] }))].map(({ id, cands }) => {
                  const r = rcById.get(id); if (!r) return null;
                  const options = cands.length ? cands.map((c) => billById.get(c)!).filter(Boolean)
                    : bills.filter((b) => b.balance > 1 && b.bill_date <= r.value_date).slice(0, 300);
                  return (
                    <div key={id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                      <div className="min-w-[220px] flex-1"><p className="tabular font-semibold">{inr(r.unallocated)} <span className="font-normal text-slate-500">on {shortDate(r.value_date)}</span></p>
                        <p className="truncate text-[11px] text-slate-500" title={r.narration ?? ''}>{r.narration}</p></div>
                      {cands.length > 0 && <span className="text-xs text-amber-700">{cands.length} bills fit</span>}
                      {canWrite && (manual?.receipt === id ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <select aria-label="Bill" value={manual.bill} onChange={(e) => setManual({ ...manual, bill: e.target.value })} className="max-w-xs rounded border border-slate-200 px-2 py-1 text-xs">
                            <option value="">Choose bill…</option>
                            {options.map((b) => <option key={b.id} value={b.id}>{b.patient_name} · {b.debtor_name} · {inr(b.balance)}</option>)}
                          </select>
                          <input aria-label="Amount" value={manual.amount} onChange={(e) => setManual({ ...manual, amount: e.target.value })} className="w-28 rounded border border-slate-200 px-2 py-1 text-xs tabular" />
                          <button disabled={!manual.bill || saving} onClick={saveManual} className="rounded bg-teal-600 px-2 py-1 text-xs font-semibold text-white disabled:opacity-50">Match</button>
                          <button onClick={() => setManual(null)} className="text-xs text-slate-500">Cancel</button>
                        </div>
                      ) : <button onClick={() => setManual({ receipt: id, bill: cands[0] ?? '', amount: String(r.unallocated) })} className="text-xs font-semibold text-teal-700">Match by hand</button>)}
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
