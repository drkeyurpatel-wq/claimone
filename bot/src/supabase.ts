// bot/src/supabase.ts — the bot's only link to ClaimOne.
//
// H1 Claims gave the bot the Supabase service-role key, which bypasses every
// security rule — on a mini PC sitting in a hospital. The bot now signs in as
// an ordinary user with role 'bot':
//   - it reads only claims at its own centres (RLS)
//   - it changes claims only through clm_bot_apply(), which allows three
//     fields and still runs every status rule (no jumping to 'settled')
//   - its files go to the same private bucket, scoped to its tenant
// If the machine is stolen, disable that one user in Supabase Auth.

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { BotRunRecord, ClaimData, BotAction } from './types';
import { logger } from './logger';

let client: SupabaseClient | null = null;
let tenantId: string | null = null;

export async function getSupabase(): Promise<SupabaseClient> {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY;
  const email = process.env.BOT_EMAIL;
  const password = process.env.BOT_PASSWORD;
  if (!url || !anon || !email || !password) {
    throw new Error('SUPABASE_URL, SUPABASE_ANON_KEY, BOT_EMAIL and BOT_PASSWORD are required');
  }
  if (process.env.SUPABASE_SERVICE_KEY) {
    throw new Error('Remove SUPABASE_SERVICE_KEY from the bot .env — the bot must not hold it');
  }
  const c = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: true } });
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Bot sign-in failed: ${error.message}`);
  const { data: profile } = await c.from('clm_user_profiles').select('tenant_id, role').maybeSingle();
  if (profile?.role !== 'bot') throw new Error('This login is not a bot account');
  tenantId = profile.tenant_id;
  client = c;
  return c;
}

const PENDING_STATUSES: Record<Exclude<BotAction, 'poll_all'>, string[]> = {
  // Claims reach preauth_pending only after the document gate passed.
  submit_preauth: ['preauth_pending'],
  submit_claim: ['claim_submitted'],
  check_status: ['preauth_pending', 'preauth_query', 'preauth_approved', 'preauth_enhanced',
    'claim_submitted', 'claim_under_review', 'claim_query', 'claim_approved', 'claim_partial', 'settlement_pending'],
  download_letter: ['preauth_approved', 'preauth_enhanced', 'claim_approved', 'claim_partial'],
  download_payments: [],
};

const CLAIM_FIELDS = 'id, claim_number, status, patient_name, patient_phone, patient_uhid, abha_id, primary_diagnosis, icd_code, procedure_name, treating_doctor_name, department_name, admission_date, discharge_date, estimated_amount, approved_amount, claimed_amount, tpa_claim_number, tpa_preauth_number, policy_number, policy_holder_name';

export async function findPayerId(code: string): Promise<string> {
  const sb = await getSupabase();
  const { data } = await sb.from('clm_payers').select('id').eq('code', code).eq('is_active', true)
    .order('tenant_id', { nullsFirst: false }).limit(1).maybeSingle();
  if (!data) throw new Error(`Payer code "${code}" not found in clm_payers`);
  return data.id;
}

export async function fetchPendingClaims(payerId: string, centreId: string, action: BotAction): Promise<ClaimData[]> {
  const sb = await getSupabase();
  const statuses = PENDING_STATUSES[action === 'poll_all' ? 'check_status' : action];
  let q = sb.from('clm_claims').select(CLAIM_FIELDS)
    .eq('payer_id', payerId).eq('centre_id', centreId).in('status', statuses)
    .order('created_at', { ascending: true }).limit(50);

  // H1 Claims re-submitted the same pre-auth every 15 minutes: nothing marked
  // it done. Now a claim is picked once — until it has a payer reference or
  // the bot has recorded an attempt.
  if (action === 'submit_preauth') q = q.is('tpa_preauth_number', null);
  const { data, error } = await q;
  if (error) { logger.error({ code: error.code }, 'Failed to fetch pending claims'); return []; }
  let rows = (data ?? []) as ClaimData[];

  if (action === 'submit_preauth' && rows.length) {
    const { data: tried } = await sb.from('clm_events').select('claim_id')
      .in('claim_id', rows.map((r) => r.id)).eq('event_type', 'bot_preauth_attempted');
    const done = new Set((tried ?? []).map((t) => t.claim_id));
    rows = rows.filter((r) => !done.has(r.id));
  }
  if (action === 'download_letter' && rows.length) {
    const { data: have } = await sb.from('clm_documents').select('claim_id, doc_code')
      .in('claim_id', rows.map((r) => r.id)).eq('source', 'bot');
    const got = new Set((have ?? []).map((d) => `${d.claim_id}:${d.doc_code}`));
    rows = rows.filter((r) => !got.has(`${r.id}:${letterCodeFor(r.status)}`));
  }
  return rows;
}

/** Which checklist document a downloaded letter fills, by claim status. */
export function letterCodeFor(status: string): string {
  return status.startsWith('preauth') ? 'preauth_approval' : 'approval_letter';
}

/** Apply a portal result. The database refuses illegal jumps; we log and move on. */
export async function applyPortalResult(claimId: string, toStatus: string | null,
  fields: { tpa_claim_number?: string; tpa_preauth_number?: string; approved_amount?: number }, note: string): Promise<void> {
  const sb = await getSupabase();
  const { error } = await sb.rpc('clm_bot_apply', { p_claim_id: claimId, p_to_status: toStatus, p_fields: fields, p_note: note });
  if (error) throw new Error(error.message);
}

export async function recordEvent(claimId: string, eventType: string, payload: Record<string, unknown>): Promise<void> {
  const sb = await getSupabase();
  await sb.from('clm_events').insert({ claim_id: claimId, event_type: eventType, payload });
}

export async function logBotRun(run: BotRunRecord): Promise<string | null> {
  const sb = await getSupabase();
  const { data, error } = await sb.from('clm_bot_runs').insert({
    tenant_id: tenantId, centre_id: run.centre_id, payer_id: run.payer_id, action: run.action,
    status: run.status, started_at: run.started_at, steps_completed: run.steps_completed,
    total_steps: run.total_steps, claims_processed: run.claims_processed, claims_updated: run.claims_updated,
  }).select('id').single();
  if (error) { logger.error({ code: error.code }, 'Failed to log bot run'); return null; }
  return data.id;
}

export async function updateBotRun(runId: string | null, updates: Partial<BotRunRecord>): Promise<void> {
  if (!runId) return;
  const sb = await getSupabase();
  await sb.from('clm_bot_runs').update(updates).eq('id', runId);
}

/** Upload a downloaded letter into the claim's private folder; a person still verifies it. */
export async function uploadLetter(claimId: string, docCode: string, fileName: string, buffer: Buffer, mimeType: string): Promise<void> {
  const sb = await getSupabase();
  const safe = fileName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  const path = `${tenantId}/${claimId}/${Date.now()}_bot_${safe}`;
  const { error: ue } = await sb.storage.from('claim-documents').upload(path, buffer, { contentType: mimeType });
  if (ue) throw new Error(ue.message);
  const { error } = await sb.from('clm_documents').insert({
    claim_id: claimId, doc_code: docCode, document_name: `Payer letter — ${safe}`, document_category: 'correspondence',
    file_path: path, file_size_bytes: buffer.length, mime_type: mimeType, source: 'bot',
  });
  if (error) throw new Error(error.message);
}

/**
 * Drop a downloaded payment statement into the inbox. Staff see it on
 * "Upload payments" and press Save; the bot itself never writes to bills.
 * Returns false when the same statement was already dropped.
 */
export async function dropStatement(centreId: string, payerId: string | null, sourceLabel: string, fileName: string,
  rows: string[][]): Promise<boolean> {
  const sb = await getSupabase();
  const { error } = await sb.from('clm_bot_inbox').insert({
    tenant_id: tenantId, centre_id: centreId, payer_id: payerId, source_label: sourceLabel,
    file_name: fileName.slice(0, 200), rows, row_count: rows.length,
  });
  if (error?.code === '23505') return false;
  if (error) throw new Error(`Could not save the statement (${error.code})`); // no row contents in errors
  return true;
}
