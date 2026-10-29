'use client';
// Settings → Payer master. The list the admission form offers, by category.
// Rename, move to another category, mark inactive (never deleted — cases point at it).
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Loader2, Plus, Search, Check } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import { fetchPayerMaster, addPayer, savePayer } from '@/lib/rcm/api';
import { payerGroup, PAYER_GROUPS, type PayerGroup } from '@/lib/rcm/payer';
import type { Payer } from '@/lib/claims/types';
import { useToast } from '@/components/ui';

const input = 'min-h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100';

function Row({ p, onSaved, flash }: { p: Payer; onSaved: () => void; flash: (m: string, t?: 'ok' | 'err') => void }) {
  const [name, setName] = useState(p.name);
  const [group, setGroup] = useState<PayerGroup>(payerGroup(p));
  const [active, setActive] = useState(p.is_active);
  const [busy, setBusy] = useState(false);
  const dirty = name.trim() !== p.name || group !== payerGroup(p) || active !== p.is_active;
  const save = async () => {
    if (name.trim().length < 3) { flash('Enter the full payer name.', 'err'); return; }
    setBusy(true);
    try { await savePayer(p.id, name, group, active); flash('Payer updated'); onSaved(); }
    catch (e) { flash((e as Error).message, 'err'); }
    setBusy(false);
  };
  return (
    <tr className={`border-b border-slate-100 last:border-0 ${active ? '' : 'bg-slate-50 text-slate-500'}`}>
      <td className="p-2"><input value={name} onChange={(e) => setName(e.target.value)} className={input} aria-label="Payer name" /></td>
      <td className="w-56 p-2">
        <select value={group} onChange={(e) => setGroup(e.target.value as PayerGroup)} className={input} aria-label="Category">
          {PAYER_GROUPS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
        </select>
      </td>
      <td className="w-32 p-2">
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="h-4 w-4 accent-teal-600" /> {active ? 'Active' : 'Inactive'}
        </label>
      </td>
      <td className="w-28 p-2 text-right">
        {dirty && <button type="button" onClick={save} disabled={busy}
          className="inline-flex min-h-10 items-center gap-1 rounded-lg bg-teal-600 px-3 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Save</button>}
      </td>
    </tr>
  );
}

export default function SettingsPage() {
  const role = useAuthStore((s) => s.staff?.role);
  const canEdit = role === 'admin' || role === 'manager';
  const { flash, toastNode } = useToast();
  const [payers, setPayers] = useState<Payer[] | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<PayerGroup>('tpa');
  const [q, setQ] = useState('');
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try { setPayers(await fetchPayerMaster()); setError(''); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const counts = useMemo(() => Object.fromEntries(PAYER_GROUPS.map((g) => [g.key, (payers ?? []).filter((p) => payerGroup(p) === g.key).length])), [payers]);
  const rows = useMemo(() => (payers ?? [])
    .filter((p) => payerGroup(p) === tab)
    .filter((p) => !q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => Number(b.is_active) - Number(a.is_active) || a.name.localeCompare(b.name)), [payers, tab, q]);

  const add = async () => {
    if (newName.trim().length < 3) { flash('Enter the full payer name.', 'err'); return; }
    setAdding(true);
    try { await addPayer(newName, tab); setNewName(''); flash('Payer added'); await load(); }
    catch (e) { flash((e as Error).message, 'err'); }
    setAdding(false);
  };

  if (!canEdit) {
    return <div className="py-20 text-center text-base text-slate-500">Settings are available to admins and managers. <Link href="/master" className="text-teal-700 underline">Back to Master</Link></div>;
  }
  const label = PAYER_GROUPS.find((g) => g.key === tab)!.label;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 md:px-6">
      {toastNode}
      <h1 className="text-2xl font-bold text-slate-900">Settings</h1>
      <h2 className="mt-4 text-lg font-semibold text-slate-900">Payer master</h2>
      <p className="mt-1 text-base text-slate-600">The payers offered on a new admission. Rename, change category or mark inactive; inactive payers stay on past cases but are no longer offered.</p>

      <div role="tablist" className="mt-4 flex flex-wrap gap-2">
        {PAYER_GROUPS.map((g) => (
          <button key={g.key} type="button" role="tab" aria-selected={tab === g.key} onClick={() => { setTab(g.key); setQ(''); }}
            className={`min-h-11 rounded-full border px-4 text-sm font-medium ${tab === g.key ? 'border-teal-600 bg-teal-600 text-white' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'}`}>
            {g.label} <span className="ml-1 opacity-80">{payers ? counts[g.key] : ''}</span>
          </button>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="flex flex-1 gap-2">
          <input value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
            placeholder={`New ${label.toLowerCase()} name`} aria-label="New payer name" className={`${input} max-w-sm`} />
          <button type="button" onClick={add} disabled={adding} className="inline-flex min-h-10 items-center gap-1 rounded-lg bg-teal-600 px-4 text-sm font-semibold text-white disabled:opacity-50">
            {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Add to {label}</button>
        </div>
        <label className="relative w-full sm:w-64">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search payers" aria-label="Search payers" className={`${input} pl-9`} />
        </label>
      </div>

      {error && <p role="alert" className="mt-4 rounded-lg bg-rose-50 p-3 text-base text-rose-800">{error}</p>}
      {!payers && !error && <div className="flex justify-center py-12"><Loader2 className="h-7 w-7 animate-spin text-teal-600" /></div>}
      {payers && (
        <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[640px] text-left">
            <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr><th className="px-3 py-2.5">Payer name</th><th className="px-3 py-2.5">Category</th><th className="px-3 py-2.5">Status</th><th /></tr>
            </thead>
            <tbody>
              {rows.length === 0
                ? <tr><td colSpan={4} className="p-8 text-center text-base text-slate-500">{q ? 'No payer matches this search.' : `No payers in ${label} yet — add one above.`}</td></tr>
                : rows.map((p) => <Row key={`${p.id}-${p.name}-${p.type}-${p.code}-${p.is_active}`} p={p} onSaved={load} flash={flash} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
