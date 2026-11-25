'use client';
// Pre-auth form, filled. The IRDAI standard "Request for cashless hospitalisation"
// form is the same for every insurer and TPA, so one layout serves all.
// Whatever the case already holds is filled; the rest is left as a line to write on.
// Prints straight to A4 (Ctrl/⌘-P or the Print button).
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, Printer } from 'lucide-react';
import { sb } from '@/lib/supabase/browser';
import { fetchCase } from '@/lib/rcm/api';
import type { Claim } from '@/lib/claims/types';

const d = (s?: string | null) => (s ? new Date(s.length === 10 ? `${s}T12:00:00+05:30` : s).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '');
const tm = (s?: string | null) => (s && s.length > 10 ? new Date(s).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '');
const rs = (n?: number | null) => (n == null ? '' : `₹ ${Math.round(Number(n)).toLocaleString('en-IN')}`);
const daysBetween = (a?: string | null, b?: string | null) => {
  if (!a || !b) return '';
  const ms = new Date(b.slice(0, 10)).getTime() - new Date(a.slice(0, 10)).getTime();
  return Number.isFinite(ms) && ms >= 0 ? String(Math.max(1, Math.round(ms / 86_400_000))) : '';
};

function F({ label, value, wide }: { label: string; value?: string | number | null; wide?: boolean }) {
  return (
    <div className={`flex items-end gap-2 py-1.5 ${wide ? 'col-span-2' : ''}`}>
      <span className="shrink-0 text-[14px] text-slate-700">{label}</span>
      <span className="min-h-[1.4em] flex-1 border-b border-slate-400 text-[15px] font-semibold text-slate-900">{value ?? ''}</span>
    </div>
  );
}
function Tick({ label, on }: { label: string; on?: boolean }) {
  return <span className="mr-4 inline-flex items-center gap-1.5 text-[14px]"><span className="inline-flex h-4 w-4 items-center justify-center border border-slate-600 text-[12px] font-bold">{on ? '✓' : ''}</span>{label}</span>;
}
function H({ children }: { children: React.ReactNode }) {
  return <h2 className="mt-5 border-b-2 border-slate-900 pb-1 text-[15px] font-bold uppercase tracking-wide text-slate-900 print:break-after-avoid">{children}</h2>;
}

