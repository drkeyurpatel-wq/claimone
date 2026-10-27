'use client';
// Settlement entry: approved, TDS, net, UTR and itemised deductions.
// The same arithmetic runs here (live) and in the database (final say).
import { useMemo, useState } from 'react';
import { IndianRupee, Plus, Trash2, Loader2 } from 'lucide-react';
import type { Claim } from '@/lib/claims/types';
import { checkSettlement, DISALLOWANCE_CATEGORIES, type DisallowanceCategory } from '@/lib/engine/settlement';
import { recordSettlement } from '@/lib/claims/api';
import { inr, btn } from '@/components/ui';

const today = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);

export function SettlementForm({ claim, onDone, flash }: { claim: Claim; onDone: () => Promise<void>; flash: (m: string, t?: 'ok' | 'err') => void }) {
  const claimed = Number(claim.claimed_amount ?? claim.estimated_amount ?? 0);
  const [approved, setApproved] = useState(String(claim.approved_amount ?? ''));
  const [tds, setTds] = useState('0');
  const [net, setNet] = useState('');
  const [utr, setUtr] = useState('');
  const [date, setDate] = useState(today());
  const [mode, setMode] = useState('neft');
  const [items, setItems] = useState<{ category: DisallowanceCategory; amount: string; reason_text: string }[]>([]);
  const [saving, setSaving] = useState(false);

  const num = (s: string) => (s.trim() === '' ? NaN : Number(s));
  const check = useMemo(() => checkSettlement({
    claimed, approved: num(approved) || 0, tds: num(tds) || 0,
    net: net.trim() === '' ? (num(approved) || 0) - (num(tds) || 0) : num(net),
    items: items.map((i) => ({ category: i.category, amount: num(i.amount) || 0 })),
  }), [claimed, approved, tds, net, items]);

  const save = async () => {
    setSaving(true);
    try {
      await recordSettlement(claim.id, {
        approved: num(approved), tds: num(tds) || 0,
        net: net.trim() === '' ? check.expectedNet : num(net),
        utr: utr.trim(), payment_date: date, payment_mode: mode,
        items: items.map((i) => ({ category: i.category, amount: num(i.amount) || 0, reason_text: i.reason_text || undefined })),
      });
      flash('Settlement recorded');
      await onDone();
    } catch (e) { flash((e as Error).message, 'err'); }
    setSaving(false);
  };

  const field = 'mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm tabular focus:border-teal-500 focus:outline-none';
  const label = 'text-[10px] font-semibold uppercase tracking-wider text-slate-500';

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">
      <h3 className="mb-1 text-sm font-bold text-slate-900">Record settlement</h3>
      <p className="mb-4 text-xs text-slate-500">Claimed {inr(claimed)}. Enter the figures from the payer's settlement advice.</p>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <div><label className={label}>Approved (₹) *</label><input className={field} inputMode="decimal" value={approved} onChange={(e) => setApproved(e.target.value)} /></div>
        <div><label className={label}>TDS deducted (₹)</label><input className={field} inputMode="decimal" value={tds} onChange={(e) => setTds(e.target.value)} /></div>
        <div><label className={label}>Net received (₹)</label><input className={field} inputMode="decimal" value={net} placeholder={inr(check.expectedNet)} onChange={(e) => setNet(e.target.value)} /></div>
        <div><label className={label}>UTR *</label><input className={`${field} font-mono`} value={utr} onChange={(e) => setUtr(e.target.value)} /></div>
        <div><label className={label}>Payment date *</label><input type="date" className={field} value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div><label className={label}>Mode</label>
          <select className={field} value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="neft">NEFT</option><option value="rtgs">RTGS</option><option value="imps">IMPS</option><option value="cheque">Cheque</option><option value="other">Other</option>
          </select>
        </div>
      </div>

      <div className="mt-5 rounded-lg bg-slate-50 p-3">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold text-slate-700">Deduction {inr(check.deduction)} — where did it go?</p>
          <button className="inline-flex items-center gap-1 text-xs font-semibold text-teal-700" onClick={() => setItems([...items, { category: 'non_payable', amount: '', reason_text: '' }])}>
            <Plus className="h-3 w-3" /> Add line
          </button>
        </div>
        {items.map((it, i) => (
          <div key={i} className="mt-2 grid grid-cols-12 gap-2">
            <select className="col-span-4 rounded border border-slate-200 px-2 py-1.5 text-xs" value={it.category}
              onChange={(e) => setItems(items.map((x, j) => j === i ? { ...x, category: e.target.value as DisallowanceCategory } : x))}>
              {Object.entries(DISALLOWANCE_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <input className="col-span-3 rounded border border-slate-200 px-2 py-1.5 text-xs tabular" inputMode="decimal" placeholder="₹" value={it.amount}
              onChange={(e) => setItems(items.map((x, j) => j === i ? { ...x, amount: e.target.value } : x))} />
            <input className="col-span-4 rounded border border-slate-200 px-2 py-1.5 text-xs" placeholder="Payer's reason" value={it.reason_text}
              onChange={(e) => setItems(items.map((x, j) => j === i ? { ...x, reason_text: e.target.value } : x))} />
            <button className="col-span-1 text-slate-400 hover:text-rose-600" aria-label="Remove line" onClick={() => setItems(items.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></button>
          </div>
        ))}
        {items.length === 0 && check.deduction > 0 && <p className="mt-1 text-[11px] text-slate-500">Split the deduction by reason so the leakage report can show where money is lost.</p>}
      </div>

      {check.errors.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-rose-600">{check.errors.map((e) => <li key={e}>{e}</li>)}</ul>
      )}
      <button onClick={save} disabled={saving || !check.ok || approved.trim() === '' || utr.trim().length < 4}
        className={`${btn.primary} mt-4 bg-emerald-600 hover:bg-emerald-700`}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <IndianRupee className="h-4 w-4" />} Record settlement
      </button>
    </div>
  );
}
