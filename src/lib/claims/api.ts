'use client';
// ClaimOne — browser data access.
// Reads go straight to Supabase (RLS scopes them). Every status change,
// document review and settlement goes through an API route so the server
// can return a readable reason when the database refuses it.

import { sb } from '@/lib/supabase/browser';
import type {
  Claim, ClaimStatus, ClaimType, ClaimDocument, ClaimQuery, DocRuleRow, OpenQuery,
  Payer, TimelineEvent, AgingRow, PayerScorecard, LeakageRow, BotRun,
} from './types';
import type { DisallowanceCategory } from '@/lib/engine/settlement';

const CLAIM_SELECT = '*, clm_payers!clm_claims_payer_id_fkey(id, code, name, type)';

/** PostgREST `or()` filters are comma/paren separated — strip those from user input. */
export function safeSearch(s: string): string {
  return s.replace(/[,()*%\\]/g, ' ').trim().slice(0, 60);
}

async function call<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error || `Request failed (${res.status})`) as Error & { blockers?: string[] };
    err.blockers = json.blockers;
    throw err;
  }
  return json as T;
}

// ─── Dashboard ───────────────────────────────────────────────────────

export interface ClaimStats {
  total: number; preauth_pending: number; open_queries: number; under_review: number;
  settlement_pending: number; settled: number; rejected: number;
  total_settled: number; total_outstanding: number;
  blocked: number; blocked_amount: number;
}

export async function fetchClaimStats(centreId: string): Promise<ClaimStats | null> {
  const [{ data, error }, { data: ready }] = await Promise.all([
    sb().from('clm_claims')
      .select('status, claimed_amount, settled_amount, estimated_amount, approved_amount')
      .eq('centre_id', centreId),
    sb().from('clm_v_readiness').select('amount, unmet_count').eq('centre_id', centreId).gt('unmet_count', 0),
  ]);
  if (error) { console.error('fetchClaimStats', error); return null; }
  type Row = { status: string; claimed_amount: number | null; settled_amount: number | null; estimated_amount: number | null; approved_amount: number | null };
  const c = (data ?? []) as Row[];
  const r = (ready ?? []) as { amount: number | null }[];
  const n = (xs: ClaimStatus[]) => c.filter((x) => xs.includes(x.status as ClaimStatus)).length;
  return {
    total: c.length,
    preauth_pending: n(['preauth_pending', 'preauth_query']),
    open_queries: n(['preauth_query', 'claim_query']),
    under_review: n(['claim_submitted', 'claim_under_review']),
    settlement_pending: n(['claim_approved', 'claim_partial', 'settlement_pending']),
    settled: n(['settled', 'closed']),
    rejected: n(['preauth_rejected', 'claim_rejected']),
    total_settled: c.reduce((s, x) => s + (Number(x.settled_amount) || 0), 0),
    total_outstanding: c
      .filter((x) => ['claim_submitted', 'claim_under_review', 'claim_query', 'claim_approved', 'claim_partial', 'settlement_pending'].includes(x.status))
      .reduce((s, x) => s + Number(x.approved_amount ?? x.claimed_amount ?? x.estimated_amount ?? 0), 0),
    blocked: r.length,
    blocked_amount: r.reduce((s, x) => s + Number(x.amount || 0), 0),
  };
}

export async function fetchClaims(centreId: string, f: {
  statuses?: ClaimStatus[]; payer_id?: string; claim_type?: ClaimType; search?: string; limit?: number;
} = {}): Promise<Claim[]> {
  let q = sb().from('clm_claims').select(CLAIM_SELECT)
    .eq('centre_id', centreId).order('created_at', { ascending: false }).limit(f.limit ?? 200);
  if (f.statuses?.length) q = q.in('status', f.statuses);
  if (f.payer_id) q = q.eq('payer_id', f.payer_id);
  if (f.claim_type) q = q.eq('claim_type', f.claim_type);
  const s = f.search ? safeSearch(f.search) : '';
  if (s) q = q.or(`patient_name.ilike.*${s}*,claim_number.ilike.*${s}*,tpa_claim_number.ilike.*${s}*,patient_uhid.ilike.*${s}*`);
  const { data, error } = await q;
  if (error) { console.error('fetchClaims', error); return []; }
  return (data ?? []) as Claim[];
}

