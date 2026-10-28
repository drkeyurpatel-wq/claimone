// Read a settlement letter — PDF, photo / WhatsApp image, or text pasted from
// an email — and return the payment lines on it. Uses Claude via the Anthropic
// API (ANTHROPIC_API_KEY on the server). Nothing is stored here and no letter
// content is logged; the lines go back to the browser for the team to check.
import { NextResponse } from 'next/server';
import { requireUser, fail } from '@/lib/api/route';
import { cleanLetterLines } from '@/lib/recon/payments';

export const maxDuration = 60;

const MAX_BYTES = 4_000_000;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const LINE_SCHEMA = {
  type: 'object',
  properties: {
    payer_name: { type: 'string', description: 'Insurance company or government scheme that paid' },
    tpa_name: { type: 'string', description: 'TPA that issued the letter, if any' },
    claim_ref: { type: 'string', description: 'Claim number / CCN / case ID / AL number, exactly as printed' },
    bill_no: { type: 'string', description: 'Hospital bill / invoice number, if printed' },
    patient_name: { type: 'string' },
    ip_no: { type: 'string', description: 'Hospital IP / admission number, if printed' },
    bill_date: { type: 'string', description: 'Bill or discharge date, YYYY-MM-DD' },
    claimed_amount: { type: 'number', description: 'Amount the hospital claimed / billed' },
    approved_amount: { type: 'number', description: 'Amount approved / settled before TDS' },
    tds_amount: { type: 'number' },
    deduction_amount: { type: 'number', description: 'Total disallowed / deducted by the payer' },
    deduction_reason: { type: 'string', description: 'Why it was deducted, short, as stated in the letter' },
    net_amount: { type: 'number', description: 'Amount actually transferred to the hospital' },
    utr: { type: 'string', description: 'UTR / NEFT / transaction reference' },
    payment_date: { type: 'string', description: 'Date of transfer, YYYY-MM-DD' },
  },
  required: ['net_amount'],
};

const PROMPT = `This is a payment / settlement letter sent to an Indian hospital by an insurer, TPA or government scheme (or a bank advice listing several claims).
Record every claim paid in it with the record_payments tool — one line per claim. Copy claim numbers, UTRs and bill numbers exactly as printed.
Amounts are in rupees: write 1,05,000 as 105000. Dates are day-first in India: 05/06/2026 is 5 June 2026 → 2026-06-05.
If a field is not on the letter, leave it out — do not guess. If nothing on it is a payment, call the tool with an empty list.`;

export async function POST(req: Request) {
  const auth = await requireUser();
  if ('error' in auth) return auth.error;
  // only people who can save payments may send letters out to be read
  const { data: canWrite } = await auth.supabase.rpc('clm_can_write');
  if (canWrite !== true) return fail(403, 'Your login is read-only.');
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return fail(503, 'Reading PDFs and photos is not switched on yet — ask the admin to add the Anthropic API key. Excel files still work.');

  const form = await req.formData().catch(() => null);
  if (!form) return fail(400, 'Nothing was uploaded.');
  const file = form.get('file');
  const text = String(form.get('text') ?? '').trim();

  const content: Record<string, unknown>[] = [];
  if (file instanceof File && file.size > 0) {
    if (file.size > MAX_BYTES) return fail(413, 'File is too big (over 4 MB). Take a smaller photo or split the PDF.');
    const data = Buffer.from(await file.arrayBuffer()).toString('base64');
    const type = file.type || (/\.pdf$/i.test(file.name) ? 'application/pdf' : '');
    if (type === 'application/pdf') content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } });
    else if (IMAGE_TYPES.includes(type)) content.push({ type: 'image', source: { type: 'base64', media_type: type, data } });
    else return fail(415, 'Upload a PDF, a photo (JPG/PNG), or an Excel file.');
  } else if (text) {
    if (text.length > 60_000) return fail(413, 'That text is too long — paste one letter at a time.');
    content.push({ type: 'text', text: `Letter text (pasted from email):\n\n${text}` });
  } else return fail(400, 'Choose a file or paste the letter text.');
  content.push({ type: 'text', text: PROMPT });

  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
        max_tokens: 8000,
        tools: [{
          name: 'record_payments',
          description: 'Record the claim payments found on the letter.',
          input_schema: { type: 'object', properties: { lines: { type: 'array', items: LINE_SCHEMA } }, required: ['lines'] },
        }],
        tool_choice: { type: 'tool', name: 'record_payments' },
        messages: [{ role: 'user', content }],
      }),
    });
  } catch {
    return fail(502, 'Could not reach the letter reader. Try again in a minute.');
  }
  if (!res.ok) {
    console.error('read-letter: anthropic status', res.status); // status only — never the letter
    return fail(502, res.status === 401 ? 'The Anthropic API key is not valid.' : 'The letter reader is busy. Try again in a minute.');
  }
  const out = (await res.json().catch(() => null)) as { content?: { type: string; input?: { lines?: unknown } }[] } | null;
  const use = out?.content?.find((c) => c.type === 'tool_use');
  const lines = cleanLetterLines(use?.input?.lines);
  return NextResponse.json({ lines, raw_count: Array.isArray(use?.input?.lines) ? use.input.lines.length : 0 });
}
