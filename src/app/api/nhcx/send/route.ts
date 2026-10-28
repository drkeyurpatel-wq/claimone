// Send a case's pre-auth or final claim over NHCX, log it, and move the case.
// Checks first (details, papers) so nothing half-ready reaches the insurer.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, fail, fromDbError } from '@/lib/api/route';
import { nhcxServerConfig } from '@/lib/nhcx-server/config';
import { NhcxClient, NhcxError, buildPreauthBundle, buildClaimSubmissionBundle, WORKFLOW } from '@/lib/nhcx';
import { caseToNhcx } from '@/lib/rcm/nhcx-case';
import { CASE_SELECT } from '@/lib/rcm/select';
import type { Claim } from '@/lib/claims/types';

export const runtime = 'nodejs';

const Body = z.object({
  claimId: z.string().uuid(),
  kind: z.enum(['preauth', 'claim']),
  amount: z.number().positive().max(1e9).optional(),
  note: z.string().trim().max(1000).optional(),
});

export async function POST(req: Request): Promise<Response> {
  const auth = await requireUser();
  if ('error' in auth && auth.error) return auth.error;
  if (!('supabase' in auth)) return fail(401, 'Sign in again.');
  const { supabase } = auth;
  const cfg = nhcxServerConfig();
  if (!cfg) return fail(503, 'NHCX is not set up yet. Send it on the insurer website and press "I have sent it".');

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, 'Check the values entered.');
  const { claimId, kind, amount, note } = parsed.data;

  // only desk, manager and admin logins may send anything to an insurer
  const { data: canWrite } = await supabase.rpc('clm_can_write');
  if (canWrite !== true) return fail(403, 'Your login can only view.');

  const { data, error } = await supabase.from('clm_claims').select(CASE_SELECT).eq('id', claimId).maybeSingle();
  if (error || !data) return fail(404, 'Case not found.');
  const c = data as unknown as Claim;
  const { data: centre } = await supabase.from('clm_centres').select('nhcx_participant_code').eq('id', c.centre_id).maybeSingle();
  if (centre?.nhcx_participant_code !== cfg.client.participantCode) return fail(409, 'This hospital is not set up on NHCX yet.');

  // what kind of request this is
  const query = c.status === 'preauth_query' || c.status === 'claim_query';
  const allowed = kind === 'preauth' ? ['draft', 'preauth_query'] : ['preauth_approved', 'preauth_enhanced', 'claim_query', 'draft'];
  if (!allowed.includes(c.status)) return fail(409, 'This case is not at that step.');
  const to = kind === 'preauth' ? 'preauth_pending' : 'claim_submitted';

  const built = caseToNhcx(c, kind, { hfrId: cfg.client.hfrId, name: cfg.client.providerName, participantCode: cfg.client.participantCode }, amount);
  if (!built.input) return fail(422, 'Fill in the NHCX details first.', { blockers: built.missing });
  if (query && note) built.input.queryAnswerRemarks = note;

  // papers: the same gate the status change applies, checked before anything leaves
  const { data: unmet } = await supabase.rpc('clm_unmet_mandatory_docs', { p_claim_id: c.id, p_stage: kind === 'preauth' ? 'preauth' : 'final' });
  const blockers = ((unmet ?? []) as { doc_label: string; doc_status: string }[]).map((d) => `${d.doc_label} (${d.doc_status})`);
  if (blockers.length) return fail(422, 'Submission blocked — some documents are not verified yet.', { blockers });

  const workflowId = kind === 'preauth' ? (query ? WORKFLOW.preauthQueryAnswer : WORKFLOW.preauthNew) : (query ? WORKFLOW.claimQueryAnswer : WORKFLOW.claimNew);
  let sent;
  try {
    const bundle = kind === 'preauth' ? buildPreauthBundle(built.input) : buildClaimSubmissionBundle(built.input);
    const client = new NhcxClient(cfg.client);
    sent = await client.send(kind === 'preauth' ? 'preauth/submit' : 'claim/submit', bundle, c.clm_payers!.nhcx_code!, {
      workflowId, useCase: query ? 'Resubmit' : 'New', beneficiaryAbha: c.abha_id || undefined,
    });
  } catch (e) {
    const err = e as NhcxError;
    await supabase.from('clm_nhcx_messages').insert({
      tenant_id: c.tenant_id, centre_id: c.centre_id, claim_id: c.id, direction: 'out', api_call: kind, action: 'request',
      api_call_id: err.apiCallId ?? crypto.randomUUID(), correlation_id: err.correlationId ?? 'not-sent', recipient_code: c.clm_payers!.nhcx_code,
      status: 'error', http_status: err.httpStatus ?? null, error: `${err.code ?? 'ERR'}: ${err.message}`.slice(0, 500),
    });
    return fail(502, `NHCX did not accept it: ${err.message}`.slice(0, 300));
  }

  await supabase.from('clm_nhcx_messages').insert({
    tenant_id: c.tenant_id, centre_id: c.centre_id, claim_id: c.id, direction: 'out', api_call: kind, action: 'request',
    api_call_id: sent.apiCallId, correlation_id: sent.correlationId, workflow_id: sent.workflowId ?? workflowId,
    sender_code: cfg.client.participantCode, recipient_code: c.clm_payers!.nhcx_code, status: 'sent', http_status: sent.httpStatus,
    summary: { amount: built.input.items.reduce((s, i) => s + (i.amount ?? i.unitPrice * i.quantity), 0), workflow: workflowId },
  });

  const fields = kind === 'claim' ? { claimed_amount: built.input.items[0].unitPrice } : {};
  const { error: tErr } = await supabase.rpc('clm_transition', { p_claim_id: c.id, p_to_status: to, p_fields: fields, p_note: note ?? 'Sent on NHCX' });
  if (tErr) {
    const r = fromDbError(tErr);
    const j = await r.json();
    return fail(409, `Sent on NHCX, but the case did not move: ${j.error}`);
  }
  return NextResponse.json({ ok: true, correlationId: sent.correlationId });
}