export default function PreauthForm() {
  const { id } = useParams<{ id: string }>();
  const [c, setC] = useState<Claim | null>(null);
  const [centre, setCentre] = useState<{ name: string; hfr_id: string | null; state: string | null } | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    fetchCase(id).then(async (x) => {
      if (!x) { setMissing(true); return; }
      setC(x);
      const { data } = await sb().from('clm_centres').select('name, hfr_id, state').eq('id', x.centre_id).maybeSingle();
      setCentre(data as typeof centre);
    });
  }, [id]);

  if (missing) return <p className="p-8 text-base text-slate-600">Patient not found. <Link href="/master" className="text-teal-700 underline">Back to Master</Link></p>;
  if (!c) return <p className="p-8 text-base text-slate-500">Loading…</p>;
  const surgical = c.treatment_type === 'surgical';
  const ext = c as Claim & { clm_payers?: { name?: string } | null };
  const stay = daysBetween(c.admitted_at ?? c.admission_date, c.discharged_at ?? c.discharge_date);

  return (
    <div className="mx-auto max-w-4xl bg-white p-6 print:max-w-none print:p-0">
      <div className="mb-4 flex items-center justify-between print:hidden">
        <Link href={`/case/${c.id}`} className="inline-flex min-h-11 items-center gap-1 text-sm text-slate-500 hover:text-slate-800"><ArrowLeft className="h-4 w-4" /> Back to the file</Link>
        <button type="button" onClick={() => window.print()} className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-teal-600 px-4 text-sm font-semibold text-white hover:bg-teal-700"><Printer className="h-4 w-4" /> Print</button>
      </div>
      <p className="mb-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 print:hidden">Filled from the file. Blank lines are not in ClaimOne yet — write them in by hand, or add them to the file first. Check every line before the doctor and patient sign.</p>

      <header className="border-b-2 border-slate-900 pb-2 text-center">
        <p className="text-[13px] uppercase tracking-wider text-slate-600">Part C (Revised)</p>
        <h1 className="text-xl font-bold text-slate-900">Request for Cashless Hospitalisation for Health Insurance Policy</h1>
        <p className="text-[14px] text-slate-700">To be filled in block letters</p>
      </header>

      <H>Details of the third party administrator / insurer / hospital</H>
      <div className="grid grid-cols-2 gap-x-6">
        <F label="Name of TPA / Insurer" value={ext.clm_payers?.name ?? c.sponsor_name} wide />
        <F label="Name of hospital" value={centre?.name} />
        <F label="Hospital ID (HFR)" value={centre?.hfr_id} />
        <F label="State" value={centre?.state} />
        <F label="Hospital IP no." value={c.admission_ref} />
      </div>

      <H>To be filled by the insured / patient</H>
      <div className="grid grid-cols-2 gap-x-6">
        <F label="Name of the patient" value={c.patient_name} wide />
        <div className="col-span-2 py-1.5"><span className="mr-3 text-[14px] text-slate-700">Gender</span>
          <Tick label="Male" on={c.patient_gender === 'male'} /><Tick label="Female" on={c.patient_gender === 'female'} /><Tick label="Third gender" on={c.patient_gender === 'other'} /></div>
        <F label="Age (years)" value={c.patient_age_years} />
        <F label="Date of birth" />
        <F label="Contact number" value={c.patient_phone} />
        <F label="Alternate contact" />
        <F label="Insured card ID / member ID" value={c.member_id} />
        <F label="Policy number / corporate name" value={c.policy_number} />
        <F label="Policy holder" value={c.policy_holder_name} />
        <F label="Employee ID" />
        <F label="ABHA number" value={c.abha_id} />
        <F label="Hospital UHID" value={c.patient_uhid} />
        <div className="col-span-2 py-1.5"><span className="mr-3 text-[14px] text-slate-700">Other mediclaim / health insurance?</span><Tick label="Yes" /><Tick label="No" /> <span className="text-[14px] text-slate-700">If yes, company:</span> <span className="inline-block w-48 border-b border-slate-400" /></div>
        <F label="Family physician (name, contact)" wide />
        <F label="Occupation" />
        <F label="Address" />
      </div>

      <H>To be filled by the treating doctor / hospital</H>
      <div className="grid grid-cols-2 gap-x-6">
        <F label="Name of the treating doctor" value={c.treating_doctor_name} />
        <F label="Doctor's registration / HPR ID" value={c.treating_doctor_hpr_id} />
        <F label="Department" value={c.department_name} />
        <F label="Contact number" />
        <F label="Nature of illness / presenting complaints" wide />
        <F label="Relevant clinical findings" wide />
        <F label="Duration of present ailment (days)" />
        <F label="Date of first consultation" />
        <F label="Past history of present ailment, if any" wide />
        <F label="Provisional diagnosis" value={c.primary_diagnosis} wide />
        <F label="ICD-10 code" value={c.icd_code} />
        <F label="Package code" value={c.package_code} />
        <div className="col-span-2 py-1.5"><span className="mr-3 text-[14px] text-slate-700">Proposed line of treatment</span>
          <Tick label="Medical management" on={c.treatment_type === 'medical'} /><Tick label="Surgical management" on={surgical} /><Tick label="Intensive care" /><Tick label="Investigation" /><Tick label="Non-allopathic" /></div>
        <F label="If surgical, name of surgery" value={surgical ? c.procedure_name ?? c.package_name : ''} wide />
        <F label="If medical, route of drug administration" />
        <F label="ICD-10 PCS code" />
        <F label="Other treatment details" value={!surgical ? c.procedure_name ?? c.package_name : ''} wide />
        <div className="col-span-2 py-1.5"><span className="mr-3 text-[14px] text-slate-700">In case of accident: RTA?</span><Tick label="Yes" /><Tick label="No" />
          <span className="mr-2 text-[14px] text-slate-700">Reported to police?</span><Tick label="Yes" /><Tick label="No" /> <span className="text-[14px] text-slate-700">FIR no.</span> <span className="inline-block w-32 border-b border-slate-400" /></div>
        <div className="col-span-2 py-1.5"><span className="mr-3 text-[14px] text-slate-700">Injury / disease caused by alcohol or substance abuse?</span><Tick label="Yes" /><Tick label="No" /> <span className="text-[14px] text-slate-700">Test conducted?</span> <Tick label="Yes" /><Tick label="No" /></div>
        <div className="col-span-2 py-1.5"><span className="mr-3 text-[14px] text-slate-700">In case of maternity:</span> G <span className="inline-block w-10 border-b border-slate-400" /> P <span className="inline-block w-10 border-b border-slate-400" /> L <span className="inline-block w-10 border-b border-slate-400" /> A <span className="inline-block w-10 border-b border-slate-400" /> <span className="ml-3 text-[14px] text-slate-700">Expected date of delivery</span> <span className="inline-block w-32 border-b border-slate-400" /></div>
      </div>

      <H>Details of the patient admitted</H>
      <div className="grid grid-cols-2 gap-x-6">
        <F label="Date of admission" value={d(c.admitted_at ?? c.admission_date)} />
        <F label="Time of admission" value={tm(c.admitted_at)} />
        <div className="col-span-2 py-1.5"><span className="mr-3 text-[14px] text-slate-700">This is</span><Tick label="Emergency hospitalisation" /><Tick label="Planned hospitalisation" /></div>
        <F label="Expected number of days of stay" value={stay} />
        <F label="Days in ICU" />
        <F label="Room type" value={c.bed_category} />
        <F label="Per day room rent + nursing + service" />
        <F label="Expected cost of investigations + diagnostics" />
        <F label="ICU charges" />
        <F label="OT charges" />
        <F label="Professional fees (surgeon, anaesthetist, consultation)" wide />
        <F label="Medicines + consumables + cost of implants" wide />
        <F label="Other hospital expenses, if any" />
        <F label="All-inclusive package charges, if any" value={rs(c.package_amount)} />
        <F label="Sum total expected cost of hospitalisation" value={rs(c.estimated_amount)} wide />
      </div>

      <H>Mandatory past history of any chronic illness</H>
      <div className="grid grid-cols-2 gap-x-6">
        {['Diabetes', 'Heart disease', 'Hypertension', 'Hyperlipidaemia', 'Osteoarthritis', 'Asthma / COPD / bronchitis', 'Cancer', 'Alcohol or drug abuse', 'Any HIV or STD related ailment', 'Any other ailment'].map((x) => (
          <F key={x} label={`${x} — since (month / year)`} />
        ))}
      </div>

      <H>Declarations</H>
      <p className="mt-2 text-[14px] leading-6 text-slate-800">I / we agree to allow the hospital to submit all original documents pertaining to hospitalisation to the insurer / TPA after discharge. I / we agree to sign the final bill and the discharge summary before discharge. Payment to the hospital is governed by the terms and conditions of the policy. If the insurer / TPA is not liable to make the payment in respect of this claim, I / we undertake to pay the amount in full to the hospital.</p>
      <div className="mt-8 grid grid-cols-3 gap-6 text-center text-[14px] text-slate-700 print:break-inside-avoid">
        <div><div className="h-12 border-b border-slate-500" />Treating doctor — name, seal and signature</div>
        <div><div className="h-12 border-b border-slate-500" />Patient / insured — name and signature</div>
        <div><div className="h-12 border-b border-slate-500" />Hospital seal and authorised signatory</div>
      </div>
      <p className="mt-6 text-[13px] text-slate-500">Date: <span className="inline-block w-40 border-b border-slate-400" /> · Time: <span className="inline-block w-24 border-b border-slate-400" /> · Claim ref: {c.tpa_preauth_number ?? c.claim_number}</p>
    </div>
  );
}
