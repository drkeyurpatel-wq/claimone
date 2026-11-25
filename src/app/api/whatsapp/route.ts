// WhatsApp webhook (Meta Cloud API).
//  • Papers: a photo or PDF with the IP no. / claim no. in the caption — or from
//    the patient's own number while the file is open — goes onto the file as a
//    document for the desk to check (source 'bot', status 'uploaded').
//  • Staff (their mobile is a ClaimOne login) ask for status, what is due,
//    the month at a glance, or close a settled file after a yes.
// Without the WhatsApp settings the route answers 503 and nothing else changes.
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { botClient, fetchMedia, sendText, signatureOk, waConfig } from '@/lib/wa/client.server';
import { closeQuestion, closeRefusal, HELP, mobile10, parseCommand, PATIENT_HELP, statusLine, type Command, type FileLite } from '@/lib/wa/assistant';
import { isHigh, nextStep } from '@/lib/rcm/worklist';
import { headline } from '@/lib/rcm/overview';
import { PAPERS } from '@/lib/claims/reply';
import { askClaude } from '@/lib/ai/claude.server';
import type { Claim } from '@/lib/claims/types';

export const runtime = 'nodejs';
export const maxDuration = 60;

const FILE = 'id, tenant_id, centre_id, claim_number, claim_type, status, patient_name, patient_phone, admission_ref, tpa_claim_number, approved_amount, settled_amount, ' +
  'admitted_at, admission_date, discharged_at, discharge_date, preauth_submitted_at, submitted_at, status_changed_at, updated_at, created_at, estimated_amount, query_replied_at, clm_payers!clm_claims_payer_id_fkey(name)';
const OPEN = ['draft', 'preauth_pending', 'preauth_query', 'preauth_approved', 'preauth_enhanced', 'preauth_rejected', 'claim_submitted', 'claim_under_review',
  'claim_query', 'claim_approved', 'claim_partial', 'claim_rejected', 'settlement_pending', 'settled'];
const EXT: Record<string, string> = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' };

type Row = Claim & { clm_payers?: { name: string } | null };
const lite = (c: Row): FileLite => ({ patient_name: c.patient_name, claim_number: c.claim_number, admission_ref: c.admission_ref, tpa_claim_number: c.tpa_claim_number,
  status: c.status, approved_amount: c.approved_amount, settled_amount: c.settled_amount, payer: c.clm_payers?.name ?? null });

/** IP no. / claim no. / TPA claim no. first, then the patient name. Only safe characters reach the filter. */
async function findFiles(sb: SupabaseClient, ref: string): Promise<Row[]> {
  const r = ref.replace(/[^A-Za-z0-9/ .-]/g, '').trim();
  if (r.length < 3) return [];
  const exact = await sb.from('clm_claims').select(FILE).or(`claim_number.eq.${r},tpa_claim_number.eq.${r},admission_ref.eq.${r}`).limit(3);
  if (exact.data?.length) return exact.data as unknown as Row[];
  const byName = await sb.from('clm_claims').select(FILE).ilike('patient_name', `%${r}%`).in('status', OPEN).order('created_at', { ascending: false }).limit(3);
  return (byName.data ?? []) as unknown as Row[];
}

/** With the AI key set, a free-text question is mapped onto one of the commands. */
async function understand(text: string): Promise<Command | null> {
  const out = await askClaude('Map a hospital insurance-desk staff message to one command. Reply with JSON only: {"kind":"status"|"close"|"due"|"month"|"help","ref":"<IP no, claim no or patient name if any>"}.', text, 100);
  try {
    const j = JSON.parse((out ?? '').replace(/^```json|```$/g, '').trim()) as { kind?: string; ref?: string };
    if ((j.kind === 'status' || j.kind === 'close') && j.ref) return { kind: j.kind, ref: j.ref };
    if (j.kind === 'due' || j.kind === 'month' || j.kind === 'help') return { kind: j.kind };
  } catch { /* fall through */ }
  return null;
}

