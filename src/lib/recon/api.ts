'use client';
// Browser data access for receivables and reconciliation.
import { sb } from '@/lib/supabase/browser';
import type { AdviceRow, OpenReceipt, OpenReceivable, Proposal } from './match';
import type { PaymentLine } from './payments';

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
  id: string; centre_id: string; source: 'bank' | 'manual' | 'advice'; bank_account: string | null; value_date: string; amount: number;
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

// ─── Weekly upload ───────────────────────────────────────────────────

export type Problem = 'short' | 'over' | 'overdue';
export interface ExceptionRow {
  receivable_id: string; debtor_type: DebtorType; debtor_name: string; patient_name: string | null; uhid: string | null;
  bill_no: string | null; claim_ref: string | null; bill_date: string; expected_amount: number; allocated: number; tds: number;
  deduction: number; balance: number; age_days: number; last_receipt_date: string | null; problem: Problem;
}

export async function fetchExceptions(centreId: string): Promise<ExceptionRow[]> {
  const { data, error } = await sb().from('clm_v_exceptions').select('*').eq('centre_id', centreId).order('bill_date').limit(5000);
  if (error) { console.error('fetchExceptions', error.code); return []; }
  return (data ?? []).map((r: Record<string, unknown>) =>
    num(r, ['expected_amount', 'allocated', 'tds', 'deduction', 'balance', 'age_days']) as unknown as ExceptionRow);
}

export interface ApplyResult { matched: number; created: number; unpaid: number; duplicate: number; skipped: number; invalid: number }

/** Send lines in chunks so a 2,600-row PMJAY sheet stays inside the database time limit. */
export async function applyPayments(centre_id: string, file_name: string, lines: PaymentLine[], onProgress?: (done: number) => void): Promise<ApplyResult> {
  const total: ApplyResult = { matched: 0, created: 0, unpaid: 0, duplicate: 0, skipped: 0, invalid: 0 };
  for (let i = 0; i < lines.length; i += 250) {
    let r: ApplyResult;
    try {
      r = await post<ApplyResult>('/api/recon/apply', { centre_id, file_name, lines: lines.slice(i, i + 250) });
    } catch (e) {
      // earlier chunks are saved; uploading the same file again finishes the rest without double counting
      throw new Error(`${file_name}: stopped after ${i.toLocaleString('en-IN')} of ${lines.length.toLocaleString('en-IN')} lines `
        + `(${total.matched.toLocaleString('en-IN')} payments saved). ${(e as Error).message} Upload the same file again to finish.`);
    }
    for (const k of Object.keys(total) as (keyof ApplyResult)[]) total[k] += Number(r[k] ?? 0);
    onProgress?.(Math.min(i + 250, lines.length));
  }
  return total;
}

export async function readLetter(input: { file?: Blob; fileName?: string; text?: string }): Promise<PaymentLine[]> {
  const fd = new FormData();
  if (input.file) fd.append('file', input.file, input.fileName ?? 'letter');
  if (input.text) fd.append('text', input.text);
  const res = await fetch('/api/recon/read-letter', { method: 'POST', body: fd });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Could not read the letter (${res.status})`);
  return json.lines as PaymentLine[];
}

export async function setDisputed(id: string, note: string) {
  const { error } = await sb().from('clm_receivables').update({ status: 'disputed', notes: note }).eq('id', id);
  if (error) throw new Error(error.message);
}

/** Payer paid more than the bill on file: take what was paid as the right amount. */
export async function acceptPaidAmount(id: string, newExpected: number) {
  const { error } = await sb().from('clm_receivables').update({ expected_amount: Math.max(0, Math.round(newExpected * 100) / 100) }).eq('id', id);
  if (error) throw new Error(error.message);
}
