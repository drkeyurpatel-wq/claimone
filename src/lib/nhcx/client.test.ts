import { describe, expect, it } from 'vitest';
import { NhcxClient } from './client';
import { NhcxError, NhcxValidationError } from './errors';
import { buildPreauthBundle } from './fhir';
import { createHarness } from './testing/harness';
import { PAYER_CODE, PHI, preauthInput, PROVIDER_CODE, provider } from './testing/fixtures';

const bundle = () => buildPreauthBundle(preauthInput());
const certCalls = (h: ReturnType<typeof createHarness>) => h.fake.calls.filter((c) => c.path.endsWith('/fetch/certs')).length;

describe('NhcxClient: send', () => {
  it('posts {payload: JWE} with protocol headers and returns the ids to store', async () => {
    const h = createHarness();
    const r = await h.client.send('preauth/submit', bundle(), PAYER_CODE, { beneficiaryAbha: PHI.abhaDigits, useCase: 'New' });
    expect(r).toMatchObject({ action: 'preauth/submit', httpStatus: 202, protocolStatus: 'request.queued', workflowId: '12', attempts: 1 });
    expect(r.correlationId).toBe(r.apiCallId); // originating request: correlation = api_call_id
    const got = h.fake.received[0];
    expect(got.path).toBe('preauth/submit');
    expect(got.decrypted).toBe(true);
    expect(got.headers).toMatchObject({
      alg: 'RSA-OAEP-256', enc: 'A256GCM', 'x-hcx-sender_code': PROVIDER_CODE, 'x-hcx-recipient_code': PAYER_CODE,
      'x-hcx-api_call_id': r.apiCallId, 'x-hcx-request_id': r.requestId, 'x-hcx-status': 'request.initiated',
      'x-hcx-workflow_id': '12', 'x-hcx-use_case': 'New', 'x-hcx-ben-abha-id': PHI.abhaHyphenated,
    });
    expect(got.bundle.entry[0].resource.resourceType).toBe('Claim');
  });

  it('answers (on_*) require the request correlation id and default to response.complete', async () => {
    const h = createHarness();
    await expect(h.client.send('communication/on_request', bundle(), PAYER_CODE)).rejects.toBeInstanceOf(NhcxValidationError);
    const corr = crypto.randomUUID();
    const r = await h.client.send('paymentnotice/on_request', bundle(), PAYER_CODE, { correlationId: corr });
    expect(r.correlationId).toBe(corr);
    expect(r.apiCallId).not.toBe(corr);
    expect(h.fake.received[0].headers).toMatchObject({ 'x-hcx-status': 'response.complete', 'x-hcx-workflow_id': '17' });
  });

  it('status: empty payload, correlation = the asked-about api_call_id', async () => {
    const h = createHarness();
    const first = await h.client.send('preauth/submit', bundle(), PAYER_CODE);
    const s = await h.client.checkStatus({ apiCallId: first.apiCallId, recipientCode: PAYER_CODE });
    expect(s.correlationId).toBe(first.apiCallId);
    expect(h.fake.received[1]).toMatchObject({ path: 'status', bundle: null, decrypted: true });
  });

  it('a 4xx is not retried and surfaces the HCX code', async () => {
    const h = createHarness();
    const err = await h.client.send('preauth/submit', bundle(), PAYER_CODE, { status: 'response.complete' }).catch((e) => e);
    expect(err).toBeInstanceOf(NhcxError);
    expect(err).toMatchObject({ kind: 'gateway', code: 'NHCX-1011', httpStatus: 400, retryable: false });
    expect(err.apiCallId).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.fake.calls.filter((c) => c.path.startsWith('/hcx/'))).toHaveLength(1);
    expect(h.sleeps).toEqual([]);
  });

  it('reusing a correlation id on a new request is refused (NHCX-1006)', async () => {
    const h = createHarness();
    const r = await h.client.send('preauth/submit', bundle(), PAYER_CODE);
    await expect(h.client.send('preauth/submit', bundle(), PAYER_CODE, { correlationId: r.correlationId })).rejects.toMatchObject({ code: 'NHCX-1006' });
  });

  it('rejects an unknown recipient at the registry', async () => {
    const h = createHarness();
    await expect(h.client.send('preauth/submit', bundle(), '424242@hcx')).rejects.toMatchObject({ kind: 'registry', code: 'NHCX-1003' });
  });
});