async function staffReply(sb: SupabaseClient, phone: string, staff: { full_name: string; role: string }, text: string): Promise<string> {
  const cmd = parseCommand(text) ?? (await understand(text)) ?? { kind: 'help' as const };
  const now = new Date();
  switch (cmd.kind) {
    case 'help': return HELP;
    case 'status': {
      const files = await findFiles(sb, cmd.ref);
      if (!files.length) return `No file found for "${cmd.ref}". Try the IP no. or claim no.`;
      return files.map((c) => statusLine(lite(c), nextStep(c, now), now)).join('\n\n');
    }
    case 'due': {
      const { data } = await sb.from('clm_claims').select(FILE).in('status', OPEN).limit(2000);
      const high = ((data ?? []) as unknown as Row[]).map((c) => ({ c, s: nextStep(c, now) })).filter((x) => isHigh(x.s, now))
        .sort((a, b) => (a.s.dueAt?.getTime() ?? 0) - (b.s.dueAt?.getTime() ?? 0));
      if (!high.length) return 'Nothing is high priority right now.';
      return `*${high.length} high-priority file${high.length === 1 ? '' : 's'}*\n\n` + high.slice(0, 8).map((x) => statusLine(lite(x.c), x.s, now)).join('\n\n')
        + (high.length > 8 ? `\n\n…and ${high.length - 8} more on Master.` : '');
    }
    case 'month': {
      const { data } = await sb.from('clm_claims').select(FILE).in('status', OPEN).neq('status', 'settled').limit(5000);
      const rows = (data ?? []) as unknown as Row[];
      const h = headline(rows.map((c) => ({ status: c.status, high: isHigh(nextStep(c, now), now) })));
      return `*At a glance*\nActive files: ${h.active}\nApproved, money awaited: ${h.approved}\nNeed attention: ${h.attention}`;
    }
    case 'close': {
      if (staff.role === 'viewer') return 'Your login is read-only.';
      const [c] = await findFiles(sb, cmd.ref);
      if (!c) return `No file found for "${cmd.ref}".`;
      const no = closeRefusal(c.status);
      if (no) return no;
      await sb.from('clm_wa_sessions').upsert({ tenant_id: c.tenant_id, phone, claim_id: c.id, action: 'close', staff_name: staff.full_name,
        expires_at: new Date(Date.now() + 15 * 60_000).toISOString() });
      return closeQuestion(lite(c));
    }
    case 'yes': case 'no': {
      const { data: s } = await sb.from('clm_wa_sessions').select('claim_id, staff_name, expires_at').eq('phone', phone).maybeSingle();
      await sb.from('clm_wa_sessions').delete().eq('phone', phone);
      if (!s || new Date(s.expires_at) < now) return cmd.kind === 'yes' ? 'Nothing is waiting for a yes. Send *close* with the IP no.' : 'OK.';
      if (cmd.kind === 'no') return 'OK, the file stays open.';
      const { error } = await sb.rpc('clm_bot_apply', { p_claim_id: s.claim_id, p_to_status: 'closed', p_fields: {}, p_note: `Closed on WhatsApp by ${s.staff_name}` });
      return error ? 'Could not close it — open the file on ClaimOne.' : `Closed at ${now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })}.`;
    }
  }
}

