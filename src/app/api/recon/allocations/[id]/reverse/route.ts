// Undo a wrong match. The allocation stays on record, stamped as reversed.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, fail, fromDbError, uuid } from '@/lib/api/route';

const Body = z.object({ reason: z.string().trim().min(3, 'Say why the match was wrong.').max(300), table: z.enum(['allocation', 'adjustment']).default('allocation') });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!uuid.safeParse(id).success) return fail(400, 'Bad id');
  const auth = await requireUser();
  if ('error' in auth) return auth.error;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? 'Bad request');
  const table = parsed.data.table === 'allocation' ? 'clm_allocations' : 'clm_adjustments';
  const patch = parsed.data.table === 'allocation'
    ? { reversed_at: new Date().toISOString(), reverse_reason: parsed.data.reason }
    : { reversed_at: new Date().toISOString() };
  const { data, error } = await auth.supabase.from(table).update(patch).eq('id', id).is('reversed_at', null).select('id');
  if (error) return fromDbError(error);
  if (!data?.length) return fail(404, 'Not found, or already reversed.');
  return NextResponse.json({ ok: true });
}
