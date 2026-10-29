'use client';
// New admission: a cashless / credit patient becomes a new row on Master.
// Payer category first (one tap), then the payer from that category only.
import { useEffect, useMemo, useState } from 'react';
import { Loader2, UserPlus } from 'lucide-react';
import { createClaim } from '@/lib/claims/api';
import { fetchAllPayers, addPayer } from '@/lib/rcm/api';
import { claimTypeFor, groupAsPayer, payerGroup, PAYER_GROUPS, type PayerGroup } from '@/lib/rcm/payer';
import type { Payer } from '@/lib/claims/types';
import { Modal, field, label } from './Modal';

const NEW = '__new';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

export function AddPatient({ tenantId, centreId, onClose, onSaved }: {
  tenantId: string; centreId: string; onClose: () => void; onSaved: (id: string) => void;
}) {
  const [payers, setPayers] = useState<Payer[] | null>(null);
  const [group, setGroup] = useState<PayerGroup | ''>('');
  const [f, setF] = useState({ patient_name: '', admission_ref: '', payer_id: '', new_payer: '', admitted: today(), estimated_amount: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { fetchAllPayers().then(setPayers).catch(() => setPayers([])); }, []);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((x) => ({ ...x, [k]: e.target.value }));

  const inGroup = useMemo(() => (payers ?? []).filter((p) => group && payerGroup(p) === group), [payers, group]);
  const pickGroup = (g: PayerGroup) => {
    setGroup(g);
    const list = (payers ?? []).filter((p) => payerGroup(p) === g);
    // a category with a single payer needs no second choice
    setF((x) => ({ ...x, payer_id: list.length === 1 ? list[0].id : list.length === 0 ? NEW : '', new_payer: '' }));
    setError('');
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const isNew = f.payer_id === NEW;
    const payer = payers?.find((p) => p.id === f.payer_id);
    if (!f.patient_name.trim()) { setError('Enter the patient name.'); return; }
    if (!f.admission_ref.trim()) { setError('Enter the IP number.'); return; }
    if (!group) { setError('Select the payer category.'); return; }
    if (isNew && f.new_payer.trim().length < 3) { setError('Enter the full name of the new payer.'); return; }
    if (!isNew && !payer) { setError('Select the payer.'); return; }
    if (f.admitted > today()) { setError('Admission date cannot be in the future.'); return; }
    setBusy(true); setError('');
    try {
      const day = f.admitted || today();
      // a payer typed in is added to the payer list (or matched to one already there)
      const payerId = isNew ? await addPayer(f.new_payer, group) : payer!.id;
      const { id } = await createClaim({
        tenant_id: tenantId, centre_id: centreId, payer_id: payerId, claim_type: claimTypeFor(payer ?? groupAsPayer(group)),
        patient_name: f.patient_name.trim(), admission_ref: f.admission_ref.trim(),
        estimated_amount: f.estimated_amount ? Number(f.estimated_amount) : null,
        admitted_at: day === today() ? new Date().toISOString() : new Date(`${day}T12:00:00+05:30`).toISOString(),
        admission_date: day, case_source: 'manual',
      });
      onSaved(id);
    } catch (err) {
      const m = (err as Error).message;
      setError(/admission_uq|duplicate/i.test(m) ? 'This IP number already exists in Master.'
        : /payer/i.test(m) ? m : 'Could not save. Please check the details and try again.');
      setBusy(false);
    }
  };

  return (
    <Modal title="New admission" sub="Cashless and credit patients" onClose={onClose}>
      <form onSubmit={save} className="space-y-4" noValidate>
        <label className={label}>Patient name *<input value={f.patient_name} onChange={set('patient_name')} className={field} autoComplete="off" /></label>
        <div className="grid grid-cols-2 gap-3">
          <label className={label}>IP number *<input value={f.admission_ref} onChange={set('admission_ref')} className={field} placeholder="IPS…" autoComplete="off" /></label>
          <label className={label}>Admission date<input type="date" value={f.admitted} max={today()} onChange={set('admitted')} className={field} /></label>
        </div>

        <fieldset>
          <legend className="text-base font-medium text-slate-800">Payer category *</legend>
          <div role="radiogroup" className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {PAYER_GROUPS.map((g) => {
              const on = group === g.key;
              return (
                <button key={g.key} type="button" role="radio" aria-checked={on} onClick={() => pickGroup(g.key)} disabled={!payers}
                  className={`flex min-h-14 items-start gap-2 rounded-xl border px-3 py-2 text-left disabled:opacity-50 ${on ? 'border-teal-600 bg-teal-50 ring-1 ring-teal-600' : 'border-slate-300 bg-white hover:bg-slate-50'}`}>
                  <span className={`mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${on ? 'border-teal-600' : 'border-slate-400'}`}>
                    {on && <span className="h-2 w-2 rounded-full bg-teal-600" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-slate-900">{g.label}</span>
                    <span className="block text-xs text-slate-500">{g.hint}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>

        {group && (
          <div className="space-y-3">
            {inGroup.length > 0 && (
              <label className={label}>{PAYER_GROUPS.find((g) => g.key === group)!.label} — select payer *
                <select value={f.payer_id} onChange={set('payer_id')} className={field}>
                  <option value="">Select…</option>
                  {inGroup.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  <option value={NEW}>+ Other — not in the list</option>
                </select>
              </label>
            )}
            {f.payer_id === NEW && (
              <label className={label}>New {PAYER_GROUPS.find((g) => g.key === group)!.label.toLowerCase()} name *
                <input value={f.new_payer} onChange={set('new_payer')} className={field} autoComplete="off" placeholder="Full name as on the card / letter" autoFocus />
                <span className="mt-1 block text-sm font-normal text-slate-500">It is added to the payer list for next time.</span>
              </label>
            )}
          </div>
        )}

        <label className={label}>Estimated amount (₹)<input type="number" min="0" inputMode="numeric" value={f.estimated_amount} onChange={set('estimated_amount')} className={field} /></label>
        {error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-base text-rose-800">{error}</p>}
        <button type="submit" disabled={busy} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-teal-600 text-base font-bold text-white hover:bg-teal-700 disabled:opacity-50">
          {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <UserPlus className="h-5 w-5" />} Add to Master
        </button>
      </form>
    </Modal>
  );
}
