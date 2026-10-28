// Short-lived link to a private document (10 minutes).
import { NextResponse } from 'next/server';
import { requireUser, fail, uuid } from '@/lib/api/route';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string; docId: string }> }) {
  const { id, docId } = await ctx.params;
  if (!uuid.safeParse(id).success || !uuid.safeParse(docId).success) return fail(400, 'Bad id');
  const auth = await requireUser();
  if ('error' in auth) return auth.error;

  // RLS: the row is only visible if the user may see the claim.
  const { data: doc } = await auth.supabase.from('clm_documents')
    .select('file_path').eq('id', docId).eq('claim_id', id).maybeSingle();
  if (!doc) return fail(404, 'Document not found.');
  if (!doc.file_path) return fail(404, 'This paper was ticked as sent to the insurer — there is no file to open.');

  const { data, error } = await auth.supabase.storage.from('claim-documents').createSignedUrl(doc.file_path, 600);
  if (error || !data) return fail(404, 'File not found in storage.');
  return NextResponse.json({ url: data.signedUrl }, { headers: { 'Cache-Control': 'no-store' } });
}
