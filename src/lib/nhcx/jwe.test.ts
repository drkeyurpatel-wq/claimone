import { X509Certificate } from 'node:crypto';
import { CompactEncrypt, importSPKI } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { NhcxProtocolError } from './errors';
import {
  buildProtocolHeaders, decryptPayload, encryptPayload, formatAbhaNumber, formatAckTimestamp, formatIstDateTime, importRecipientKey,
  parseHcxTimestamp, PrivateKeyRing, readProtectedHeader, validateProtocolHeaders,
} from './jwe';
import { generateTestKeyPair, type TestKeyPair } from './testing/keys';
import type { ProtocolHeaders } from './types';

let payer: TestKeyPair;
let other: TestKeyPair;
const now = new Date('2026-10-28T08:00:00Z');
const headers = (over: Partial<ProtocolHeaders> = {}): ProtocolHeaders => ({
  ...buildProtocolHeaders({ senderCode: '1000004446@hcx', recipientCode: '1000003538', status: 'request.initiated', workflowId: '12', timestamp: now }),
  ...over,
});
const bundle = { resourceType: 'Bundle', type: 'collection', entry: [] };

beforeAll(() => {
  payer = generateTestKeyPair('payer');
  other = generateTestKeyPair('other');
});

describe('test key material', () => {
  it('produces a parseable self-signed X.509 certificate', () => {
    const cert = new X509Certificate(payer.certificatePem);
    expect(cert.subject).toContain('CN=payer');
    expect(cert.verify(cert.publicKey)).toBe(true);
  });
});

describe('protocol headers', () => {
  it('builds the NHCX header set; correlation defaults to api_call_id; codes get @hcx', () => {
    const h = headers();
    expect(h['x-hcx-recipient_code']).toBe('1000003538@hcx');
    expect(h['x-hcx-correlation_id']).toBe(h['x-hcx-api_call_id']);
    expect(h['x-hcx-request_id']).not.toBe(h['x-hcx-api_call_id']);
    expect(h['x-hcx-timestamp']).toBe('2026-10-28T13:30:00+05:30');
    expect(h['x-hcx-status']).toBe('request.initiated');
    expect(h['x-hcx-workflow_id']).toBe('12');
  });

  it('hyphenates ABHA numbers and refuses malformed ones without echoing them', () => {
    expect(formatAbhaNumber('91765432109876')).toBe('91-7654-3210-9876');
    expect(() => formatAbhaNumber('9176543210')).toThrow(/14 digits/);
    try { formatAbhaNumber('9176543210'); } catch (e) { expect((e as Error).message).not.toContain('9176543210'); }
  });

  it('timestamps: IST format, parse ISO (+05:30 / +0530 / Z) and epoch, ack format', () => {
    expect(formatIstDateTime(new Date('2026-09-04T06:16:34.975Z'))).toBe('2026-09-04T11:46:34+05:30');
    const t = Date.parse('2023-11-06T07:52:06Z');
    expect(parseHcxTimestamp('2023-11-06T13:22:06+0530')?.getTime()).toBe(t);
    expect(parseHcxTimestamp('2023-11-06T13:22:06+05:30')?.getTime()).toBe(t);
    expect(parseHcxTimestamp('2023-11-06T07:52:06Z')?.getTime()).toBe(t);
    expect(parseHcxTimestamp(String(t))?.getTime()).toBe(t);
    expect(parseHcxTimestamp(String(t / 1000))?.getTime()).toBe(t);
    expect(parseHcxTimestamp('garbage')).toBeNull();
    expect(formatAckTimestamp(new Date('2026-09-04T06:16:41.305Z'))).toBe('04/09/2026 11:46:41:305');
  });
});

describe('JWE round trip', () => {
  it('encrypts as compact JWE (RSA-OAEP-256 + A256GCM) with x-hcx headers protected, decrypts with the private key', async () => {
    const key = await importRecipientKey(payer.certificatePem, 'RSA-OAEP-256');
    const h = headers();
    const jwe = await encryptPayload({ payload: bundle, recipientKey: key, headers: h });
    expect(jwe.split('.')).toHaveLength(5);
    const ph = readProtectedHeader(jwe);
    expect(ph).toMatchObject({ alg: 'RSA-OAEP-256', enc: 'A256GCM', 'x-hcx-api_call_id': h['x-hcx-api_call_id'], 'x-hcx-workflow_id': '12' });
    expect(jwe).not.toContain('Bundle'); // payload is not readable in transit
    const dec = await decryptPayload(jwe, new PrivateKeyRing(payer.privateKeyPem));
    expect(dec.payload).toEqual(bundle);
    expect(dec.protectedHeader['x-hcx-correlation_id']).toBe(h['x-hcx-correlation_id']);
  });

  it('accepts the key as a certificate, SPKI, or base64-of-PEM (as the NHCX registry stores it)', async () => {
    const ring = new PrivateKeyRing(payer.privateKeyPem);
    for (const material of [payer.certificatePem, payer.publicKeyPem, Buffer.from(payer.certificatePem).toString('base64')]) {
      const jwe = await encryptPayload({ payload: '"x"', recipientKey: await importRecipientKey(material, 'RSA-OAEP-256'), headers: headers() });
      expect((await decryptPayload(jwe, ring)).payload).toBe('x');
    }
  });

  it('interoperates with RSA-OAEP (HCX v0.9 alg) on receipt', async () => {
    const jwe = await encryptPayload({ payload: bundle, recipientKey: await importRecipientKey(payer.certificatePem, 'RSA-OAEP'), headers: headers(), alg: 'RSA-OAEP' });
    expect(readProtectedHeader(jwe).alg).toBe('RSA-OAEP');
    expect((await decryptPayload(jwe, new PrivateKeyRing(payer.privateKeyPem))).payload).toEqual(bundle);
    await expect(decryptPayload(jwe, new PrivateKeyRing(payer.privateKeyPem), ['RSA-OAEP-256'])).rejects.toThrow(/ERR_INVALID_ENCRYPTION/);
  });

  it('empty payload (status API) round-trips to null', async () => {
    const jwe = await encryptPayload({ payload: '', recipientKey: await importRecipientKey(payer.publicKeyPem, 'RSA-OAEP-256'), headers: headers() });
    expect((await decryptPayload(jwe, new PrivateKeyRing(payer.privateKeyPem))).payload).toBeNull();
  });
});

