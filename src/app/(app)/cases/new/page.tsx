'use client';
// Add one patient by hand — for admissions not in the eCW file yet.
// When the hospital moves to its own HMIS, cases will come from there instead.
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Loader2, UserPlus, ArrowLeft } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import { createClaim } from '@/lib/claims/api';
import { fetchAllPayers } from '@/lib/rcm/api';
import type { Payer } from '@/lib/claims/types';
import { claimTypeFor } from '@/lib/rcm/payer';
import { NoCentre } from '@/components/ui';

const field = 'mt-1 min-h-12 w-full rounded-lg border border-slate-300 px-3 text-base focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100';

export default function NewCase() {
  const router = useRouter();
  const { activeCentreId: centreId, tenantId } = useAuthStore();
  const [payers, setPayers] = useState<Payer[]>([]);
  const [f, setF] = useState({ patient_name: '', admission_ref: '', patient_uhid: '', patient_phone: '', payer_id: '',
    admitted_at: '', treating_doctor_name: '', estimated_amount: '', policy_number: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { fetchAllPayers().then(setPayers); }, []);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((x) => ({ ...x, [k]: e.target.value }));

  if (!centreId || !tenantId) return <NoCentre />;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const payer = payers.find((p) => p.id === f.payer_id);
    if (!payer) { setError('Choose who pays.'); return; }
    setBusy(true); setError('');
    try {
      const at = f.admitted_at ? new Date(f.admitted_at) : new Date();
      const { id } = await createClaim({
        tenant_id: tenantId, centre_id: centreId, payer_id: payer.id, claim_type: claimTypeFor(payer),
        patient_name: f.patient_name.trim(), admission_ref: f.admission_ref.trim() || null,
        patient_uhid: f.patient_uhid.trim() || null, patient_phone: f.patient_phone.trim() || null,
        treating_doctor_name: f.treating_doctor_name.trim() || null, policy_number: f.policy_number.trim() || null,
        estimated_amount: f.estimated_amount ? Number(f.estimated_amount) : null,
        admitted_at: at.toISOString(), admission_date: f.admitted_at ? f.admitted_at.slice(0, 10) : new Date().toLocaleDateString('en-CA'), case_source: 'manual',
      });
      router.push(`/case/${id}`);
    } catch (err) {
      const m = (err as Error).message;
      setError(/admission_uq|duplicate/i.test(m) ? 'This IP No. is already in ClaimOne — search for it on the desk.' : 'Could not save. Check the details and try again.');
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-xl px-4 py-8 md:px-6">
      <Link href="/ledger" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Ledger</Link>
      <h1 className="mt-2 text-2xl font-bold text-slate-900">Add a patient</h1>
      <p className="mt-1 text-base text-slate-600">Only insurance, scheme or company patients. Cash patients are not needed here.</p>

      <form onSubmit={save} className="mt-6 space-y-4 rounded-2xl border border-slate-200 bg-white p-5">
        <label className="block text-base font-medium text-slate-800">Patient name *
          <input required value={f.patient_name} onChange={set('patient_name')} className={field} autoComplete="off" />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-base font-medium text-slate-800">IP No. *
            <input required value={f.admission_ref} onChange={set('admission_ref')} className={field} placeholder="IPS…" />
          </label>
          <label className="block text-base font-medium text-slate-800">UHID / Reg. No.
            <input value={f.patient_uhid} onChange={set('patient_uhid')} className={field} />
          </label>
        </div>
        <label className="block text-base font-medium text-slate-800">Who pays? *
          <select required value={f.payer_id} onChange={set('payer_id')} className={field}>
            <option value="">Choose…</option>
            {payers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-base font-medium text-slate-800">Admitted on
            <input type="datetime-local" value={f.admitted_at} onChange={set('admitted_at')} className={field} />
          </label>
          <label className="block text-base font-medium text-slate-800">Estimate (₹)
            <input type="number" min="0" inputMode="numeric" value={f.estimated_amount} onChange={set('estimated_amount')} className={field} />
          </label>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-base font-medium text-slate-800">Doctor
            <input value={f.treating_doctor_name} onChange={set('treating_doctor_name')} className={field} />
          </label>
          <label className="block text-base font-medium text-slate-800">Mobile
            <input type="tel" value={f.patient_phone} onChange={set('patient_phone')} className={field} />
          </label>
        </div>
        <label className="block text-base font-medium text-slate-800">Policy / card no.
          <input value={f.policy_number} onChange={set('policy_number')} className={field} />
        </label>
        {error && <p role="alert" className="rounded-lg bg-rose-50 p-3 text-base text-rose-800">{error}</p>}
        <button disabled={busy} className="flex min-h-14 w-full items-center justify-center gap-2 rounded-xl bg-teal-600 text-lg font-bold text-white hover:bg-teal-700 disabled:opacity-40">
          {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : <UserPlus className="h-5 w-5" />} Save patient
        </button>
      </form>
    </div>
  );
}
