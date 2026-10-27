// Save this week's payment lines: each is matched to its bill (or the bill is
// created from it) in one database call, clm_apply_payments.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, fail, fromDbError, uuid } from '@/lib/api/route';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();
const money = z.number().finite();
const str = z.string().trim().max(300).nullable();

const Line = z.object({
  source: z.enum(['pmjay', 'letter']), payer_name: str, tpa_name: str, claim_ref: str, bill_no: str, patient_name: str,
  ip_no: str, uhid: str, doctor_name: str, bill_date: date, claimed_amount: money.nullable(), approved_amount: money.nullable(),
  tds_amount: money.nonnegative(), deduction_amount: money.nonnegative(), deduction_reason: str, net_amount: money.nonnegative(),
  utr: str, payment_date: date,
});
const Body = z.object({ centre_id: uuid, file_name: z.string().trim().max(300), lines: z.array(Line).min(1).max(6000) });

export async function POST(req: Request) {
  const auth = await requireUser();
  if ('error' in auth) return auth.error;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, 'Some lines could not be read.', { issues: parsed.error.issues.slice(0, 3).map((i) => i.path.join('.')) });
  const b = parsed.data;
  const { data, error } = await auth.supabase.rpc('clm_apply_payments', { p_centre: b.centre_id, p_file: b.file_name, p_lines: b.lines });
  if (error) return fromDbError(error);
  return NextResponse.json({ ok: true, ...(data as Record<string, unknown>) });
}