describe('JWE rejection', () => {
  const ring = () => new PrivateKeyRing(payer.privateKeyPem);
  const sealed = async () => encryptPayload({ payload: bundle, recipientKey: await importRecipientKey(payer.certificatePem, 'RSA-OAEP-256'), headers: headers() });

  it('rejects a tampered ciphertext', async () => {
    const parts = (await sealed()).split('.');
    const ct = Buffer.from(parts[3], 'base64url');
    ct[0] ^= 0xff;
    parts[3] = ct.toString('base64url');
    await expect(decryptPayload(parts.join('.'), ring())).rejects.toMatchObject({ code: 'ERR_INVALID_ENCRYPTION' });
  });

  it('rejects a tampered protected header (it is AEAD additional data)', async () => {
    const parts = (await sealed()).split('.');
    const h = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    h['x-hcx-recipient_code'] = 'attacker@hcx';
    parts[0] = Buffer.from(JSON.stringify(h)).toString('base64url');
    await expect(decryptPayload(parts.join('.'), ring())).rejects.toMatchObject({ code: 'ERR_INVALID_ENCRYPTION' });
  });

  it('rejects a message sealed for someone else', async () => {
    const jwe = await encryptPayload({ payload: bundle, recipientKey: await importRecipientKey(other.certificatePem, 'RSA-OAEP-256'), headers: headers() });
    const err = await decryptPayload(jwe, ring()).catch((e) => e);
    expect(err).toBeInstanceOf(NhcxProtocolError);
    expect(err.code).toBe('ERR_INVALID_ENCRYPTION');
    expect(err.apiCallId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects non-JWE bodies and foreign content encryption', async () => {
    await expect(decryptPayload('not.a.jwe', ring())).rejects.toMatchObject({ code: 'ERR_INVALID_PAYLOAD' });
    const key = await importSPKI(payer.publicKeyPem, 'RSA-OAEP-256');
    const cbc = await new CompactEncrypt(new TextEncoder().encode('{}')).setProtectedHeader({ alg: 'RSA-OAEP-256', enc: 'A128CBC-HS256' }).encrypt(key);
    await expect(decryptPayload(cbc, ring())).rejects.toMatchObject({ code: 'ERR_INVALID_ENCRYPTION' });
  });
});

describe('header validation', () => {
  const opts = { expectedRecipient: '1000003538@hcx', now, maxAgeSeconds: 86400, maxFutureSkewSeconds: 300 };
  const check = (h: Record<string, unknown>) => () => validateProtocolHeaders(h, opts);

  it('accepts a good header set, matching recipient with or without @hcx', () => {
    expect(() => validateProtocolHeaders(headers() as unknown as Record<string, unknown>, opts)).not.toThrow();
    expect(() => validateProtocolHeaders(headers() as unknown as Record<string, unknown>, { ...opts, expectedRecipient: '1000003538' })).not.toThrow();
  });

  it.each([
    ['wrong recipient', { 'x-hcx-recipient_code': '999@hcx' }, 'ERR_INVALID_RECIPIENT'],
    ['missing sender', { 'x-hcx-sender_code': '' }, 'ERR_MANDATORY_HEADER_MISSING'],
    ['bad api_call_id', { 'x-hcx-api_call_id': '123' }, 'ERR_INVALID_API_CALL_ID'],
    ['bad correlation', { 'x-hcx-correlation_id': 'case-77' }, 'ERR_INVALID_CORRELATION_ID'],
    ['stale', { 'x-hcx-timestamp': formatIstDateTime(new Date(now.getTime() - 25 * 3600_000)) }, 'ERR_INVALID_TIMESTAMP'],
    ['future', { 'x-hcx-timestamp': formatIstDateTime(new Date(now.getTime() + 600_000)) }, 'ERR_INVALID_TIMESTAMP'],
    ['unreadable time', { 'x-hcx-timestamp': 'yesterday' }, 'ERR_INVALID_TIMESTAMP'],
    ['unknown status', { 'x-hcx-status': 'response.success' }, 'ERR_INVALID_STATUS'],
  ])('%s', (_n, over, code) => {
    expect(check({ ...headers(), ...over })).toThrow(expect.objectContaining({ code }));
  });
});
