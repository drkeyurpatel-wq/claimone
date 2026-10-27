// Patient WhatsApp updates on key status changes (from H1 Claims).
// Runs on the server so the WhatsApp token never reaches the browser.
// Templates must be approved in WhatsApp Business first; until the API is
// configured, messages are logged in clm_notifications and not sent.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ClaimStatus } from './types';

const inr = (n: number | null) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;

type C = { patient_name: string; claim_number: string; approved_amount: number | null; settled_amount: number | null; settlement_utr: string | null; clm_payers?: { name: string } | null };

const TEMPLATES: Partial<Record<ClaimStatus, { name: string; params: (c: C) => string[] }>> = {
  preauth_approved: { name: 'claim_preauth_approved', params: (c) => [c.patient_name, c.claim_number, inr(c.approved_amount), c.clm_payers?.name ?? 'Insurer'] },
  preauth_rejected: { name: 'claim_preauth_rejected', params: (c) => [c.patient_name, c.claim_number, c.clm_payers?.name ?? 'Insurer'] },
  preauth_query:    { name: 'claim_query_raised',     params: (c) => [c.patient_name, c.claim_number] },
  claim_approved:   { name: 'claim_approved',         params: (c) => [c.patient_name, c.claim_number, inr(c.approved_amount)] },
  claim_rejected:   { name: 'claim_rejected',         params: (c) => [c.patient_name, c.claim_number] },
  settled:          { name: 'claim_settled',          params: (c) => [c.patient_name, c.claim_number, inr(c.settled_amount), c.settlement_utr ?? ''] },
};

export async function notifyStatusChange(supabase: SupabaseClient, claimId: string, status: ClaimStatus) {
  const t = TEMPLATES[status];
  if (!t) return;
  const { data: claim } = await supabase.from('clm_claims')
    .select('patient_name, patient_phone, claim_number, approved_amount, settled_amount, settlement_utr, clm_payers!clm_claims_payer_id_fkey(name)')
    .eq('id', claimId).maybeSingle();
  if (!claim?.patient_phone) return;

  const params = t.params(claim as unknown as C);
  const digits = claim.patient_phone.replace(/\D/g, '');
  const to = digits.length === 10 ? `91${digits}` : digits;

  const apiUrl = process.env.WHATSAPP_API_URL;
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  let delivery = 'not_configured';
  if (apiUrl && token) {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp', to, type: 'template',
        template: { name: t.name, language: { code: 'en' },
          components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: p })) }] },
      }),
    });
    delivery = res.ok ? 'sent' : `failed_${res.status}`;
  }

  await supabase.from('clm_notifications').insert({
    claim_id: claimId, recipient_type: 'patient', recipient_phone: to, channel: 'whatsapp',
    message_content: `${t.name}: ${params.join(' | ')}`, metadata: { template: t.name, params },
    delivery_status: delivery,
  });
}