describe('NhcxClient: retries', () => {
  it('retries 5xx with exponential backoff, fresh api_call_id per attempt', async () => {
    const h = createHarness();
    h.fake.failNext.push(503, 502);
    const r = await h.client.send('preauth/submit', bundle(), PAYER_CODE);
    expect(r.attempts).toBe(3);
    expect(h.sleeps).toEqual([250, 500]); // random 0.5 × 500·2^(n-1)
    expect(h.fake.received).toHaveLength(1);
    expect(h.fake.received[0].headers['x-hcx-api_call_id']).toBe(r.apiCallId);
  });

  it('gives up after maxAttempts with a retryable gateway error', async () => {
    const h = createHarness();
    h.fake.failNext.push(503, 503, 503, 503);
    const err = await h.client.send('preauth/submit', bundle(), PAYER_CODE).catch((e) => e);
    expect(err).toMatchObject({ kind: 'gateway', code: 'NHCX-1008', httpStatus: 503, retryable: true });
    expect(h.sleeps).toHaveLength(3);
  });

  it('retries timeouts', async () => {
    const h = createHarness({ client: { requestTimeoutMs: 30 } });
    h.fake.hangNext.push(1000);
    const r = await h.client.send('preauth/submit', bundle(), PAYER_CODE);
    expect(r.attempts).toBe(2);
    h.fake.hangNext.push(1000, 1000, 1000, 1000);
    await expect(h.client.send('preauth/submit', bundle(), PAYER_CODE)).rejects.toMatchObject({ kind: 'transport', code: 'ERR_TIMEOUT', retryable: true });
  });
});

describe('NhcxClient: token and certificate caching', () => {
  it('caches the token until shortly before expiry', async () => {
    const h = createHarness();
    await h.client.send('preauth/submit', bundle(), PAYER_CODE);
    await h.client.send('preauth/submit', bundle(), PAYER_CODE);
    expect(h.fake.tokensIssued).toBe(1);
    h.clock.advance(19 * 60 * 1000); // 1200 s token, 120 s refresh skew
    await h.client.send('preauth/submit', bundle(), PAYER_CODE);
    expect(h.fake.tokensIssued).toBe(2);
  });

  it('on 401 fetches a new token and retries once', async () => {
    const h = createHarness();
    await h.client.send('preauth/submit', bundle(), PAYER_CODE);
    h.fake.revokeTokens();
    const r = await h.client.send('preauth/submit', bundle(), PAYER_CODE);
    expect(r.httpStatus).toBe(202);
    expect(h.fake.tokensIssued).toBe(2);
  });

  it('bad credentials → auth error, no secret in the message', async () => {
    const h = createHarness({ client: { auth: { kind: 'abdm-sessions', url: 'https://fake-nhcx.test/sessions', clientId: 'x', clientSecret: 'super-secret-value', cmId: 'sbx' } } });
    const err = await h.client.getToken().catch((e) => e);
    expect(err).toMatchObject({ kind: 'auth', httpStatus: 401 });
    expect(err.message).not.toContain('super-secret-value');
  });

  it('shares one in-flight token fetch between concurrent calls', async () => {
    const h = createHarness();
    await Promise.all([h.client.getToken(), h.client.getToken(), h.client.getToken()]);
    expect(h.fake.tokensIssued).toBe(1);
  });

  it('caches recipient certificates (24 h default) and can invalidate them', async () => {
    const h = createHarness();
    await h.client.send('preauth/submit', bundle(), PAYER_CODE);
    await h.client.send('preauth/submit', bundle(), '1000003538'); // same participant, bare code
    expect(certCalls(h)).toBe(1);
    h.client.invalidateRecipientKey(PAYER_CODE);
    await h.client.send('preauth/submit', bundle(), PAYER_CODE);
    expect(certCalls(h)).toBe(2);
    h.clock.advance(25 * 3600 * 1000);
    await h.client.send('preauth/submit', bundle(), PAYER_CODE);
    expect(certCalls(h)).toBe(3);
  });

  it('participant registry search', async () => {
    const h = createHarness();
    expect(await h.client.searchParticipant('1000003538')).toMatchObject({ participantCode: PAYER_CODE, name: 'Sandbox Payer', roles: ['payer'], status: 'Active' });
    expect(await h.client.searchParticipant('5@hcx')).toBeNull();
  });

  it('supports the participant-service get-session token call and caller token providers', async () => {
    let seen = '';
    const fetchStub: typeof fetch = async (_url, init) => {
      seen = String(init?.body);
      return new Response(JSON.stringify({ access_token: 'abc', expires_in: 1200 }), { status: 200 });
    };
    const base = { participantCode: PROVIDER_CODE, hfrId: provider.hfrId, providerName: provider.name, gatewayBaseUrl: 'https://g.test', registryBaseUrl: 'https://r.test' };
    const c1 = new NhcxClient({ ...base, auth: { kind: 'get-session', url: 'https://r.test/get/session', clientId: 'cid', clientSecret: 'cs' }, fetch: fetchStub });
    expect(await c1.getToken()).toBe('abc');
    expect(seen).toBe('client_id=cid&client_secret=cs&grant_type=client_credentials');
    const c2 = new NhcxClient({ ...base, auth: { kind: 'provider', provider: { getToken: async () => 'from-provider' } } });
    expect(await c2.getToken()).toBe('from-provider');
  });

  it('validates config', () => {
    expect(() => new NhcxClient({ participantCode: '', hfrId: 'x', providerName: 'x', gatewayBaseUrl: 'https://g', registryBaseUrl: 'https://r', auth: { kind: 'provider', provider: { getToken: async () => '' } } })).toThrow(/participantCode/);
  });
});