/** A paper sent in: which file? The caption's IP / claim no. first, else the patient's own number on one open file. */
async function filePaper(sb: SupabaseClient, cfg: NonNullable<ReturnType<typeof waConfig>>, phone: string, mediaId: string, caption: string, fileName?: string): Promise<string> {
  let c: Row | undefined;
  for (const tok of caption.split(/[\s,;:]+/).filter((x) => /\d/.test(x) && x.length >= 4)) {
    [c] = await findFiles(sb, tok);
    if (c) break;
  }
  if (!c) {
    const { data } = await sb.from('clm_claims').select(FILE).in('status', OPEN).like('patient_phone', `%${phone}`).order('created_at', { ascending: false }).limit(2);
    const mine = (data ?? []) as unknown as Row[];
    if (mine.length === 1) c = mine[0];
  }
  if (!c) return 'Received, but we could not tell which patient this is for. Please send it again with the IP number in the caption.';
  const media = await fetchMedia(cfg, mediaId);
  if (!media || !EXT[media.mime]) return 'Could not read this file. Please send a photo (JPG/PNG) or a PDF.';
  const path = `${c.tenant_id}/${c.id}/wa-${Date.now()}.${EXT[media.mime]}`;
  const up = await sb.storage.from('claim-documents').upload(path, media.bytes, { contentType: media.mime });
  if (up.error) return 'Could not save the file. Please try again.';
  const name = (caption || fileName || 'Paper sent on WhatsApp').slice(0, 120);
  const paper = PAPERS.find((p) => p.words.test(name));
  const ins = await sb.from('clm_documents').insert({
    claim_id: c.id, doc_code: paper?.code ?? null, document_name: `${name} (WhatsApp)`, document_category: paper ? 'clinical' : 'other',
    file_path: path, file_size_bytes: media.bytes.byteLength, mime_type: media.mime, source: 'bot', status: 'uploaded',
  });
  if (ins.error) return 'Could not add the file. Please try again.';
  return `Received — added to the file of ${c.patient_name}${paper ? ` as ${paper.name.toLowerCase()}` : ''}. The insurance desk will check it.`;
}

// Meta's one-time check when the webhook is set up
export async function GET(req: Request) {
  const u = new URL(req.url);
  const ok = u.searchParams.get('hub.mode') === 'subscribe' && !!process.env.WHATSAPP_VERIFY_TOKEN
    && u.searchParams.get('hub.verify_token') === process.env.WHATSAPP_VERIFY_TOKEN;
  return ok ? new Response(u.searchParams.get('hub.challenge') ?? '', { status: 200 }) : new Response('Forbidden', { status: 403 });
}

interface WaMsg { from: string; type: string; text?: { body: string }; image?: { id: string; caption?: string }; document?: { id: string; caption?: string; filename?: string } }

export async function POST(req: Request) {
  const cfg = waConfig();
  if (!cfg) return NextResponse.json({ error: 'WhatsApp is not set up' }, { status: 503 });
  const raw = await req.text();
  if (!signatureOk(raw, req.headers.get('x-hub-signature-256'), cfg.secret)) return new Response('Bad signature', { status: 401 });
  const body = JSON.parse(raw || '{}') as { entry?: { changes?: { value?: { messages?: WaMsg[] } }[] }[] };
  const msgs = (body.entry ?? []).flatMap((e) => e.changes ?? []).flatMap((c) => c.value?.messages ?? []);
  if (!msgs.length) return NextResponse.json({ ok: true }); // delivery receipts etc.

  let sb: SupabaseClient;
  try { sb = await botClient(cfg.email, cfg.password); } catch { return NextResponse.json({ error: 'sign-in' }, { status: 500 }); }
  for (const m of msgs) {
    const phone = mobile10(m.from);
    try {
      const { data: staff } = await sb.rpc('clm_wa_staff', { p_mobile: phone });
      const who = (staff as { full_name: string; role: string }[] | null)?.[0];
      const media = m.image ?? m.document;
      let reply: string;
      if (media) reply = await filePaper(sb, cfg, phone, media.id, media.caption ?? '', m.document?.filename);
      else if (m.type === 'text' && m.text) reply = who ? await staffReply(sb, phone, who, m.text.body) : PATIENT_HELP;
      else reply = who ? HELP : PATIENT_HELP;
      await sendText(cfg, m.from, reply);
    } catch { console.error('whatsapp: message failed'); }
  }
  return NextResponse.json({ ok: true });
}
