// Move a claim to a new status.
// The database trigger is the authority (allowed transitions, the document
// gate, manager-only write-off). This route checks the input, logs refused
// submissions for the audit trail, and turns refusals into plain answers.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, fail, fromDbError, uuid } from '@/lib/api/route';
import { notifyStatusChange } from '@/lib/claims/notify.server';
import type { ClaimStatus } from '@/lib/claims/types';

const Body = z.object({
  to: z.enum([
    'preauth_pending', 'preauth_approved', 'preauth_query', 'preauth_rejected', 'preauth_enhanced',
    'claim_submitted', 'claim_under_review', 'claim_query', 'claim_approved', 'claim_partial', 'claim_rejected',
    'settlement_pending', 'closed', 'written_off',
  ]), // 'settled' only via /settle
  fields: z.object({
    approved_amount: z.number().nonnegative().optional(),
    claimed_amount: z.number().nonnegative().optional(),
    tpa_claim_number: z.string().trim().max(80).optional(),
    tpa_preauth_number: z.string().trim().max(80).optional(),
  }).strict().default({}),
  note: z.string().trim().max(1000).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!uuid.safeParse(id).success) return fail(400, 'Bad claim id');
  const auth = await requireUser();
  if ('error' in auth) return auth.error;
  const { supabase, user } = auth;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, 'Check the values entered.', { issues: parsed.error.issues });
  const { to, fields, note } = parsed.data;

  const { data, error } = await supabase.rpc('clm_transition', {
    p_claim_id: id, p_to_status: to, p_fields: fields, p_note: note ?? null,
  });

  if (error) {
    const res = fromDbError(error);
    if (res.status === 422) {
      // Keep a record of every blocked submission: "the system let me submit" disputes end here.
      const body = await res.clone().json();
      await supabase.from('clm_events').insert({
        claim_id: id, event_type: 'submit_blocked', actor_id: user.id,
        payload: { to, blockers: body.blockers },
      });
    }
    return res;
  }

  await notifyStatusChange(supabase, id, to as ClaimStatus).catch((e) => console.error('notify', e));
  return NextResponse.json({ ok: true, status: (data as { status: ClaimStatus }).status });
}
