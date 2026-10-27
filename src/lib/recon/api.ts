'use client';
// Browser data access for receivables and reconciliation.
import { sb } from '@/lib/supabase/browser';
import type { AdviceRow, OpenReceipt, OpenReceivable, Proposal } from './match';

export type DebtorType = 'insurer' | 'tpa' | 'government' | 'corporate' | 'patient' | 'referrer';
export type ReconStatus = 'open' | 'part_received' | 'settled' | 'over_received' | 'disputed';

export interface ReceivableRow {
  id: string; centre_id: string; claim_id: string | null; debtor_type: DebtorType; payer_id: string | null; debtor_name: string;
  bill_no: string | null; ip_no: string | null; claim_ref: string | null; bill_date: string; patient_name: string | null;
  doctor_name: string | null; care_of: string | null; billed_amount: number | null; expected_amount: number;
  recorded_utr: string | null; status: 'open' | 'disputed' | 'closed'; notes: string | null; source: string;
  allocated: number; tds: number; deduction: number; discount: number; write_off: number; refund_due: number; other_adj: number;
  balance: number; age_days: number; recon_status: ReconStatus; last_receipt_date: string | null;
}

export interface ReceiptRow {
  id: string; centre_id: string; source: 'bank' | 'manual'; bank_account: string | null; value_date: string; amount: number;
  reference: string | null; narration: string | null; payer_id: string | null; allocated: number; unallocated: number;
}

export interface AllocationRow {
  id: string; receipt_id: string; receivable_id: string; amount: number; method: string; reversed_at: string | null;
  reverse_reason: string | null; created_at: string;
}

export interface AdjustmentRow {
  id: string; receivable_id: string; kind: string; amount: number; category: string | null; reason_text: string | null;
  reversed_at: string | null; created_at: string;
}

const num = <T extends Record<string, unknown>>(r: T, keys: string[]) => {
  const o: Record<string, unknown> = { ...r };
  for (const k of keys) o[k] = o[k] == null ? o[k] : Number(o[k]);
  return o as T;
};
const RV_NUM = ['billed_amount', 'expected_amount', 'allocated', 'tds', 'deduction', 'discount', 'write_off', 'refund_due', 'other_adj', 'balance', 'age_days'];

export async function fetchReceivables(centreId: string, opts: { openOnly?: boolean } = {}): Promise<ReceivableRow[]> {
  let q = sb().from('clm_v_receivable_balance').select('*').eq('centre_id', centreId).order('bill_date', { ascending: true }).limit(5000);
  if (opts.openOnly) q = q.neq('recon_status', 'settled');
  const { data, error } = await q;
  if (error) { console.error('fetchReceivables', error.code); return []; }
  return (data ?? []).map((r: Record<string, unknown>) => num(r, RV_NUM) as unknown as ReceivableRow);
}

export async function fetchReceivable(id: string) {
  const [{ data: rv }, { data: al }, { data: adj }] = await Promise.all([
    sb().from('clm_v_receivable_balance').select('*').eq('id', id).maybeSingle(),
    sb().from('clm_allocations').select('*, clm_receipts(value_date, reference, narration, amount)').eq('receivable_id', id).order('created_at'),
    sb().from('clm_adjustments').select('*').eq('receivable_id', id).order('created_at'),
  ]);
  return {
    receivable: rv ? (num(rv, RV_NUM) as unknown as ReceivableRow) : null,
    allocations: (al ?? []) as (AllocationRow & { clm_receipts: { value_date: string; reference: string | null; narration: string | null; amount: number } | null })[],
    adjustments: (adj ?? []) as AdjustmentRow[],
  };
}

export async function fetchReceipts(centreId: string, opts: { unallocatedOnly?: boolean } = {}): Promise<ReceiptRow[]> {
  let q = sb().from('clm_v_receipt_balance').select('*').eq('centre_id', centreId).order('value_date', { ascending: false }).limit(5000);
  if (opts.unallocatedOnly) q = q.gt('unallocated', 1);
  const { data } = await q;
  return (data ?? []).map((r: Record<string, unknown>) => num(r, ['amount', 'allocated', 'unallocated']) as unknown as ReceiptRow);
}

export async function fetchUnusedAdvice(centreId: string): Promise<AdviceRow[]> {
  const { data } = await sb().from('clm_remittance_lines').select('id, utr, claim_ref, bill_no, patient_name, tds_amount, deduction_amount, deduction_reason, net_amount')
    .eq('centre_id', centreId).limit(5000);
  const { data: used } = await sb().from('clm_allocations').select('remittance_line_id').not('remittance_line_id', 'is', null).is('reversed_at', null);
  const done = new Set((used ?? []).map((u: { remittance_line_id: string }) => u.remittance_line_id));
  return ((data ?? []) as AdviceRow[]).filter((a) => !done.has(a.id))
    .map((a) => ({ ...a, tds_amount: Number(a.tds_amount), deduction_amount: Number(a.deduction_amount), net_amount: Number(a.net_amount) }));
}

export const toOpenReceivable = (r: ReceivableRow): OpenReceivable => ({
  id: r.id, debtor_name: r.debtor_name, payer_id: r.payer_id, claim_ref: r.claim_ref, bill_no: r.bill_no,
  patient_name: r.patient_name, bill_date: r.bill_date, balance: r.balance, recorded_utr: r.recorded_utr,
});
export const toOpenReceipt = (r: ReceiptRow): OpenReceipt => ({
  id: r.id, value_date: r.value_date, unallocated: r.unallocated, reference: r.reference, narration: r.narration, payer_id: r.payer_id,
});

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json as T;
}

export const importRows = (body: Record<string, unknown>) =>
  post<{ ok: true; inserted: number; duplicates: number }>('/api/recon/import', body);

export const confirmMatches = (items: Proposal[]) =>
  post<{ ok: true; saved: number }>('/api/recon/confirm', {
    items: items.map((p) => ({
      receipt_id: p.receipt_id, receivable_id: p.receivable_id, amount: p.amount, method: p.method,
      remittance_line_id: p.remittance_line_id, adjustments: p.adjustments,
    })),
  });

export const manualMatch = (receipt_id: string, receivable_id: string, amount: number) =>
  post<{ ok: true }>('/api/recon/confirm', { items: [{ receipt_id, receivable_id, amount, method: 'manual', adjustments: [] }] });

export const addAdjustment = (id: string, body: { kind: string; amount: number; category?: string; reason_text?: string }) =>
  post<{ ok: true }>(`/api/recon/receivables/${id}/adjust`, body);

export const reverse = (id: string, reason: string, table: 'allocation' | 'adjustment' = 'allocation') =>
  post<{ ok: true }>(`/api/recon/allocations/${id}/reverse`, { reason, table });