export async function fetchClaim(id: string): Promise<Claim | null> {
  const { data, error } = await sb().from('clm_claims').select(CLAIM_SELECT).eq('id', id).maybeSingle();
  if (error) { console.error('fetchClaim', error); return null; }
  return data as Claim | null;
}

export async function fetchPayers(): Promise<Payer[]> {
  const { data } = await sb().from('clm_payers').select('*').eq('is_active', true).order('name');
  return (data ?? []) as Payer[];
}

// ─── Claim detail ────────────────────────────────────────────────────

export async function fetchClaimTimeline(claimId: string): Promise<TimelineEvent[]> {
  const { data } = await sb().from('clm_v_timeline').select('*').eq('claim_id', claimId).order('created_at', { ascending: false });
  return (data ?? []) as TimelineEvent[];
}

export async function fetchClaimQueries(claimId: string): Promise<ClaimQuery[]> {
  const { data } = await sb().from('clm_queries').select('*').eq('claim_id', claimId).order('query_number');
  return (data ?? []) as ClaimQuery[];
}

export async function fetchClaimDocuments(claimId: string): Promise<ClaimDocument[]> {
  const { data } = await sb().from('clm_documents').select('*').eq('claim_id', claimId).order('created_at');
  return (data ?? []) as ClaimDocument[];
}

/** All rules that could apply to this payer; the engine picks the winners. */
export async function fetchDocRules(payerId?: string): Promise<DocRuleRow[]> {
  let q = sb().from('clm_doc_rules').select('*').eq('is_active', true).order('sort_order');
  if (payerId) q = q.or(`payer_id.is.null,payer_id.eq.${payerId}`);
  const { data } = await q;
  return (data ?? []) as DocRuleRow[];
}

// ─── Queues & reports ───────────────────────────────────────────────

export async function fetchOpenQueries(centreId: string): Promise<OpenQuery[]> {
  const { data } = await sb().from('clm_v_open_queries').select('*').eq('centre_id', centreId).order('sla_deadline');
  return (data ?? []) as OpenQuery[];
}

export async function fetchRejectedClaims(centreId: string): Promise<Claim[]> {
  const { data } = await sb().from('clm_claims').select(CLAIM_SELECT).eq('centre_id', centreId)
    .in('status', ['preauth_rejected', 'claim_rejected']).order('updated_at', { ascending: false }).limit(50);
  return (data ?? []) as Claim[];
}

export async function fetchAging(centreId?: string): Promise<AgingRow[]> {
  let q = sb().from('clm_v_aging').select('*');
  if (centreId) q = q.eq('centre_id', centreId);
  const { data } = await q;
  return (data ?? []) as AgingRow[];
}

export async function fetchPayerScorecard(): Promise<PayerScorecard[]> {
  const { data } = await sb().from('clm_v_payer_scorecard').select('*').order('total_claims', { ascending: false });
  return (data ?? []) as PayerScorecard[];
}

export async function fetchLeakage(centreId: string): Promise<LeakageRow[]> {
  const { data } = await sb().from('clm_v_leakage').select('*').eq('centre_id', centreId);
  return (data ?? []) as LeakageRow[];
}

export async function fetchBotRuns(centreId: string): Promise<BotRun[]> {
  const { data } = await sb().from('clm_bot_runs').select('*').eq('centre_id', centreId)
    .order('started_at', { ascending: false }).limit(100);
  return (data ?? []) as BotRun[];
}

// ─── Writes ──────────────────────────────────────────────────────────

export type NewClaim = Omit<Partial<Claim>, 'id' | 'status' | 'claim_number' | 'created_at' | 'updated_at'> & {
  tenant_id: string; centre_id: string; payer_id: string; claim_type: ClaimType; patient_name: string;
};

