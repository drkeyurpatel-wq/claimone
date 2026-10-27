// Shared helpers for API routes.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';

export const uuid = z.string().uuid();

export function fail(status: number, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, ...extra }, { status });
}

/** Signed-in Supabase client, or a 401 response. */
export async function requireUser() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: fail(401, 'Sign in again.') } as const;
  return { supabase, user } as const;
}

/**
 * Turn a Postgres error raised by our triggers into an HTTP answer.
 * The trigger messages are written for the billing desk, so pass them on.
 */
export function fromDbError(e: { message?: string; code?: string; hint?: string } | null) {
  const msg = e?.message ?? 'Something went wrong';
  if (e?.hint === 'CLAIMONE_GATE' || msg.startsWith('Submission blocked')) {
    const list = msg.split('documents not verified:')[1];
    const blockers = list ? list.split(';').map((s) => s.trim()).filter(Boolean) : [];
    return fail(422, 'Submission blocked — some documents are not verified yet.', { blockers });
  }
  if (e?.code === '42501') return fail(403, msg);                // insufficient_privilege
  if (e?.code === '23514' || e?.code === 'P0001') return fail(409, msg); // check_violation / raise
  if (e?.code === 'P0002' || e?.code === 'PGRST116') return fail(404, 'Claim not found.');
  return fail(400, msg);
}
