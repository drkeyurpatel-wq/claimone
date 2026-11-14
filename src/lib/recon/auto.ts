'use client';
/**
 * After every upload: money in the bank that is not yet tied to a bill is matched where the
 * evidence is strong (same UTR / claim no. on a letter, or a single bill of the same amount).
 * Everything else waits on "To check".
 */
import { proposeMatches, type MatchResult } from './match';
import { CURRENT_FROM } from '@/lib/rcm/ledger';
import { confirmMatches, fetchReceipts, fetchReceivables, fetchUnusedAdvice, toOpenReceipt, toOpenReceivable, type ReceiptRow, type ReceivableRow } from './api';

export interface Open { bills: ReceivableRow[]; receipts: ReceiptRow[]; result: MatchResult }

/** Bank money not yet tied to a bill, the open bills, and what the matcher proposes. */
export async function openMoney(centreId: string): Promise<Open> {
  const [b, r, a] = await Promise.all([
    fetchReceivables(centreId, { openOnly: true }),
    fetchReceipts(centreId, { unallocatedOnly: true }),
    fetchUnusedAdvice(centreId),
  ]);
  const bills = b.filter((x) => x.balance > 1);
  // only money seen in the bank needs matching; a letter's payment is already on its bill
  const receipts = r.filter((x) => x.source === 'bank');
  return { bills, receipts, result: proposeMatches(bills.map(toOpenReceivable), receipts.map(toOpenReceipt), a) };
}

/** Save the strong matches; return how many were saved and how many are left for a person. */
export async function autoMatch(centreId: string): Promise<{ matched: number; left: number }> {
  const { receipts, result } = await openMoney(centreId);
  if (!receipts.length) return { matched: 0, left: 0 };
  const strong = result.proposals.filter((p) => p.confidence === 'high');
  const saved = strong.length ? (await confirmMatches(strong)).saved : 0;
  const tied = new Set(strong.map((p) => p.receipt_id));
  // what is left for a person: credits from 1 Nov only (older ones belong to the Before 1 Nov files)
  return { matched: saved, left: receipts.filter((x) => !tied.has(x.id) && x.value_date >= CURRENT_FROM).length };
}