export async function createClaim(claim: NewClaim): Promise<{ id: string; claim_number: string }> {
  // claim_number is generated by the database; the column is NOT NULL so send a placeholder
  const { data, error } = await sb().from('clm_claims').insert({ ...claim, claim_number: 'pending' })
    .select('id, claim_number').single();
  if (error) throw new Error(error.message);
  return data;
}

/** Edit descriptive fields. Status never changes here — use transition(). */
export async function updateClaimFields(id: string, fields: Partial<Claim>) {
  const { status: _s, tenant_id: _t, claim_number: _n, medpay_synced: _m, ...safe } = fields;
  const { error } = await sb().from('clm_claims').update(safe).eq('id', id);
  if (error) throw new Error(error.message);
}

export function transition(claimId: string, to: ClaimStatus, fields: Record<string, unknown> = {}, note?: string) {
  return call<{ ok: true; status: ClaimStatus }>(`/api/claims/${claimId}/transition`, { to, fields, note });
}

export function reviewDocument(claimId: string, docId: string, status: 'valid' | 'invalid' | 'uploaded', note?: string) {
  return call<{ ok: true }>(`/api/claims/${claimId}/documents/${docId}/review`, { status, note });
}

export async function documentUrl(claimId: string, docId: string): Promise<string> {
  const res = await fetch(`/api/claims/${claimId}/documents/${docId}/url`);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Could not open document');
  return json.url;
}

export function recordSettlement(claimId: string, body: {
  approved: number; tds: number; net: number; utr: string; payment_date: string; payment_mode: string;
  items: { category: DisallowanceCategory; amount: number; reason_text?: string }[];
}) {
  return call<{ ok: true }>(`/api/claims/${claimId}/settle`, body);
}

export async function addClaimQuery(p: {
  claim_id: string; query_text: string; query_category: string; priority: string; routed_to_role?: string; raised_by?: string;
}) {
  const { error } = await sb().from('clm_queries').insert({
    claim_id: p.claim_id, query_text: p.query_text, query_category: p.query_category, priority: p.priority,
    routed_to_role: p.routed_to_role || null, raised_by: p.raised_by || null, source: 'manual',
  });
  if (error) throw new Error(error.message);
}

export async function respondToQuery(queryId: string, responseText: string) {
  const { error } = await sb().from('clm_queries')
    .update({ response_text: responseText, status: 'responded' }).eq('id', queryId);
  if (error) throw new Error(error.message);
}

const SAFE_NAME = /[^a-zA-Z0-9_-]/g;

/** Tick (or untick) a paper as attached on the insurer website. A file is optional. */
export async function tickDocument(claimId: string, docCode: string, label: string, on: boolean) {
  const { error } = await sb().rpc('clm_tick_document', { p_claim: claimId, p_doc_code: docCode, p_label: label, p_on: on });
  if (error) throw new Error(error.message);
}

export async function uploadClaimDocument(p: {
  tenant_id: string; claim_id: string; file: File; document_name: string;
  document_category: ClaimDocument['document_category']; doc_code: string | null;
}) {
  const ext = (p.file.name.split('.').pop() || 'pdf').toLowerCase().replace(SAFE_NAME, '');
  const name = (p.document_name || p.file.name.replace(/\.[^/.]+$/, '')).trim();
  const path = `${p.tenant_id}/${p.claim_id}/${Date.now()}_${name.replace(SAFE_NAME, '_').slice(0, 60)}.${ext}`;
  const { error: ue } = await sb().storage.from('claim-documents').upload(path, p.file, { contentType: p.file.type });
  if (ue) throw new Error(ue.message);
  const { error } = await sb().from('clm_documents').insert({
    claim_id: p.claim_id, doc_code: p.doc_code, document_name: name, document_category: p.document_category,
    file_path: path, file_size_bytes: p.file.size, mime_type: p.file.type, source: 'manual',
  });
  if (error) throw new Error(error.message);
}
