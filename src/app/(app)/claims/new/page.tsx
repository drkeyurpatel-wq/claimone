'use client';
// New claim. H1 Claims pulled the patient from the old HMIS tables, which
// the rebuild retires; until the new HMIS/eCW feed exists the desk types
// the episode in. lib/integrations/patient-source.ts is the seam to fill.
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FilePlus2, Loader2, Search } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import { createClaim, fetchPayers } from '@/lib/claims/api';
import { CLAIM_TYPE_LABELS, type ClaimType, type Payer, type Priority } from '@/lib/claims/types';
import { PageHeader, NoCentre, btn } from '@/components/ui';

const EMPTY = {
  claim_type: 'cashless' as ClaimType, payer_id: '', priority: 'medium' as Priority,
  patient_name: '', patient_uhid: '', patient_phone: '', abha_id: '',
  policy_number: '', policy_holder_name: '', admission_ref: '',
  admission_date: '', discharge_date: '', treating_doctor_name: '', department_name: '',
  primary_diagnosis: '', icd_code: '', procedure_name: '', package_code: '', package_name: '',
  estimated_amount: '', notes: '',
};

export default function NewClaim() {
  const router = useRouter();
  const { activeCentreId, tenantId, centres, staff } = useAuthStore();
  const [f, setF] = useState(EMPTY);
  const [payers, setPayers] = useState<Payer[]>([]);
  const [payerQ, setPayerQ] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState('');

  useEffect(() => { fetchPayers().then(setPayers); }, []);

  const visiblePayers = useMemo(() => {
    const q = payerQ.toLowerCase();
    const wanted = f.claim_type === 'pmjay' || f.claim_type === 'cghs' || f.claim_type === 'echs' || f.claim_type === 'state_scheme'
      ? payers.filter((p) => p.type === 'government') : payers.filter((p) => p.type !== 'government');
    return (wanted.length ? wanted : payers).filter((p) => !q || p.name.toLowerCase().includes(q));
  }, [payers, payerQ, f.claim_type]);

  if (!activeCentreId || !tenantId) return <NoCentre />;
  if (staff && !['admin', 'manager', 'desk'].includes(staff.role)) return <div className="p-10 text-center text-sm text-slate-500">Your login is read-only.</div>;

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setF({ ...f, [k]: e.target.value });

  const validate = () => {
    const e: Record<string, string> = {};
    if (!f.patient_name.trim()) e.patient_name = 'Patient name is required';
    if (!f.payer_id) e.payer_id = 'Choose the payer';
    if (f.patient_phone && !/^\+?\d[\d\s-]{8,14}$/.test(f.patient_phone.trim())) e.patient_phone = 'Enter a valid mobile number';
    if (f.estimated_amount && !(Number(f.estimated_amount) >= 0)) e.estimated_amount = 'Enter an amount in rupees';
    if (f.admission_date && f.discharge_date && f.discharge_date < f.admission_date) e.discharge_date = 'Discharge is before admission';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const save = async () => {
    if (!validate()) return;
    setSaving(true); setServerError('');
    const clean = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, typeof v === 'string' && v.trim() === '' ? null : typeof v === 'string' ? v.trim() : v]));
    try {
      const c = await createClaim({
        ...clean,
        tenant_id: tenantId, centre_id: activeCentreId,
        payer_id: f.payer_id, claim_type: f.claim_type, patient_name: f.patient_name.trim(),
        estimated_amount: f.estimated_amount ? Number(f.estimated_amount) : null,
      } as Parameters<typeof createClaim>[0]);
      router.replace(`/claims/${c.id}`);
    } catch (e) { setServerError((e as Error).message); setSaving(false); }
  };

  const L = ({ t, req }: { t: string; req?: boolean }) => <label className="text-[11px] font-semibold text-slate-600">{t}{req && <span className="text-rose-600"> *</span>}</label>;
  // Called as a function (not <I/>) so inputs keep focus between keystrokes.
  const I = ({ k, ph, type = 'text', mode }: { k: keyof typeof EMPTY; ph?: string; type?: string; mode?: 'decimal' | 'tel' }) => (
    <>
      <input type={type} inputMode={mode} value={f[k] as string} onChange={set(k)} placeholder={ph} className={`${btn.input} mt-1 w-full ${errors[k] ? 'border-rose-400' : ''}`} />
      {errors[k] && <p className="mt-1 text-xs text-rose-600">{errors[k]}</p>}
    </>
  );
  const centreName = centres.find((c) => c.id === activeCentreId)?.name;

  return (
    <div>
      <PageHeader title="New claim" sub={`Starts as a draft at ${centreName}. Submit it once the documents are verified.`} icon={FilePlus2} />
      <div className="mx-auto max-w-4xl space-y-4 px-4 py-6 md:px-6">
        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="mb-4 text-sm font-bold text-slate-900">Payer</h2>
          <div className="grid gap-4 md:grid-cols-3">
            <div><L t="Claim type" req />
              <select value={f.claim_type} onChange={(e) => setF({ ...f, claim_type: e.target.value as ClaimType, payer_id: '' })} className={`${btn.input} mt-1 w-full`}>
                {Object.entries(CLAIM_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select></div>
            <div className="md:col-span-2"><L t="Payer (insurer, TPA or scheme)" req />
              <div className="relative mt-1">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <input value={payerQ} onChange={(e) => setPayerQ(e.target.value)} placeholder="Type to filter" className={`${btn.input} w-full pl-8`} />
              </div>
              <select size={5} value={f.payer_id} onChange={set('payer_id')} className={`${btn.input} mt-2 w-full ${errors.payer_id ? 'border-rose-400' : ''}`}>
                {visiblePayers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              {errors.payer_id && <p className="mt-1 text-xs text-rose-600">{errors.payer_id}</p>}
            </div>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="mb-4 text-sm font-bold text-slate-900">Patient and policy</h2>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="md:col-span-2"><L t="Patient name" req />{I({ k: "patient_name" })}</div>
            <div><L t="UHID" />{I({ k: "patient_uhid" })}</div>
            <div><L t="Mobile (for WhatsApp updates)" />{I({ k: "patient_phone", mode: "tel" })}</div>
            <div><L t="ABHA number" />{I({ k: "abha_id" })}</div>
            <div><L t="Policy / card number" />{I({ k: "policy_number" })}</div>
            <div><L t="Policyholder (if not the patient)" />{I({ k: "policy_holder_name" })}</div>
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="mb-4 text-sm font-bold text-slate-900">Episode</h2>
          <div className="grid gap-4 md:grid-cols-3">
            <div><L t="IPD / admission no." />{I({ k: "admission_ref" })}</div>
            <div><L t="Admission date" />{I({ k: "admission_date", type: "date" })}</div>
            <div><L t="Discharge date" />{I({ k: "discharge_date", type: "date" })}</div>
            <div><L t="Treating doctor" />{I({ k: "treating_doctor_name" })}</div>
            <div><L t="Department" />{I({ k: "department_name" })}</div>
            <div><L t="Estimated cost (₹)" />{I({ k: "estimated_amount", mode: "decimal" })}</div>
            <div className="md:col-span-2"><L t="Provisional diagnosis" />{I({ k: "primary_diagnosis" })}</div>
            <div><L t="ICD-10" />{I({ k: "icd_code", ph: "e.g. I63.9" })}</div>
            <div className="md:col-span-2"><L t="Procedure planned" />{I({ k: "procedure_name" })}</div>
            <div><L t="Priority" />
              <select value={f.priority} onChange={set('priority')} className={`${btn.input} mt-1 w-full`}>
                <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option>
              </select></div>
            {f.claim_type === 'pmjay' && <>
              <div><L t="HBP package code" />{I({ k: "package_code" })}</div>
              <div className="md:col-span-2"><L t="Package name" />{I({ k: "package_name" })}</div>
            </>}
            <div className="md:col-span-3"><L t="Notes" />
              <textarea rows={2} value={f.notes} onChange={set('notes')} className={`${btn.input} mt-1 w-full`} /></div>
          </div>
        </section>

        {serverError && <p className="rounded-lg bg-rose-50 p-3 text-sm text-rose-700">{serverError}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={() => router.back()} className={btn.ghost}>Cancel</button>
          <button onClick={save} disabled={saving} className={btn.primary}>{saving && <Loader2 className="h-4 w-4 animate-spin" />} Create draft</button>
        </div>
      </div>
    </div>
  );
}
