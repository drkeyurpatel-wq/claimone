// Record TDS, a payer deduction (with reason), a discount, a write-off (manager)
// or a refund owed back, against one receivable.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, fail, fromDbError, uuid } from '@/lib/api/route';
import { DISALLOWANCE_CATEGORIES } from '@/lib/engine/settlement';

const Body = z.object({
  kind: z.enum(['tds', 'deduction', 'discount', 'write_off', 'refund_due', 'rounding', 'financing_cost']),
  amount: z.number().finite().positive(),
  category: z.enum(Object.keys(DISALLOWANCE_CATEGORIES) as [string, ...string[]]).optional(),
  reason_text: z.string().trim().max(500).optional(),
}).refine((b) => b.kind !== 'deduction' || !!b.category, { message: 'Choose a deduction reason.' })
  .refine((b) => !['deduction', 'write_off'].includes(b.kind) || !!b.reason_text, { message: 'Write the reason.' });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!uuid.safeParse(id).success) return fail(400, 'Bad id');
  const auth = await requireUser();
  if ('error' in auth) return auth.error;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? 'Bad request');
  const b = parsed.data;
  const { error } = await auth.supabase.from('clm_adjustments').insert({
    receivable_id: id, kind: b.kind, amount: b.kind === 'refund_due' ? -b.amount : b.amount,
    category: b.category ?? null, reason_text: b.reason_text ?? null,
  });
  if (error) return fromDbError(error);
  return NextResponse.json({ ok: true });
}
