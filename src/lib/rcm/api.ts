'use client';
// Browser data access for the RCM desks. Reads go through RLS; the import
// and sponsor mapping go through database functions that check access.
import { sb } from '@/lib/supabase/browser';
import type { Claim, Payer } from '@/lib/claims/types';
import type { CaseRow } from './ecw';
import { nextStep, type Step } from './worklist';

export const CASE_SELECT =
  'id, tenant_id, centre_id, payer_id, claim_number, claim_type, status, patient_name, patient_uhid, admission_ref, ' +
  'treating_doctor_name, department_name, admission_date, discharge_date, admitted_at, discharged_at, intimated_at, ' +
  'estimated_amount, claimed_amount, approved_amount, settled_amount, bill_no, bill_amount, patient_paid, sponsor_name, ' +
  'tpa_claim_number, tpa_preauth_number, preauth_submitted_at, submitted_at, is_query_pending, case_source, created_at, updated_at, ' +
  'clm_payers!clm_claims_payer_id_fkey(id, code, name, type, channel, is_nhcx_live, nhcx_code)';

export type CaseRowDb = Claim;
export interface CaseWithStep { c: Claim; step: Step }

const OPEN = ['draft', 'preauth_pending', 'preauth_query', 'preauth_approved', 'preauth_enhanced', 'preauth_rejected',
  'claim_submitted', 'claim_under_review', 'claim_query', 'claim_approved', 'claim_partial', 'claim_rejected', 'settlement_pending'];

export async function fetchOpenCases(centreId: string): Promise<CaseWithStep[]> {
  const { data, error } = await sb().from('clm_claims').select(CASE_SELECT)
    .eq('centre_id', centreId).in('status', OPEN).order('created_at', { ascending: false }).limit(3000);
  if (error) throw new Error('Could not load cases');
  const now = new Date();
  return ((data ?? []) as unknown as Claim[]).map((c) => ({ c, step: nextStep(c, now) }));
}

export async function fetchCase(id: string): Promise<Claim | null> {
  const { data } = await sb().from('clm_claims').select(CASE_SELECT).eq('id', id).maybeSingle();
  return (data as unknown as Claim) ?? null;
}

export interface ImportResult { created: number; updated: number; cash: number; skipped: number; bills: number; unknown_sponsors: string[] }

/** Send the export in chunks so one big month does not time out. */
export async function importCases(centreId: string, file: string, rows: CaseRow[],
  onProgress?: (done: number) => void): Promise<ImportResult> {
  const total: ImportResult = { created: 0, updated: 0, cash: 0, skipped: 0, bills: 0, unknown_sponsors: [] };
  const CHUNK = 400;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { data, error } = await sb().rpc('clm_import_cases', { p_centre: centreId, p_file: file, p_rows: rows.slice(i, i + CHUNK) });
    if (error) throw new Error(`${error.message} (saved ${i} of ${rows.length} rows before this)`);
    const r = data as ImportResult;
    total.created += r.created; total.updated += r.updated; total.cash += r.cash; total.skipped += r.skipped; total.bills += r.bills;
    for (const s of r.unknown_sponsors ?? []) if (!total.unknown_sponsors.includes(s)) total.unknown_sponsors.push(s);
    onProgress?.(Math.min(i + CHUNK, rows.length));
  }
  return total;
}

export async function mapSponsor(sponsor: string, payerId: string | null, credit: boolean) {
  const { error } = await sb().rpc('clm_map_sponsor', { p_sponsor: sponsor, p_payer: payerId, p_credit: credit });
  if (error) throw new Error(error.message);
}

export async function fetchAllPayers(): Promise<Payer[]> {
  const { data } = await sb().from('clm_payers').select('*').eq('is_active', true).order('name');
  return (data ?? []) as Payer[];
}

export interface NhcxMessage {
  id: string; claim_id: string | null; direction: 'out' | 'in'; api_call: string; action: string; status: string;
  correlation_id: string; http_status: number | null; error: string | null; summary: Record<string, unknown>;
  created_at: string; handled_at: string | null;
}

export async function fetchNhcxMessages(claimId: string): Promise<NhcxMessage[]> {
  const { data } = await sb().from('clm_nhcx_messages')
    .select('id, claim_id, direction, api_call, action, status, correlation_id, http_status, error, summary, created_at, handled_at')
    .eq('claim_id', claimId).order('created_at', { ascending: false }).limit(50);
  return (data ?? []) as NhcxMessage[];
}

export async function markNhcxHandled(id: string, status: 'applied' | 'ignored') {
  const { error } = await sb().from('clm_nhcx_messages').update({ status, handled_at: new Date().toISOString() }).eq('id', id);
  if (error) throw new Error(error.message);
}
