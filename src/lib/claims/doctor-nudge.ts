/**
 * Doctor nudge: before the discharge summary is signed, tell the treating
 * doctor what the insurer will look for in it, so the claim does not come
 * back as a query. Pure; the desk sends it on WhatsApp (wa.me link, no cost).
 */
export interface NudgeCase {
  patient_name: string; admission_ref: string | null; treating_doctor_name: string | null;
  claim_type: string; treatment_type?: 'medical' | 'surgical' | null; procedure_name?: string | null;
  primary_diagnosis?: string | null; icd_code?: string | null; payer?: string | null; bed_category?: string | null;
}

export function nudgePoints(c: NudgeCase): string[] {
  const p: string[] = [
    'Final diagnosis in full, with ICD-10 code',
    'Presenting complaints with duration (date of onset)',
    'Past history: diabetes, hypertension, heart disease and other chronic illness, with since when — or "no known past history"',
    'Key findings and investigation results that justify admission',
    'Treatment given, day by day in brief, and condition at discharge',
  ];
  const surgical = c.treatment_type === 'surgical' || /ectomy|otomy|plasty|scopy|graft|stent|replacement|fixation|repair|bypass|ptca|cabg/i.test(c.procedure_name ?? '');
  if (surgical) p.push('Procedure name as done, date, and the operation note (findings, approach)', 'Implants / stents used: name, size, batch — sticker to be pasted on the bill');
  if (/icu|iccu|nicu|picu|hdu/i.test(c.bed_category ?? '')) p.push('ICU stay: dates in and out, and why ICU care was needed');
  if (/accident|injur|trauma|fracture|rta|burn|poison/i.test(`${c.primary_diagnosis ?? ''} ${c.procedure_name ?? ''}`)) p.push('Mode of injury, date and time; MLC / FIR number, or a note that it is not medico-legal');
  p.push('Alcohol / smoking / substance history — yes or no');
  if (c.claim_type === 'pmjay') p.push('Package and procedure code as booked on TMS');
  return p;
}

export function nudgeText(c: NudgeCase, hospital = 'the hospital'): string {
  const head = `Dr ${(c.treating_doctor_name ?? '').replace(/^dr\.?\s*/i, '') || '[name]'}, for ${c.patient_name}${c.admission_ref ? ` (IP ${c.admission_ref})` : ''}${c.payer ? ` — ${c.payer}` : ''}:`;
  return [head, 'Before signing the discharge summary, please make sure it has:', ...nudgePoints(c).map((x, i) => `${i + 1}. ${x}`),
    '', `This avoids an insurer query and delays at discharge. — Insurance desk, ${hospital}`].join('\n');
}

/** wa.me link: opens WhatsApp on the desk phone with the message ready; the desk picks the doctor. */
export function waLink(text: string, phone?: string | null): string {
  const n = (phone ?? '').replace(/\D/g, '');
  const to = n.length === 10 ? `91${n}` : n;
  return `https://wa.me/${to}?text=${encodeURIComponent(text)}`;
}
