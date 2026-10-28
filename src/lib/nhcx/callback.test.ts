import { generateKeyPairSync } from 'node:crypto';
import { SignJWT, importPKCS8 } from 'jose';
import { describe, expect, it } from 'vitest';
import { createCallbackHandler, entityTypeFor, useCasePath } from './callback';
import { buildPreauthBundle } from './fhir';
import { buildProtocolHeaders, encryptPayload, formatIstDateTime, importRecipientKey } from './jwe';
import { createHarness, type Harness } from './testing/harness';
import { PAYER_CODE, preauthInput, PROVIDER_CODE } from './testing/fixtures';
import type { ProtocolHeaders } from './types';

const ACK_TS = /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}:\d{3}$/;

async function seal(h: Harness, bundle: unknown, over: Partial<ProtocolHeaders> = {}, certPem = h.providerKeys.certificatePem) {
  const headers = { ...buildProtocolHeaders({ senderCode: PAYER_CODE, recipientCode: PROVIDER_CODE, status: 'response.complete', workflowId: '21', correlationId: crypto.randomUUID(), timestamp: h.clock.now }), ...over };
  const payload = await encryptPayload({ payload: bundle, recipientKey: await importRecipientKey(certPem, 'RSA-OAEP-256'), headers });
  return { headers, body: JSON.stringify({ type: 'JWEPayload', payload }) };
}

const claimResponseBundle = {
  resourceType: 'Bundle', type: 'collection', entry: [{ fullUrl: 'urn:uuid:7a1f3c1e-3a55-4a8e-9d55-1e8a3b0c9f00', resource: {
    resourceType: 'ClaimResponse', use: 'preauthorization', outcome: 'complete', identifier: [{ value: 'H1-PA-1' }], preAuthRef: 'PA-77',
    adjudication: [{ category: { coding: [{ code: 'status' }] }, reason: { coding: [{ code: 'approved' }] } }],
    total: [{ category: { coding: [{ code: 'benefit' }] }, amount: { value: 1000 } }, { category: { coding: [{ code: 'submitted' }] }, amount: { value: 1000 } }],
  } }],
};

