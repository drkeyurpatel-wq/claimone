// HCX message security: JWE compact serialisation, RSA-OAEP(-256) key wrap,
// A256GCM content encryption, x-hcx-* protocol headers in the protected header.
//
// HCX v0.9 message-security page: alg RSA-OAEP, enc A256GCM, AEAD over the
// protected header (so headers are tamper-evident). NHCX handbook, samples and
// NHA's reference adapter: RSA-OAEP-256 + A256GCM, compact serialisation, body
// {"payload": "<compact JWE>"}. We send RSA-OAEP-256 by default (configurable)
// and accept both on receipt.

import { createPrivateKey, createPublicKey, randomUUID, X509Certificate, type KeyObject } from 'node:crypto';
import { CompactEncrypt, compactDecrypt, decodeProtectedHeader, importPKCS8, importSPKI } from 'jose';
import { HCX_STATUSES, type HcxStatus } from './constants';
import { NhcxError, NhcxProtocolError } from './errors';
import type { JweAlg, ProtocolHeaders } from './types';

export const JWE_ENC = 'A256GCM';
const ALL_ALGS: JweAlg[] = ['RSA-OAEP-256', 'RSA-OAEP'];

// ---------------------------------------------------------------- ids, codes, time

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s.trim());
export const newId = (): string => randomUUID();

/** Participant codes travel as "<id>@<instance>"; NHCX's instance is "hcx". */
export function normalizeCode(code: string): string {
  const c = code.trim();
  return c === '' || c.includes('@') ? c : `${c}@hcx`;
}
export const sameCode = (a: string, b: string): boolean =>
  normalizeCode(a).toLowerCase() === normalizeCode(b).toLowerCase();

const IST_OFFSET_MS = 330 * 60 * 1000;

/** x-hcx-timestamp / Bundle.timestamp: ISO 8601 in Indian time, e.g. 2026-09-04T11:46:34+05:30. */
export function formatIstDateTime(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 19) + '+05:30';
}

/** Parses ISO 8601 (+05:30, +0530, Z) or a Unix epoch in seconds or milliseconds. Returns null if unreadable. */
export function parseHcxTimestamp(value: unknown): Date | null {
  if (typeof value === 'number') return new Date(value > 1e12 ? value : value * 1000);
  if (typeof value !== 'string' || value.trim() === '') return null;
  const v = value.trim();
  if (/^\d{9,13}$/.test(v)) {
    const n = Number(v);
    return new Date(v.length >= 13 ? n : n * 1000);
  }
  const iso = v.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t);
}

/** Receipt timestamp: DD/MM/YYYY HH:mm:ss:SSS in Indian time (NHCX receipt shape). */
export function formatAckTimestamp(d: Date): string {
  const s = new Date(d.getTime() + IST_OFFSET_MS).toISOString(); // YYYY-MM-DDTHH:mm:ss.SSSZ
  return `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)} ${s.slice(11, 19)}:${s.slice(20, 23)}`;
}

/** ABHA number hyphenated as XX-XXXX-XXXX-XXXX (NHCX-1018 otherwise). Throws without echoing the value. */
export function formatAbhaNumber(abha: string): string {
  const digits = abha.replace(/\D/g, '');
  if (digits.length !== 14) {
    throw new NhcxError('validation', 'ERR_LOCAL_VALIDATION', 'beneficiaryAbha: must have 14 digits');
  }
  return `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6, 10)}-${digits.slice(10)}`;
}

// ---------------------------------------------------------------- keys

/** Accepts PEM, base64-of-PEM (as the NHCX registry stores encryption_cert), or bare base64 DER. */
function decodeKeyMaterial(material: string): string | Buffer {
  let m = material.trim().replace(/\\n/g, '\n');
  if (m.includes('-----BEGIN')) return m;
  const compact = m.replace(/\s+/g, '');
  if (/^[A-Za-z0-9+/=_-]+$/.test(compact)) {
    const buf = Buffer.from(compact, 'base64');
    const text = buf.toString('utf8');
    if (text.includes('-----BEGIN')) return text;
    return buf; // DER
  }
  m = compact;
  return m;
}

function cryptoError(code: string, message: string): NhcxError {
  return new NhcxError('crypto', code, message);
}

/**
 * The recipient's RSA public key from whatever the registry returned: an X.509
 * certificate, an SPKI "PUBLIC KEY", a PKCS#1 "RSA PUBLIC KEY", or their base64.
 */
