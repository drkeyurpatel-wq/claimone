import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildProtocolHeaders, encryptPayload, importRecipientKey } from '@/lib/nhcx/jwe';
import { generateTestKeyPair } from '@/lib/nhcx/testing/keys';

const rpc = vi.fn(async (_fn: string, _args: unknown) => ({ error: null as null | { code: string } }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ rpc }) }));

const ME = '1000004446@hcx', PAYER = '1000003538@hcx';
const keys = generateTestKeyPair('provider');
const reply = {
  resourceType: 'Bundle', type: 'collection', entry: [{ fullUrl: 'urn:uuid:7a1f3c1e-3a55-4a8e-9d55-1e8a3b0c9f00', resource: {
    resourceType: 'ClaimResponse', use: 'preauthorization', outcome: 'complete', identifier: [{ value: 'CLM-SHJ-1' }], preAuthRef: 'PA-77',
    patient: { display: 'SECRET PATIENT NAME' },
    adjudication: [{ category: { coding: [{ code: 'status' }] }, reason: { coding: [{ code: 'approved' }] } }],
    total: [{ category: { coding: [{ code: 'benefit' }] }, amount: { value: 150000 } }, { category: { coding: [{ code: 'submitted' }] }, amount: { value: 150000 } }],
  } }],
};

async function sealed(over: Record<string, string> = {}) {
  const headers = { ...buildProtocolHeaders({ senderCode: PAYER, recipientCode: ME, status: 'response.complete', workflowId: '21', correlationId: 'b5d0c5a4-1111-4c1e-9a3e-0e1f2a3b4c5d', timestamp: new Date() }), ...over };
  const payload = await encryptPayload({ payload: reply, recipientKey: await importRecipientKey(keys.certificatePem, 'RSA-OAEP-256'), headers });
  return JSON.stringify({ type: 'JWEPayload', payload });
}

beforeAll(() => {
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: 'https://x.supabase.co', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
    NHCX_PARTICIPANT_CODE: ME, NHCX_HFR_ID: 'IN24', NHCX_PROVIDER_NAME: 'Health1 Shilaj', NHCX_CLIENT_ID: 'c', NHCX_CLIENT_SECRET: 's',
    NHCX_PRIVATE_KEY: keys.privateKeyPem.replace(/\n/g, '\\n'), NHCX_CALLBACK_SECRET: 'x'.repeat(40),
  });
});

describe('NHCX callback route', () => {
  it('stores a pre-auth answer with only the decision and amounts in the clear, and answers 202', async () => {
    const { POST } = await import('./route');
    const res = await POST(new Request('https://claimone.test/api/nhcx/v1/preauth/on_submit', { method: 'POST', body: await sealed() }));
    expect(res.status).toBe(202);
    expect(rpc).toHaveBeenCalledTimes(1);
    const [fn, args] = rpc.mock.calls[0] as [string, { p_secret: string; p_msg: Record<string, unknown> }];
    expect(fn).toBe('clm_nhcx_receive');
    expect(args.p_secret).toBe('x'.repeat(40));
    expect(args.p_msg).toMatchObject({ recipient_code: ME, sender_code: PAYER, api_call: 'preauth', action: 'on_submit',
      summary: { outcome: 'approved', approved_amount: 150000, reference: 'PA-77' } });
    expect(JSON.stringify(args.p_msg.summary)).not.toContain('SECRET');
    expect(String(args.p_msg.payload)).not.toContain('SECRET'); // stored encrypted
  });

  it('refuses a message for another hospital without storing it', async () => {
    rpc.mockClear();
    const { POST } = await import('./route');
    const res = await POST(new Request('https://claimone.test/api/nhcx/v1/preauth/on_submit', { method: 'POST', body: await sealed({ 'x-hcx-recipient_code': '999@hcx' }) }));
    expect(res.status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('asks NHCX to retry when the reply could not be stored', async () => {
    rpc.mockResolvedValueOnce({ error: { code: '42501' } });
    const { POST } = await import('./route');
    const res = await POST(new Request('https://claimone.test/api/nhcx/v1/preauth/on_submit', { method: 'POST', body: await sealed() }));
    expect(res.status).toBe(503);
  });
});
