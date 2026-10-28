'use client';
// The few details an NHCX pre-auth or claim needs that eCW does not give.
// Shown only for payers on NHCX; opens by itself when something is missing.
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { updateClaimFields } from '@/lib/claims/api';
import { nhcxMissing, type NhcxKind } from '@/lib/rcm/nhcx-case';
import type { Claim } from '@/lib/claims/types';

const field = 'mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 text-base focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100';

export function NhcxDetails({ c, kind, canWrite, onSaved }: { c: Claim; kind: NhcxKind; canWrite: boolean; onSaved: () => Promise<void> }) {
  const missing = nhcxMissing(c, kind);
  const [f, setF] = useState({
    patient_gender: c.patient_gender ?? '', patient_age_years: c.patient_age_years?.toString() ?? '', policy_number: c.policy_number ?? '',
    member_id: c.member_id ?? '', abha_id: c.abha_id ?? '', icd_code: c.icd_code ?? '', primary_diagnosis: c.primary_diagnosis ?? '',
    treating_doctor_hpr_id: c.treating_doctor_hpr_id ?? '', treatment_type: c.treatment_type ?? 'medical',
    package_code: c.package_code ?? '', package_name: c.package_name ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  const t = (s: string) => s.trim() || null;

  const save = async () => {
    setBusy(true); setMsg('');
    try {
      await updateClaimFields(c.id, {
        patient_gender: (f.patient_gender || null) as Claim['patient_gender'], patient_age_years: f.patient_age_years ? Number(f.patient_age_years) : null,
        policy_number: t(f.policy_number), member_id: t(f.member_id), abha_id: t(f.abha_id), icd_code: t(f.icd_code)?.toUpperCase() ?? null,
        primary_diagnosis: t(f.primary_diagnosis), treating_doctor_hpr_id: t(f.treating_doctor_hpr_id),
        treatment_type: f.treatment_type as Claim['treatment_type'], package_code: t(f.package_code), package_name: t(f.package_name),
      });
      await onSaved(); setMsg('Saved');
    } catch { setMsg('Could not save — check the HPR ID format (12-3456-7890-1234) and age.'); }
    setBusy(false);
  };

  return (
    <details open={missing.length > 0} className="mt-5 rounded-2xl border border-indigo-200 bg-white p-5">
      <summary className="cursor-pointer text-lg font-semibold text-slate-900">
        NHCX details {missing.length ? <span className="text-base font-medium text-rose-700">— {missing.length} missing</span> : <span className="text-base font-medium text-emerald-700">— complete</span>}
      </summary>
      {missing.length > 0 && <p className="mt-2 text-base text-slate-600">Needed before sending: {missing.join(', ')}.</p>}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="text-base font-medium text-slate-800">Gender<select value={f.patient_gender} onChange={set('patient_gender')} disabled={!canWrite} className={field}>
          <option value="">Choose…</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option></select></label>
        <label className="text-base font-medium text-slate-800">Age (years)<input type="number" min="0" max="130" value={f.patient_age_years} onChange={set('patient_age_years')} disabled={!canWrite} className={field} /></label>
        <label className="text-base font-medium text-slate-800">Policy no.<input value={f.policy_number} onChange={set('policy_number')} disabled={!canWrite} className={field} /></label>
        <label className="text-base font-medium text-slate-800">Member / card ID<input value={f.member_id} onChange={set('member_id')} disabled={!canWrite} className={field} /></label>
        <label className="text-base font-medium text-slate-800">ABHA no. (if any)<input value={f.abha_id} onChange={set('abha_id')} disabled={!canWrite} className={field} /></label>
        <label className="text-base font-medium text-slate-800">Treatment<select value={f.treatment_type} onChange={set('treatment_type')} disabled={!canWrite} className={field}>
          <option value="medical">Medical</option><option value="surgical">Surgical</option></select></label>
        <label className="text-base font-medium text-slate-800">ICD-10 code<input value={f.icd_code} onChange={set('icd_code')} disabled={!canWrite} placeholder="I63.9" className={field} /></label>
        <label className="text-base font-medium text-slate-800">Diagnosis<input value={f.primary_diagnosis} onChange={set('primary_diagnosis')} disabled={!canWrite} className={field} /></label>
        <label className="text-base font-medium text-slate-800">Doctor’s HPR ID<input value={f.treating_doctor_hpr_id} onChange={set('treating_doctor_hpr_id')} disabled={!canWrite} placeholder="71-8422-5818-7201" className={field} /></label>
        <label className="text-base font-medium text-slate-800">Package code (if any)<input value={f.package_code} onChange={set('package_code')} disabled={!canWrite} className={field} /></label>
        <label className="text-base font-medium text-slate-800 sm:col-span-2">Package / procedure name<input value={f.package_name} onChange={set('package_name')} disabled={!canWrite} className={field} /></label>
      </div>
      {canWrite && <div className="mt-4 flex items-center gap-3">
        <button onClick={save} disabled={busy} className="inline-flex min-h-12 items-center gap-2 rounded-xl bg-indigo-600 px-5 text-base font-semibold text-white hover:bg-indigo-700 disabled:opacity-50">
          {busy && <Loader2 className="h-4 w-4 animate-spin" />} Save details</button>
        {msg && <span className="text-base text-slate-600">{msg}</span>}
      </div>}
    </details>
  );
}
