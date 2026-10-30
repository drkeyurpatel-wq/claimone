'use client';
// Browser data access for the RCM desks. Reads go through RLS; the import
// and sponsor mapping go through database functions that check access.
import { sb } from '@/lib/supabase/browser';
import { allRows } from '@/lib/supabase/pages';
import type { Claim, Payer } from '@/lib/claims/types';
import type { CaseRow } from './ecw';
import { nextStep, type Step } from './worklist';
import { CASE_SELECT } from './select';
import { stageOf, type CaseMoney, type StageKey } from './journey';
import { cutOf, cutStep, type Cut } from './cut';

export { CASE_SELECT };

export type CaseRowDb = Claim;
export interface CaseWithStep { c: Claim; step: Step }

const OPEN = ['draft', 'preauth_pending', 'preauth_query', 'preauth_approved', 'preauth_enhanced', 'preauth_rejected',
  'claim_submitted', 'claim_under_review', 'claim_query', 'claim_approved', 'claim_partial', 'claim_rejected', 'settlement_pending'];

export async function fetchOpenCases(centreId: string): Promise<CaseWithStep[]> {
  const { data, error } = await allRows((from, to) => sb().from('clm_claims').select(CASE_SELECT)
    .eq('centre_id', centreId).in('status', OPEN).order('created_at', { ascending: false }).order('id').range(from, to));
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

// ─── Money side of each case (its bill on the receivables book) ─────

const MONEY_SELECT = 'id, claim_id, expected_amount, billed_amount, allocated, tds, deduction, balance, recon_status, status';
const toMoney = (r: Record<string, unknown>): CaseMoney => ({
  receivable_id: r.id as string, claim_id: r.claim_id as string, expected_amount: Number(r.expected_amount ?? 0),
  billed_amount: r.billed_amount == null ? null : Number(r.billed_amount), allocated: Number(r.allocated ?? 0), tds: Number(r.tds ?? 0),
  deduction: Number(r.deduction ?? 0), balance: Number(r.balance ?? 0), recon_status: r.recon_status as CaseMoney['recon_status'], status: r.status as string,
});

/** Bills tied to cases at this centre, keyed by case. Patient-due bills are left out. */
export async function fetchCaseMoney(centreId: string): Promise<Map<string, CaseMoney>> {
  const [{ data }, banked] = await Promise.all([
    allRows((from, to) => sb().from('clm_v_receivable_balance').select(MONEY_SELECT)
      .eq('centre_id', centreId).not('claim_id', 'is', null).neq('debtor_type', 'patient').order('id').range(from, to)),
    allRows((from, to) => sb().from('clm_v_case_banked').select('claim_id, banked').eq('centre_id', centreId).order('claim_id').range(from, to)),
  ]);
  const inBank = new Map(((banked.data ?? []) as { claim_id: string; banked: number }[]).map((b) => [b.claim_id, Number(b.banked)]));
  return new Map(((data ?? []) as Record<string, unknown>[]).map((r) => {
    const m = toMoney(r);
    return [m.claim_id, { ...m, banked: inBank.get(m.claim_id) ?? 0 }];
  }));
}

export async function fetchMoneyFor(claimId: string): Promise<CaseMoney | null> {
  const { data } = await sb().from('clm_v_receivable_balance').select(MONEY_SELECT)
    .eq('claim_id', claimId).neq('debtor_type', 'patient').maybeSingle();
  return data ? toMoney(data as Record<string, unknown>) : null;
}

export interface Journey extends CaseWithStep { money: CaseMoney | null; stage: StageKey }

/** Every file still moving, plus files closed in the last 60 days. */
export async function fetchJourneys(centreId: string): Promise<Journey[]> {
  const since = new Date(Date.now() - 60 * 86_400_000).toISOString();
  const [open, closed, money] = await Promise.all([
    fetchOpenCases(centreId),
    sb().from('clm_claims').select(CASE_SELECT).eq('centre_id', centreId).in('status', ['settled', 'closed', 'written_off'])
      .gte('updated_at', since).limit(1000),
    fetchCaseMoney(centreId),
  ]);
  const now = new Date();
  const all = [...open, ...((closed.data ?? []) as unknown as Claim[]).map((c) => ({ c, step: nextStep(c, now) }))];
  return all.map((x) => {
    const m = money.get(x.c.id) ?? null;
    const stage = stageOf(x.c, m, x.step);
    return { ...x, step: paymentStep(x.step, stage, m, cutOf(x.c, m)), money: m, stage };
  });
}

/** In payment: a cut waits for Accept / Fight (our turn), a fought cut is chased; a part-paid bill needs its reason. */
export function paymentStep(step: Step, stage: StageKey, m: CaseMoney | null, cut: Cut | null = null): Step {
  if (stage !== 'payment') return step;
  const c = cut && cutStep(cut);
  if (c) return { ...step, desk: 'payment', key: 'wait_payment', ...c };
  if (!m || m.allocated <= 0 || m.balance <= 100) return step;
  return { ...step, ours: true, label: 'Short settlement — record reason or dispute', overdue: false, dueAt: null };
}

/** Accept the insurer's cut (the file then closes from its payments) or fight it (the cut stays due). */
export async function decideCut(claimId: string, decision: 'accept' | 'fight', note?: string, category?: string) {
  const { error } = await sb().rpc('clm_decide_cut', { p_claim: claimId, p_decision: decision, p_note: note ?? null, p_category: category ?? null });
  if (error) throw new Error(error.message);
}

// ─── Ledger ─────────────────────────────────────────────────────────

/** A payment typed in for one patient (clm_record_case_payment): booked like an uploaded letter line. */
export async function recordCasePayment(claimId: string, p: { net: number; tds: number; utr: string; date: string }) {
  const { error } = await sb().rpc('clm_record_case_payment', {
    p_claim: claimId, p_net: p.net, p_tds: p.tds, p_utr: p.utr.trim() || null, p_date: p.date || null,
  });
  if (error) throw new Error(error.message);
}

/** Dates as the desk types them: a day in IST. Today keeps the real time it was saved. */
export function istDate(day: string): string | null {
  if (!day) return null;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  return day === today ? null : new Date(`${day}T12:00:00+05:30`).toISOString();
}

/** A dispute letter was sent (1 reconsideration, 2 escalation, 3 patient grievance). */
export async function recordDisputeLetter(claimId: string, level: 1 | 2 | 3) {
  const { error } = await sb().rpc('clm_record_dispute_letter', { p_claim: claimId, p_level: level });
  if (error) throw new Error(error.message);
}

/** The payer's open query on a case (raised text and time), if any. */
export async function fetchOpenQuery(claimId: string): Promise<{ query_text: string; raised_at: string } | null> {
  const { data } = await sb().from('clm_queries').select('query_text, raised_at').eq('claim_id', claimId)
    .in('status', ['open', 'in_progress', 'escalated']).order('query_number', { ascending: false }).limit(1).maybeSingle();
  return (data as { query_text: string; raised_at: string } | null) ?? null;
}

/** Open cases at this centre with the same patient name (to warn before adding a second admission). */
export async function findOpenCasesByName(centreId: string, name: string): Promise<{ admission_ref: string | null; admitted_at: string | null; status: string }[]> {
  const n = name.trim().replace(/[%_,()*\\]/g, ' ').replace(/\s+/g, ' ');
  if (n.length < 3) return [];
  const { data } = await sb().from('clm_claims').select('admission_ref, admitted_at, status').eq('centre_id', centreId)
    .ilike('patient_name', n).not('status', 'in', '(settled,closed,written_off)').limit(5);
  return (data ?? []) as { admission_ref: string | null; admitted_at: string | null; status: string }[];
}

/** A further enhancement on an already-enhanced pre-auth (the first one is a status change). */
export async function recordEnhancement(claimId: string, amount: number, note: string) {
  const { error } = await sb().rpc('clm_record_enhancement', { p_claim: claimId, p_amount: amount, p_note: note || null });
  if (error) throw new Error(error.message);
}

// ─── Payer master ───────────────────────────────────────────────────

/** Add a payer that is not on the list (or get the one already there under that name). */
export async function addPayer(name: string, group: string): Promise<string> {
  const { data, error } = await sb().rpc('clm_add_payer', { p_name: name.trim(), p_group: group });
  if (error) throw new Error(error.message);
  return data as string;
}

export async function savePayer(id: string, name: string, group: string, active: boolean) {
  const { error } = await sb().rpc('clm_save_payer', { p_id: id, p_name: name.trim(), p_group: group, p_active: active });
  if (error) throw new Error(error.message);
}

/** Every payer, active or not, for Settings. */
export async function fetchPayerMaster(): Promise<Payer[]> {
  const { data, error } = await sb().from('clm_payers').select('*').order('name');
  if (error) throw new Error('Could not load the payer list');
  return (data ?? []) as Payer[];
}