export function loadPublicKeyObject(material: string): KeyObject {
  let key: KeyObject;
  try {
    const decoded = decodeKeyMaterial(material);
    if (typeof decoded === 'string') {
      key = decoded.includes('BEGIN CERTIFICATE') ? new X509Certificate(decoded).publicKey : createPublicKey(decoded);
    } else {
      try {
        key = new X509Certificate(decoded).publicKey;
      } catch {
        key = createPublicKey({ key: decoded, format: 'der', type: 'spki' });
      }
    }
  } catch {
    throw cryptoError('ERR_BAD_CERTIFICATE', 'recipient certificate or public key could not be read');
  }
  if (key.asymmetricKeyType !== 'rsa') throw cryptoError('ERR_BAD_CERTIFICATE', 'recipient key is not RSA');
  return key;
}

export async function importRecipientKey(material: string, alg: JweAlg): Promise<CryptoKey> {
  const spki = loadPublicKeyObject(material).export({ type: 'spki', format: 'pem' }).toString();
  return importSPKI(spki, alg);
}

/** Own private key holder: imports lazily per algorithm (an RSA-OAEP-256 CryptoKey cannot unwrap RSA-OAEP). */
export class PrivateKeyRing {
  private readonly pkcs8: string;
  private readonly cache = new Map<JweAlg, Promise<CryptoKey>>();

  constructor(privateKeyPem: string) {
    try {
      const decoded = decodeKeyMaterial(privateKeyPem);
      const obj = typeof decoded === 'string'
        ? createPrivateKey(decoded)
        : createPrivateKey({ key: decoded, format: 'der', type: 'pkcs8' });
      if (obj.asymmetricKeyType !== 'rsa') throw new Error('not rsa');
      this.pkcs8 = obj.export({ type: 'pkcs8', format: 'pem' }).toString();
    } catch {
      throw new NhcxError('config', 'ERR_BAD_PRIVATE_KEY', 'own private key could not be read (expect RSA PEM)');
    }
  }

  get(alg: JweAlg): Promise<CryptoKey> {
    let p = this.cache.get(alg);
    if (!p) {
      p = importPKCS8(this.pkcs8, alg);
      this.cache.set(alg, p);
    }
    return p;
  }
}

// ---------------------------------------------------------------- headers

export interface BuildHeadersInput {
  senderCode: string;
  recipientCode: string;
  status: HcxStatus;
  apiCallId?: string;
  correlationId?: string;
  requestId?: string;
  workflowId?: string;
  timestamp: Date;
  beneficiaryAbha?: string;
  useCase?: ProtocolHeaders['x-hcx-use_case'];
  debugFlag?: string;
  errorDetails?: ProtocolHeaders['x-hcx-error_details'];
}

/** Protocol headers. On an originating request correlation_id defaults to the api_call_id (NHCX rule). */
export function buildProtocolHeaders(input: BuildHeadersInput): ProtocolHeaders {
  const apiCallId = input.apiCallId ?? newId();
  const h: ProtocolHeaders = {
    'x-hcx-sender_code': normalizeCode(input.senderCode),
    'x-hcx-recipient_code': normalizeCode(input.recipientCode),
    'x-hcx-api_call_id': apiCallId,
    'x-hcx-request_id': input.requestId ?? newId(),
    'x-hcx-correlation_id': input.correlationId ?? apiCallId,
    'x-hcx-timestamp': formatIstDateTime(input.timestamp),
    'x-hcx-status': input.status,
  };
  if (input.workflowId) h['x-hcx-workflow_id'] = input.workflowId;
  if (input.beneficiaryAbha) h['x-hcx-ben-abha-id'] = formatAbhaNumber(input.beneficiaryAbha);
  if (input.useCase) h['x-hcx-use_case'] = input.useCase;
  if (input.debugFlag) h['x-hcx-debug_flag'] = input.debugFlag;
  if (input.errorDetails) h['x-hcx-error_details'] = input.errorDetails;
  return h;
}

export interface HeaderCheckOptions {
  expectedRecipient: string;
  now: Date;
  maxAgeSeconds: number;
  maxFutureSkewSeconds: number;
}

