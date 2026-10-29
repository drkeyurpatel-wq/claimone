'use client';
// Add one insurance / scheme / company patient as a new ledger row.
import { useEffect, useState } from 'react';
import { Loader2, UserPlus } from 'lucide-react';
import { createClaim } from '@/lib/claims/api';
import { fetchAllPayers } from '@/lib/rcm/api';
import { claimTypeFor } from '@/lib/rcm/payer';
import type { Payer } from '@/lib/claims/types';
import { Modal, field, label } from './Modal';

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

export function AddPatient({ tenantId, centreId, onClose, onSaved }: {
  tenantId: string; centreId: string; onClose: () => void; onSaved: (id: string) => void;
}) {
  const [payers, setPayers] = useState<Payer[] | null>(null);
  const [f, setF] = useState({ patient_name: '', admission_ref: '', payer_id: '', admitted: today(), estimated_amount: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { fetchAllPayers().then(setPayers).catch(() => setPayers([])); }, []);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((x) => ({ ...x, [k]: e.target.value }));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const payer = payers?.find((p) => p.id === f.payer_id);
    if (!f.patient_name.trim()) { setError('Enter the patient name.'); return; }
    if (!f.admission_ref.trim()) { setError('Enter the IP No.'); return; }
    if (!payer) { setError('Choose who pays.'); return; }
    if (f.admitted > today()) { setError('Admission cannot be in the future.'); return; }
    setBusy(true); setError('');
    try {
      const day = f.admitted || today();
      const { id } = await createClaim({
        tenant_id: tenantId, centre_id: centreId, payer_id: payer.id, claim_type: claimTypeFor(payer),
        patient_name: f.patient_name.trim(), admission_ref: f.admission_ref.trim(),
        estimated_amount: f.estimated_amount ? Number(f.estimated_amount) : null,
        admitted_at: day === today() ? new Date().toISOString() : new Date(`${day}T12:00:00+05:30`).toISOString(),
        admission_date: day, case_source: 'manual',
      });
      onSaved(id);
    } catch (err) {
      const m = (err as Error).message;
      setError(/admission_uq|duplicate/i.test(m) ? 'This IP No. is already in Master — search for it.' : 'Could not save. Check the details and try again.');
      setBusy(false);
    }
  };

  return (
    <Modal title="Add patient" sub="Insurance, scheme or company patients only" onClose={onClose}>
      <form onSubmit={save} className="space-y-4" noValidate>
        <label className={label}>Patient name *<input value={f.patient_name} onChange={set('patient_name')} className={field} autoComplete="off" /></label>
        <div className="grid grid-cols-2 gap-3">
          <label className={label}>IP No. *<input value={f.admission_ref} onChange={set('admission_ref')} className={field} placeholder="IPS…" autoComplete="off" /></label>
          <label className={label}>Admitted on<input type="date" value={f.admitted} max={today()} onChange={set('admitted')} className={field} /></label>
        </div>
        <label className={label}>Who pays? *
          <select value={f.payer_id} onChange={set('payer_id')} className={field} disabled={!payers}>
            <option value="">{payers ? 'Choose…' : 'Loading…'}</option>
            {(payers ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></label>
        <label className={label}>Estimate (₹)<input type="number" min="0" inputMode="numeric" value={f.estimated_amount} onChange={set('estimated_amount')} className={field} /></label>
        {error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-base text-rose-800">{error}</p>}
        <button type="submit" disabled={busy} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-teal-600 text-base font-bold text-white hover:bg-teal-700 disabled:opacity-50">
          {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <UserPlus className="h-5 w-5" />} Add to Master
        </button>
      </form>
    </Modal>
  );
}
