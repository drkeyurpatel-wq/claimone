// WhatsApp Cloud API (Meta) and the webhook's own Supabase login.
// Token, app secret and the bot password stay on the server; nothing is logged but status codes.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseEnv } from '@/lib/supabase/env';

const GRAPH = 'https://graph.facebook.com/v21.0';

export function waConfig() {
  const e = process.env;
  if (!e.WHATSAPP_ACCESS_TOKEN || !e.WHATSAPP_PHONE_NUMBER_ID || !e.WHATSAPP_APP_SECRET || !e.WA_BOT_EMAIL || !e.WA_BOT_PASSWORD) return null;
  return { token: e.WHATSAPP_ACCESS_TOKEN, phoneId: e.WHATSAPP_PHONE_NUMBER_ID, secret: e.WHATSAPP_APP_SECRET, email: e.WA_BOT_EMAIL, password: e.WA_BOT_PASSWORD };
}

/** Meta signs every webhook body with the app secret: X-Hub-Signature-256: sha256=<hex>. */
export function signatureOk(raw: string, header: string | null, secret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const want = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'));
  const got = Buffer.from(header.slice(7));
  return want.length === got.length && timingSafeEqual(want, got);
}

let bot: { c: SupabaseClient; at: number } | null = null;
/** Signs in as the WhatsApp bot user (role 'bot'); reused while warm, renewed hourly. */
export async function botClient(email: string, password: string): Promise<SupabaseClient> {
  if (bot && Date.now() - bot.at < 3_600_000) return bot.c;
  const { url, anonKey } = supabaseEnv();
  const c = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error('WhatsApp bot sign-in failed');
  bot = { c, at: Date.now() };
  return c;
}

export async function sendText(cfg: NonNullable<ReturnType<typeof waConfig>>, to: string, body: string) {
  const res = await fetch(`${GRAPH}/${cfg.phoneId}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: body.slice(0, 4000) } }),
  });
  if (!res.ok) console.error('whatsapp send: status', res.status);
}

/** Media sent to us: look up its short-lived URL, then download it with the token. */
export async function fetchMedia(cfg: NonNullable<ReturnType<typeof waConfig>>, mediaId: string): Promise<{ bytes: ArrayBuffer; mime: string } | null> {
  const meta = await fetch(`${GRAPH}/${mediaId}`, { headers: { Authorization: `Bearer ${cfg.token}` } });
  if (!meta.ok) return null;
  const m = (await meta.json()) as { url?: string; mime_type?: string; file_size?: number };
  if (!m.url || (m.file_size ?? 0) > 20_000_000) return null;
  const file = await fetch(m.url, { headers: { Authorization: `Bearer ${cfg.token}` } });
  if (!file.ok) return null;
  return { bytes: await file.arrayBuffer(), mime: (m.mime_type ?? '').split(';')[0] };
}
