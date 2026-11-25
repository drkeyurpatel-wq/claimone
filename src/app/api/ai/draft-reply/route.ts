// Draft a reply to a payer query. The template draft (no AI, no cost) is always
// returned; with ANTHROPIC_API_KEY set it is also rewritten to answer the query
// point by point. The desk reads and edits it — nothing is sent from here.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, fail } from '@/lib/api/route';
import { draftReply } from '@/lib/claims/reply';
import { askClaude } from '@/lib/ai/claude.server';

export const maxDuration = 60;
const Body = z.object({ queryId: z.string().uuid(), ai: z.boolean().optional() });

const SYSTEM = `You write replies from an Indian hospital's insurance desk to a TPA or insurer query on a cashless or reimbursement claim.
Write in plain, professional Indian business English. Answer each point of the query in order. Keep the enclosure list exactly as given.
Never invent clinical facts, dates or amounts: where the desk must fill something in, write it in [square brackets]. Output only the reply text.`;

export async function POST(req: Request) {
  const auth = await requireUser();
  if ('error' in auth && auth.error) return auth.error;
  if (!('supabase' in auth)) return fail(401, 'Sign in again.');
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, 'Check the values entered.');
  const { supabase } = auth;

  const { data: q } = await supabase.from('clm_queries').select('id, claim_id, query_text, query_number, raised_at').eq('id', parsed.data.queryId).maybeSingle();
  if (!q) return fail(404, 'Query not found.');
  const [{ data: c }, { data: docs }] = await Promise.all([
    supabase.from('clm_claims').select('patient_name, claim_number, tpa_claim_number, tpa_preauth_number, policy_number, admission_date, discharge_date, primary_diagnosis, procedure_name, treating_doctor_name, clm_centres(name)').eq('id', q.claim_id).maybeSingle(),
    supabase.from('clm_documents').select('doc_code, document_name').eq('claim_id', q.claim_id),
  ]);
  if (!c) return fail(404, 'Claim not found.');
  const hospital = (c as { clm_centres?: { name?: string } | null }).clm_centres?.name ?? 'the hospital';
  const draft = draftReply(q, c, docs ?? [], hospital);
  const base = { text: draft.text, enclosed: draft.enclosed.map((p) => p.name), missing: draft.missing.map((p) => p.name), ai: false };
  if (!parsed.data.ai) return NextResponse.json(base);

  const better = await askClaude(SYSTEM, [
    `Query from the payer:\n${q.query_text}`,
    `Claim: ${c.tpa_claim_number || c.claim_number}; patient ${c.patient_name}; diagnosis ${c.primary_diagnosis ?? '[not on file]'}; procedure ${c.procedure_name ?? '[not on file]'}; treating doctor ${c.treating_doctor_name ?? '[not on file]'}; admitted ${c.admission_date ?? '?'}; discharged ${c.discharge_date ?? '?'}.`,
    `Papers to enclose: ${[...base.enclosed, ...base.missing].join('; ') || 'none named'}.`,
    `Sign off as: Insurance desk, ${hospital}.`,
    `Starting draft:\n${draft.text}`,
  ].join('\n\n'));
  if (!better) return NextResponse.json({ ...base, note: 'AI drafting is not switched on (or busy) — the standard draft is shown.' });
  return NextResponse.json({ ...base, text: better, ai: true });
}
