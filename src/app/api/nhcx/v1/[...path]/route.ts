// NHCX delivers answers here: https://<site>/api/nhcx/v1/preauth/on_submit, …/claim/on_submit,
// …/communication/request, …/paymentnotice/request and so on.
// No user is signed in on these calls, so the reply is stored through one
// database function that checks a shared secret (anon key only — no service key).
// Only ids, the decision and amounts are kept in the clear; the full message is
// stored as received (encrypted).
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { createCallbackHandler, type CallbackRequest } from '@/lib/nhcx';
import { useCasePath } from '@/lib/nhcx/callback';
import { nhcxServerConfig } from '@/lib/nhcx-server/config';
import { supabaseEnv } from '@/lib/supabase/env';
import { replySummary } from '@/lib/rcm/nhcx-case';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STORE: Record<string, [string, string]> = {
  'coverageeligibility/on_check': ['coverageeligibility', 'on_check'],
  'preauth/on_submit': ['preauth', 'on_submit'],
  'claim/on_submit': ['claim', 'on_submit'],
  'predetermination/on_submit': ['predetermination', 'on_submit'],
  'communication/request': ['communication', 'request'],
  'paymentnotice/request': ['paymentnotice', 'request'],
  'on_status': ['status', 'on_status'],
  'hcx/on_status': ['status', 'on_status'],
  'task/on_submit': ['task', 'on_submit'],
};

let handler: ((r: CallbackRequest) => ReturnType<ReturnType<typeof createCallbackHandler>>) | null = null;

export async function POST(req: Request) {
  const cfg = nhcxServerConfig();
  if (!cfg) return NextResponse.json({ error: { code: 'ERR_SERVICE_UNAVAILABLE', message: 'Not configured' } }, { status: 503 });
  handler ??= createCallbackHandler({ participantCode: cfg.client.participantCode, privateKeyPem: cfg.privateKeyPem, logger: cfg.client.logger });

  const path = new URL(req.url).pathname;
  const body = await req.text();
  const out = await handler({ path, body, headers: Object.fromEntries(req.headers) });
  if (!out.accepted) return NextResponse.json(out.body, { status: out.httpStatus });

  const m = out.message;
  const where = STORE[useCasePath(path)];
  if (where && !m.duplicate) {
    const { url, anonKey } = supabaseEnv();
    const db = createClient(url, anonKey, { auth: { persistSession: false } });
    const { error } = await db.rpc('clm_nhcx_receive', {
      p_secret: cfg.callbackSecret,
      p_msg: {
        recipient_code: m.recipientCode, sender_code: m.senderCode, api_call: where[0], action: where[1],
        api_call_id: m.apiCallId, correlation_id: m.correlationId, workflow_id: m.workflowId ?? null,
        summary: replySummary(m.result), payload: body,
      },
    });
    if (error) {
      console.error('nhcx.callback.store_failed', { apiCallId: m.apiCallId, code: error.code });
      return NextResponse.json({ error: { code: 'ERR_SERVICE_UNAVAILABLE', message: 'Try again' } }, { status: 503 });
    }
  } else if (!where) {
    console.warn('nhcx.callback.error_report', { apiCallId: m.apiCallId, code: m.errorDetails?.code });
  }
  return NextResponse.json(out.body, { status: out.httpStatus });
}