describe('callback handler', () => {
  it('decrypts, validates, parses and acknowledges a pre-auth answer from the gateway', async () => {
    const h = createHarness();
    const sent = await h.client.send('preauth/submit', buildPreauthBundle(preauthInput()), PAYER_CODE);
    const [out] = await h.fake.deliverAll(h.handle);
    if (!out.accepted) throw new Error('rejected');
    expect(out.httpStatus).toBe(202);
    expect(out.message).toMatchObject({
      kind: 'preauth-response', correlationId: sent.correlationId, workflowId: '21', senderCode: PAYER_CODE, recipientCode: PROVIDER_CODE,
      hcxStatus: 'response.complete', duplicate: false, gatewayAuthVerified: false,
      result: { kind: 'claim-response', decision: 'approved', caseNumber: 'H1-PA-2026-000412', approvedAmount: 322500 },
    });
    expect(out.message.apiCallId).not.toBe(sent.apiCallId);
    expect(out.body).toMatchObject({
      api_call_id: out.message.apiCallId, correlation_id: sent.correlationId,
      result: { sender_code: PAYER_CODE, recipient_code: PROVIDER_CODE, entity_type: 'preauth', protocol_status: 'request.queued' },
      error: { code: '', message: '' },
    });
    expect(out.body.timestamp).toMatch(ACK_TS);
  });

  it('flags a redelivered api_call_id as duplicate (idempotent 202)', async () => {
    const h = createHarness();
    const m = await seal(h, claimResponseBundle);
    const first = await h.handle({ path: '/v1/preauth/on_submit', body: m.body });
    expect(first.accepted).toBe(true);
    h.storedApiCallIds.add(m.headers['x-hcx-api_call_id']);
    const again = await h.handle({ path: '/v1/preauth/on_submit', body: m.body });
    expect(again).toMatchObject({ accepted: true, httpStatus: 202, message: { duplicate: true, result: null, bundle: null } });
  });

  it.each([
    ['wrong recipient', { 'x-hcx-recipient_code': '999999@hcx' }, 'ERR_INVALID_RECIPIENT'],
    ['stale timestamp', { 'x-hcx-timestamp': '2026-10-26T08:00:00+05:30' }, 'ERR_INVALID_TIMESTAMP'],
    ['future timestamp', { 'x-hcx-timestamp': formatIstDateTime(new Date('2026-10-28T09:00:00Z')) }, 'ERR_INVALID_TIMESTAMP'],
    ['missing correlation', { 'x-hcx-correlation_id': '' }, 'ERR_MANDATORY_HEADER_MISSING'],
  ])('rejects %s', async (_n, over, code) => {
    const h = createHarness();
    const m = await seal(h, claimResponseBundle, over as Partial<ProtocolHeaders>);
    const out = await h.handle({ path: '/v1/preauth/on_submit', body: m.body });
    expect(out).toMatchObject({ accepted: false, httpStatus: 400, error: { code } });
    expect(out.body.error.code).toBe(code);
  });

  it('rejects a tampered payload and one sealed for another key', async () => {
    const h = createHarness();
    const m = await seal(h, claimResponseBundle);
    const body = JSON.parse(m.body);
    const parts = body.payload.split('.');
    parts[3] = parts[3].slice(0, -4) + (parts[3].endsWith('AAAA') ? 'BBBB' : 'AAAA');
    const tampered = await h.handle({ path: '/v1/preauth/on_submit', body: { payload: parts.join('.') } });
    expect(tampered).toMatchObject({ accepted: false, error: { code: 'ERR_INVALID_ENCRYPTION' } });
    expect(tampered.body.api_call_id).toBe(m.headers['x-hcx-api_call_id']);

    const foreign = createHarness();
    const m2 = await seal(h, claimResponseBundle, {}, foreign.providerKeys.certificatePem);
    expect(await h.handle({ path: '/v1/preauth/on_submit', body: m2.body })).toMatchObject({ accepted: false, error: { code: 'ERR_INVALID_ENCRYPTION' } });
  });

  it('rejects the wrong FHIR resource for the path', async () => {
    const h = createHarness();
    const m = await seal(h, { resourceType: 'Bundle', type: 'collection', entry: [{ fullUrl: 'urn:uuid:x', resource: { resourceType: 'Patient' } }] });
    expect(await h.handle({ path: '/v1/claim/on_submit', body: m.body })).toMatchObject({ accepted: false, error: { code: 'ERR_WRONG_DOMAIN_PAYLOAD' } });
  });

  it('accepts a ProtocolResponse (clear-text error from the recipient)', async () => {
    const h = createHarness();
    const corr = crypto.randomUUID();
    const out = await h.handle({ path: '/api/nhcx/v1/preauth/on_submit', body: {
      type: 'ProtocolResponse', 'x-hcx-sender_code': PAYER_CODE, 'x-hcx-recipient_code': PROVIDER_CODE, 'x-hcx-api_call_id': crypto.randomUUID(),
      'x-hcx-correlation_id': corr, 'x-hcx-workflow_id': '20', 'x-hcx-timestamp': formatIstDateTime(h.clock.now), 'x-hcx-status': 'response.error',
      'x-hcx-error_details': { code: 'PAYR-1001', message: 'Error while decrypting request', trace: '' },
    } });
    expect(out).toMatchObject({ accepted: true, message: { kind: 'protocol-error', correlationId: corr, errorDetails: { code: 'PAYR-1001' }, result: null } });
  });

  it('stores /v1/error reports whole and answers 202', async () => {
    const h = createHarness();
    const id = crypto.randomUUID();
    const out = await h.handle({ path: '/v1/error', body: { correlation_id: id, error: { code: 'NHCX-1001', message: 'Receiver system is not reachable.' } } });
    expect(out).toMatchObject({ accepted: true, httpStatus: 202, message: { kind: 'error-report', correlationId: id, errorDetails: { code: 'NHCX-1001' } } });
    expect(out.body.result.entity_type).toBe('error');
  });

  it('rejects unknown paths and non-JSON bodies', async () => {
    const h = createHarness();
    expect(await h.handle({ path: '/v1/whatever/on_x', body: '{}' })).toMatchObject({ accepted: false, httpStatus: 404 });
    expect(await h.handle({ path: '/v1/claim/on_submit', body: '<html>' })).toMatchObject({ accepted: false, httpStatus: 400, error: { code: 'ERR_INVALID_PAYLOAD' } });
  });

  it('verifies the exchange JWT when its key is configured', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const h = createHarness();
    const handle = createCallbackHandler({
      participantCode: PROVIDER_CODE, privateKeyPem: h.providerKeys.privateKeyPem, now: () => h.clock.now,
      gatewayAuth: { publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), issuer: 'nhcx' },
    });
    const signer = await importPKCS8(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'RS256');
    const iat = Math.floor(h.clock.now.getTime() / 1000);
    const jwt = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', typ: 'JWT' }).setJti(crypto.randomUUID()).setIssuer('nhcx').setSubject('nhcx').setIssuedAt(iat).setExpirationTime(iat + 300).sign(signer);
    const m = await seal(h, claimResponseBundle);
    const ok = await handle({ path: '/v1/preauth/on_submit', body: m.body, headers: { Authorization: `Bearer ${jwt}` } });
    expect(ok).toMatchObject({ accepted: true, message: { gatewayAuthVerified: true } });
    expect(await handle({ path: '/v1/preauth/on_submit', body: m.body })).toMatchObject({ accepted: false, httpStatus: 401, error: { code: 'ERR_ACCESS_DENIED' } });
  });

  it('maps paths to receipt entity types', () => {
    expect(useCasePath('/api/nhcx/callback/v1/preauth/on_submit?x=1')).toBe('preauth/on_submit');
    expect(entityTypeFor('preauth/on_submit')).toBe('preauth');
    expect(entityTypeFor('paymentnotice/request')).toBe('payment');
    expect(entityTypeFor('coverageeligibility/on_check')).toBe('coverageeligibility');
    expect(entityTypeFor('on_status')).toBe('status');
    expect(entityTypeFor('error')).toBe('error');
  });
});
