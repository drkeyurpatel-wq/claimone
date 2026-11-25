/**
 * Query reply drafts, with no AI and no cost: read what the payer asked for,
 * match it to the papers already on the file, and write a professional reply
 * listing what is enclosed and what the desk still has to get.
 * Pure — the desk reads, edits and sends; nothing goes out on its own.
 */

export interface Paper { code: string; name: string; words: RegExp }

/** Papers TPAs and insurers ask for most, with the words they use for them. */
export const PAPERS: Paper[] = [
  { code: 'discharge_summary', name: 'Discharge summary (signed)', words: /discharge\s*summ|\bdsc?\b|\bd\.?s\.?\b/i },
  { code: 'final_bill', name: 'Final hospital bill with break-up', words: /final\s*bill|detailed\s*bill|bill\s*break|itemi[sz]ed|interim\s*bill|hospital\s*bill/i },
  { code: 'pharmacy_bills', name: 'Pharmacy bills', words: /pharma|medicine\s*bill|drug\s*bill/i },
  { code: 'investigations', name: 'Investigation reports', words: /investigat|lab\s*report|blood\s*report|reports?\s*of|pathology|\bcbc\b|culture/i },
  { code: 'imaging', name: 'Imaging reports and films', words: /x-?ray|\bct\b|\bmri\b|usg|ultrasound|sonograph|films?|angiogra|echo/i },
  { code: 'indoor_papers', name: 'Indoor case papers (ICP)', words: /indoor|\bicp\b|case\s*papers?|progress\s*notes?|treatment\s*sheet|nursing/i },
  { code: 'ot_notes', name: 'Operation notes', words: /\bot\s*notes?|operat\w*\s*notes?|surgical\s*notes?|procedure\s*notes?/i },
  { code: 'implant', name: 'Implant invoice and sticker', words: /implant|stent|sticker|lens|prosthe/i },
  { code: 'histopath', name: 'Histopathology report', words: /histo|biopsy/i },
  { code: 'consultation', name: 'First consultation / referral note', words: /first\s*consult|referral|\bopd\s*paper|advice\s*for\s*admission/i },
  { code: 'past_history', name: 'Past treatment records', words: /past\s*(history|record)|previous\s*(treatment|record|history)|old\s*records?|duration\s*of\s*(illness|ailment)/i },
  { code: 'kyc', name: 'Patient photo ID / KYC', words: /\bkyc\b|photo\s*id|aadha?ar|\bpan\b|id\s*proof/i },
  { code: 'policy', name: 'Policy copy / e-card', words: /policy\s*copy|e-?card|health\s*card|member\s*id/i },
  { code: 'mlc', name: 'MLC / FIR copy', words: /\bmlc\b|\bfir\b|medico.?legal|police/i },
  { code: 'alcohol', name: 'Alcohol / substance history declaration', words: /alcohol|smok|tobacco|substance|addiction/i },
  { code: 'cost_estimate', name: 'Revised cost estimate', words: /estimate|cost\s*break|tariff|package\s*rate/i },
  { code: 'claim_form', name: 'Claim form (signed)', words: /claim\s*form|part\s*b|signed\s*form/i },
  { code: 'cancelled_cheque', name: 'Cancelled cheque / NEFT details', words: /cheque|neft|bank\s*details/i },
];

export interface DocLite { doc_code: string | null; document_name: string }
export interface ClaimLite {
  patient_name: string; claim_number: string; tpa_claim_number?: string | null; tpa_preauth_number?: string | null;
  policy_number?: string | null; admission_date?: string | null; discharge_date?: string | null;
}
export interface QueryLite { query_text: string; query_number?: number; raised_at?: string }

/** The papers a query asks for, in the order they appear in the list. */
export function askedPapers(text: string): Paper[] {
  return PAPERS.filter((p) => p.words.test(text));
}

/** Is this paper already on the file? By its code, else by its name. */
export function onFile(p: Paper, docs: DocLite[]): DocLite | null {
  return docs.find((d) => d.doc_code === p.code) ?? docs.find((d) => p.words.test(d.document_name)) ?? null;
}

export interface Draft { text: string; enclosed: Paper[]; missing: Paper[] }

const dmy = (d?: string | null) =>
  d ? new Date(d.length === 10 ? `${d}T12:00:00+05:30` : d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '';

export function draftReply(q: QueryLite, c: ClaimLite, docs: DocLite[], hospital = 'the hospital'): Draft {
  const asked = askedPapers(q.query_text);
  const enclosed = asked.filter((p) => onFile(p, docs));
  const missing = asked.filter((p) => !onFile(p, docs));
  const ref = c.tpa_claim_number || c.tpa_preauth_number || c.claim_number;
  const stay = [dmy(c.admission_date), dmy(c.discharge_date)].filter(Boolean).join(' to ');
  const lines: string[] = [];
  lines.push('Dear Sir / Madam,', '');
  lines.push(`Ref: Claim ${ref} — ${c.patient_name}${c.policy_number ? `, policy ${c.policy_number}` : ''}${stay ? `, admitted ${stay}` : ''}.`);
  lines.push('', `With reference to your query${q.raised_at ? ` dated ${dmy(q.raised_at)}` : ''}, please find the requested documents enclosed:`, '');
  const list = [...enclosed, ...missing];
  if (list.length) list.forEach((p, i) => lines.push(`${i + 1}. ${p.name}`));
  else lines.push('1. [Document requested]');
  lines.push('', 'We request you to process the claim at the earliest. Please let us know if anything further is required.', '',
    'Regards,', `Insurance desk, ${hospital}`);
  return { text: lines.join('\n'), enclosed, missing };
}
