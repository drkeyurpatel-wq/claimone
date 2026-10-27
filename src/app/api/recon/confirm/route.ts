// Save confirmed matches (allocations + adjustments) in one transaction.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, fail, fromDbError, uuid } from '@/lib/api/route';
import { DISALLOWANCE_CATEGORIES } from '@/lib/engine/settlement';

const Adj = z.object({
  kind: z.enum(['tds', 'deduction', 'rounding']),
  amount: z.number().finite().positive(),
  category: z.enum(Object.keys(DISALLOWANCE_CATEGORIES) as [string, ...string[]]).optional(),
  reason_text: z.string().trim().max(500).optional(),
});
const Item = z.object({
  receipt_id: uuid, receivable_id: uuid, amount: z.number().finite().nonnegative(),
  method: z.enum(['advice', 'utr', 'amount', 'bulk', 'manual']), remittance_line_id: uuid.optional(),
  adjustments: z.array(Adj).max(5).default([]),
});
const Body = z.object({ items: z.array(Item).min(1).max(1000) });

export async function POST(req: Request) {
  const auth = await requireUser();
  if ('error' in auth) return auth.error;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? 'Bad request');
  const { data, error } = await auth.supabase.rpc('clm_confirm_matches', { p_items: parsed.data.items });
  if (error) return fromDbError(error);
  return NextResponse.json({ ok: true, saved: data });
}
