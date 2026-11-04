'use client';
/**
 * Payments → To check: only what needs a person.
 * 1. Bank money not tied to a bill (after the automatic matching).
 * 2. Bills that are not on Master and do not add up (bills on Master are worked from their Payment cell).
 * 3. Payments recorded from a letter that the bank statement does not show, 7+ days on.
 */
import { sb } from '@/lib/supabase/browser';
import { fetchExceptions, type ExceptionRow } from './api';
import { openMoney } from './auto';

export const NOT_IN_BANK_DAYS = 7;

/** Bills with no patient on Master that are short, unpaid or overpaid. */
export async function fetchBillsNotOnMaster(centreId: string): Promise<ExceptionRow[]> {
  return (await fetchExceptions(centreId)).filter((r) => !r.claim_id);
}

export interface NotInBank { id: string; value_date: string; amount: number; reference: string | null; patient: string | null; payer: string | null }

/**
 * Letter payments the bank statement should already show but does not. Only dates the uploaded
 * statements cover count, so nothing is flagged before a statement for that period is in.
 */
export async function fetchNotInBank(centreId: string, now = new Date()): Promise<NotInBank[]> {
  const span = async (asc: boolean) => (await sb().from('clm_receipts').select('value_date').eq('centre_id', centreId).eq('source', 'bank')
    .order('value_date', { ascending: asc }).limit(1).maybeSingle()).data?.value_date as string | undefined;
  const [from, to] = await Promise.all([span(true), span(false)]);
  if (!from || !to) return [];
  const cutoff = new Date(now.getTime() - NOT_IN_BANK_DAYS * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const until = to < cutoff ? to : cutoff;
  if (until < from) return [];
  const { data, error } = await sb().from('clm_receipts')
    .select('id, value_date, amount, reference, clm_allocations(reversed_at, clm_receivables(patient_name, debtor_name))')
    .eq('centre_id', centreId).eq('source', 'advice').is('bank_receipt_id', null)
    .gte('value_date', from).lte('value_date', until).order('value_date').limit(2000);
  if (error) return [];
  type Row = { id: string; value_date: string; amount: number; reference: string | null;
    clm_allocations: { reversed_at: string | null; clm_receivables: { patient_name: string | null; debtor_name: string | null } | null }[] };
  return ((data ?? []) as unknown as Row[])
    .map((r) => {
      const live = r.clm_allocations.find((a) => !a.reversed_at)?.clm_receivables ?? null;
      return { id: r.id, value_date: r.value_date, amount: Number(r.amount), reference: r.reference, patient: live?.patient_name ?? null, payer: live?.debtor_name ?? null, kept: !!live };
    })
    .filter((r) => r.kept)
    .map(({ kept: _k, ...r }) => r);
}

/** How many items wait on To check (for the Upload screen). */
export async function countToCheck(centreId: string): Promise<number> {
  const [money, bills, bank] = await Promise.all([openMoney(centreId), fetchBillsNotOnMaster(centreId), fetchNotInBank(centreId)]);
  return money.receipts.length + bills.length + bank.length;
}