/** Validates the protocol headers of an incoming message. Throws NhcxProtocolError with an HCX error code. */
export function validateProtocolHeaders(raw: Record<string, unknown>, opts: HeaderCheckOptions): ProtocolHeaders {
  const str = (k: string) => (typeof raw[k] === 'string' ? (raw[k] as string).trim() : '');
  const apiCallId = str('x-hcx-api_call_id');
  const correlationId = str('x-hcx-correlation_id');
  const ids = { apiCallId: isUuid(apiCallId) ? apiCallId : undefined, correlationId: isUuid(correlationId) ? correlationId : undefined };

  for (const k of ['x-hcx-sender_code', 'x-hcx-recipient_code', 'x-hcx-api_call_id', 'x-hcx-correlation_id', 'x-hcx-timestamp']) {
    if (!str(k)) throw new NhcxProtocolError('ERR_MANDATORY_HEADER_MISSING', `missing ${k}`, ids);
  }
  if (!isUuid(apiCallId)) throw new NhcxProtocolError('ERR_INVALID_API_CALL_ID', 'x-hcx-api_call_id is not a UUID', ids);
  if (!isUuid(correlationId)) throw new NhcxProtocolError('ERR_INVALID_CORRELATION_ID', 'x-hcx-correlation_id is not a UUID', ids);
  if (!sameCode(str('x-hcx-recipient_code'), opts.expectedRecipient)) {
    throw new NhcxProtocolError('ERR_INVALID_RECIPIENT', 'message is addressed to another participant', ids);
  }
  const status = str('x-hcx-status');
  if (status && !HCX_STATUSES.includes(status as HcxStatus)) {
    throw new NhcxProtocolError('ERR_INVALID_STATUS', 'x-hcx-status has an unknown value', ids);
  }
  const ts = parseHcxTimestamp(raw['x-hcx-timestamp']);
  if (!ts) throw new NhcxProtocolError('ERR_INVALID_TIMESTAMP', 'x-hcx-timestamp unreadable', ids);
  const ageMs = opts.now.getTime() - ts.getTime();
  if (ageMs > opts.maxAgeSeconds * 1000) throw new NhcxProtocolError('ERR_INVALID_TIMESTAMP', 'message is stale', ids);
  if (-ageMs > opts.maxFutureSkewSeconds * 1000) throw new NhcxProtocolError('ERR_INVALID_TIMESTAMP', 'message is timestamped in the future', ids);
  return raw as unknown as ProtocolHeaders;
}

// ---------------------------------------------------------------- encrypt / decrypt

/**
 * Encrypts a payload for one recipient. `payload` is a FHIR bundle (JSON-serialised)
 * or a string ("" for the status API). Returns the compact JWE.
 */
export async function encryptPayload(args: {
  payload: unknown;
  recipientKey: CryptoKey;
  headers: ProtocolHeaders;
  alg?: JweAlg;
}): Promise<string> {
  const alg = args.alg ?? 'RSA-OAEP-256';
  const text = typeof args.payload === 'string' ? args.payload : JSON.stringify(args.payload);
  try {
    return await new CompactEncrypt(new TextEncoder().encode(text))
      .setProtectedHeader({ alg, enc: JWE_ENC, ...args.headers })
      .encrypt(args.recipientKey);
  } catch {
    throw cryptoError('ERR_ENCRYPTION_FAILED', 'payload encryption failed');
  }
}

/** Reads the protected header without decrypting (routing / early rejection). */
export function readProtectedHeader(compact: string): Record<string, unknown> {
  try {
    return decodeProtectedHeader(compact) as Record<string, unknown>;
  } catch {
    throw new NhcxProtocolError('ERR_INVALID_PAYLOAD', 'body is not a JWE');
  }
}

export interface DecryptedMessage {
  protectedHeader: Record<string, unknown>;
  plaintext: string;
  /** JSON-parsed plaintext, or null when empty. */
  payload: unknown | null;
}

/** Decrypts with our private key. Tampering (header or body), wrong key or a foreign alg all throw ERR_INVALID_ENCRYPTION. */
export async function decryptPayload(
  compact: string,
  keys: PrivateKeyRing,
  acceptedAlgs: JweAlg[] = ALL_ALGS,
): Promise<DecryptedMessage> {
  if (typeof compact !== 'string' || compact.split('.').length !== 5) {
    throw new NhcxProtocolError('ERR_INVALID_PAYLOAD', 'payload is not a compact JWE');
  }
  const header = readProtectedHeader(compact);
  const ids = {
    apiCallId: isUuid(header['x-hcx-api_call_id']) ? (header['x-hcx-api_call_id'] as string) : undefined,
    correlationId: isUuid(header['x-hcx-correlation_id']) ? (header['x-hcx-correlation_id'] as string) : undefined,
  };
  let result;
  try {
    result = await compactDecrypt(
      compact,
      async (h) => keys.get(h.alg as JweAlg),
      { keyManagementAlgorithms: acceptedAlgs, contentEncryptionAlgorithms: [JWE_ENC] },
    );
  } catch {
    throw new NhcxProtocolError('ERR_INVALID_ENCRYPTION', 'payload could not be decrypted', ids);
  }
  const plaintext = new TextDecoder().decode(result.plaintext);
  let payload: unknown | null = null;
  if (plaintext.trim() !== '') {
    try {
      payload = JSON.parse(plaintext);
    } catch {
      throw new NhcxProtocolError('ERR_INVALID_DOMAIN_PAYLOAD', 'decrypted payload is not JSON', ids);
    }
  }
  return { protectedHeader: result.protectedHeader as Record<string, unknown>, plaintext, payload };
}
