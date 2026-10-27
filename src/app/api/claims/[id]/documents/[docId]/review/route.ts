// Mark a document valid / invalid (with reason) / back to unreviewed.
// Only 'valid' documents count towards the submission gate.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, fail, fromDbError, uuid } from '@/lib/api/route';

const Body = z.object({
  status: z.enum(['valid', 'invalid', 'uploaded']),
  note: z.string().trim().max(500).optional(),
}).refine((b) => b.status !== 'invalid' || (b.note && b.note.length > 0), { message: 'Say why the document was rejected.' });

export async function POST(req: Request, ctx: { params: Promise<{ id: string; docId: string }> }) {
  const { id, docId } = await ctx.params;
  if (!uuid.safeParse(id).success || !uuid.safeParse(docId).success) return fail(400, 'Bad id');
  const auth = await requireUser();
  if ('error' in auth) return auth.error;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, parsed.error.issues[0]?.message ?? 'Bad request');

  const { data, error } = await auth.supabase.from('clm_documents')
    .update({ status: parsed.data.status, review_note: parsed.data.note ?? null })
    .eq('id', docId).eq('claim_id', id).select('id');
  if (error) return fromDbError(error);
  if (!data?.length) return fail(403, 'You cannot review documents on this claim.');
  return NextResponse.json({ ok: true });
}
