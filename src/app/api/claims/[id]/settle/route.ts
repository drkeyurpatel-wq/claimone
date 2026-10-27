// Record a settlement: approved, TDS, net, UTR and itemised deductions —
// one database transaction (clm_record_settlement).
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, fail, fromDbError, uuid } from '@/lib/api/route';
import { DISALLOWANCE_CATEGORIES } from '@/lib/engine/settlement';
import { notifyStatusChange } from '@/lib/claims/notify.server';

const money = z.number().finite().nonnegative();
const Body = z.object({
  approved: money,
  tds: money,
  net: money,
  utr: z.string().trim().min(4, 'UTR is required').max(40),
  payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  payment_mode: z.enum(['neft', 'rtgs', 'imps', 'cheque', 'other']),
  items: z.array(z.object({
    category: z.enum(Object.keys(DISALLOWANCE_CATEGORIES) as [keyof typeof DISALLOWANCE_CATEGORIES]),
    amount: money,
    reason_text: z.string().trim().max(500).optional(),
  })).max(30).default([]),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!uuid.safeParse(id).success) return fail(400, 'Bad claim id');
  const auth = await requireUser();
  if ('error' in auth) return auth.error;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? 'Check the values entered.');
  const b = parsed.data;

  const { error } = await auth.supabase.rpc('clm_record_settlement', {
    p_claim_id: id, p_approved: b.approved, p_tds: b.tds, p_net: b.net, p_utr: b.utr,
    p_payment_date: b.payment_date, p_payment_mode: b.payment_mode, p_disallowances: b.items,
  });
  if (error) {
    if (error.code === '23505') return fail(409, 'This UTR is already recorded against another settlement.');
    return fromDbError(error);
  }
  await notifyStatusChange(auth.supabase, id, 'settled').catch((e) => console.error('notify', e));
  return NextResponse.json({ ok: true });
}
