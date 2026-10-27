// Import parsed rows (bank statement, cashless tracker, settlement advice,
// patient dues) for one centre. Parsing happens in the browser with the
// tested parsers in lib/recon/parse.ts; this route validates and saves.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser, fail, uuid } from '@/lib/api/route';
import { payerTokens } from '@/lib/recon/match';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const money = z.number().finite();
const str = z.string().trim().max(300);

const Bank = z.object({ value_date: date, amount: money.positive(), reference: str.nullable(), narration: z.string().max(500) });
const Tracker = z.object({
  ip_no: str, patient_name: str, doctor_name: str, bill_no: str.min(1), bill_date: date, insurer: str, tpa: str,
  claim_ref: str.nullable(), billed: money.nullable(), approved: money.nonnegative(), recorded_utr: str.nullable(),
}).passthrough();
const Advice = z.object({
  utr: str.nullable(), advice_ref: str.nullable(), advice_date: date.nullable(), claim_ref: str.nullable(), bill_no: str.nullable(),
  patient_name: str.nullable(), approved_amount: money.nullable(), tds_amount: money.nonnegative(), deduction_amount: money.nonnegative(),
  deduction_reason: str.nullable(), net_amount: money.positive(),
});
const Due = z.object({ ip_no: str, patient_name: str, doctor_name: str, amount: money.positive(), bill_date: date, care_of: str, note: z.string().max(500) });

const Body = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('bank_statement'), centre_id: uuid, file_name: str, bank_account: str.min(1), rows: z.array(Bank).max(20000) }),
  z.object({ kind: z.literal('cashless_tracker'), centre_id: uuid, file_name: str, rows: z.array(Tracker).max(5000) }),
  z.object({ kind: z.literal('settlement_advice'), centre_id: uuid, file_name: str, payer_name: str.optional(), rows: z.array(Advice).max(5000) }),
  z.object({ kind: z.literal('patient_dues'), centre_id: uuid, file_name: str, rows: z.array(Due).max(2000) }),
]);

export async function POST(req: Request) {
  const auth = await requireUser();
  if ('error' in auth) return auth.error;
  const { supabase } = auth;
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, 'The file did not import cleanly.', { issues: parsed.error.issues.slice(0, 5) });
  const b = parsed.data;

  const { data: profile } = await supabase.from('clm_user_profiles').select('tenant_id').maybeSingle();
  if (!profile) return fail(403, 'No ClaimOne profile for this login.');
  const tenant_id = profile.tenant_id as string;

  const { data: batch, error: be } = await supabase.from('clm_import_batches')
    .insert({ tenant_id, centre_id: b.centre_id, kind: b.kind, file_name: b.file_name, row_count: b.rows.length }).select('id').single();
  if (be) return fail(be.code === '42501' ? 403 : 400, be.message);

  const { data: payers } = await supabase.from('clm_payers').select('id, name, type');
  const findPayer = (name: string) => {
    const n = ` ${name.toUpperCase().replace(/[^A-Z]+/g, ' ')} `;
    return (payers ?? []).find((p) => payerTokens(p.name).some((t) => n.includes(` ${t} `)));
  };

  let inserted = 0;
  let duplicates = 0;
  const base = { tenant_id, centre_id: b.centre_id, import_batch_id: batch.id };

  if (b.kind === 'bank_statement') {
    for (const r of b.rows) {
      const p = findPayer(r.narration);
      const { error } = await supabase.from('clm_receipts').insert({ ...base, source: 'bank', bank_account: b.bank_account,
        value_date: r.value_date, amount: r.amount, reference: r.reference, narration: r.narration, payer_id: p?.id ?? null });
      if (!error) inserted++; else if (error.code === '23505') duplicates++; else return fail(400, error.message, { inserted });
    }
  } else if (b.kind === 'cashless_tracker') {
    const rows = b.rows.map((r) => {
      const p = findPayer(r.insurer) ?? findPayer(r.tpa);
      return { ...base, debtor_type: 'insurer', payer_id: p?.id ?? null, debtor_name: p?.name ?? (r.insurer || r.tpa),
        bill_no: r.bill_no, ip_no: r.ip_no, claim_ref: r.claim_ref, bill_date: r.bill_date, patient_name: r.patient_name,
        doctor_name: r.doctor_name, billed_amount: r.billed, expected_amount: r.approved, recorded_utr: r.recorded_utr, source: 'import' };
    });
    // re-importing the same tab updates approved amount and recorded UTR, never duplicates
    const { data, error } = await supabase.from('clm_receivables')
      .upsert(rows, { onConflict: 'tenant_id,centre_id,debtor_type,bill_no', ignoreDuplicates: false }).select('id');
    if (error) return fail(400, error.message);
    inserted = data?.length ?? 0;
  } else if (b.kind === 'settlement_advice') {
    const p = b.payer_name ? findPayer(b.payer_name) : undefined;
    const { data, error } = await supabase.from('clm_remittance_lines')
      .insert(b.rows.map((r) => ({ ...base, ...r, payer_id: p?.id ?? null, payer_name: b.payer_name ?? null }))).select('id');
    if (error) return fail(400, error.message);
    inserted = data?.length ?? 0;
  } else {
    const rows = b.rows.map((r) => ({ ...base, debtor_type: /^C\/O|^B\/O/i.test(r.care_of) ? 'referrer' : 'patient',
      debtor_name: r.patient_name, bill_no: `DUE-${r.ip_no}`, ip_no: r.ip_no, bill_date: r.bill_date, patient_name: r.patient_name,
      doctor_name: r.doctor_name, care_of: r.care_of, expected_amount: r.amount, notes: r.note || null, source: 'import' }));
    const { data, error } = await supabase.from('clm_receivables')
      .upsert(rows, { onConflict: 'tenant_id,centre_id,debtor_type,bill_no', ignoreDuplicates: true }).select('id');
    if (error) return fail(400, error.message);
    inserted = data?.length ?? 0;
    duplicates = rows.length - inserted;
  }
  return NextResponse.json({ ok: true, batch_id: batch.id, inserted, duplicates });
}
