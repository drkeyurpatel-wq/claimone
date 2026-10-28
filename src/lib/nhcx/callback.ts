// Framework-agnostic handler for what the exchange POSTs to the hospital:
// on_* answers (eligibility, pre-auth, claim, status, task), payer-initiated
// requests (communication/request, paymentnotice/request) and /v1/error reports.
//
// Usage (Next.js route handler):
//   const handle = createCallbackHandler({ participantCode, privateKeyPem, isDuplicate });
//   export async function POST(req: Request, { params }) {
//     const out = await handle({ path: new URL(req.url).pathname, body: await req.text(), headers: Object.fromEntries(req.headers) });
//     if (out.accepted && !out.message.duplicate) await persist(out.message);   // keep it fast: 30 s budget
//     return Response.json(out.body, { status: out.httpStatus });
//   }

import { importSPKI, jwtVerify } from 'jose';
import { describeCode, NhcxError, NhcxProtocolError } from './errors';
import {
  parseClaimResponse, parseCommunicationRequest, parseCoverageEligibilityResponse, parsePaymentNotice, parseTaskResponse,
} from './fhir';
import {
  decryptPayload, formatAckTimestamp, isUuid, loadPublicKeyObject, normalizeCode, PrivateKeyRing, readProtectedHeader,
  validateProtocolHeaders,
} from './jwe';
import type { AckBody, CallbackConfig, CallbackOutcome, ErrorDetails, InboundKind, InboundMessage, ParsedResult } from './types';

export interface CallbackRequest {
  /** Request path, e.g. /api/nhcx/v1/preauth/on_submit (anything before "v1/" is ignored). */
  path: string;
  /** Raw body text or already-parsed JSON. */
  body: unknown;
  headers?: Record<string, string | string[] | undefined>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

/** The use-case part of a callback path: "preauth/on_submit", "on_status", "error", … */
export function useCasePath(path: string): string {
  const p = path.split('?')[0].replace(/\/+$/, '');
  const i = p.lastIndexOf('/v1/');
  if (i >= 0) return p.slice(i + 4);
  const segs = p.split('/').filter(Boolean);
  return segs.slice(-2).join('/');
}

const KIND_BY_PATH: Record<string, InboundKind> = {
  'coverageeligibility/on_check': 'coverage-eligibility-response',
  'preauth/on_submit': 'preauth-response',
  'claim/on_submit': 'claim-response',
  'predetermination/on_submit': 'claim-response',
  'communication/request': 'communication-request',
  'paymentnotice/request': 'payment-notice',
  'on_status': 'status-response',
  'hcx/on_status': 'status-response',
  'task/on_submit': 'task-response',
  'error': 'error-report',
};

/** entity_type for the receipt: second-to-last path segment ("v1" → last), "on_" stripped, paymentnotice → payment. */
export function entityTypeFor(ucPath: string): string {
  const segs = ucPath.split('/').filter(Boolean);
  let e = segs.length >= 2 ? segs[segs.length - 2] : segs[0] ?? '';
  if (e === 'v1' || e === 'hcx') e = segs[segs.length - 1];
  e = e.replace(/^on_/, '');
  return e === 'paymentnotice' ? 'payment' : e;
}

function parseFor(kind: InboundKind, bundle: unknown): ParsedResult | null {
  if (bundle === null || bundle === undefined) return null;
  switch (kind) {
    case 'coverage-eligibility-response': return parseCoverageEligibilityResponse(bundle);
    case 'preauth-response':
    case 'claim-response': return parseClaimResponse(bundle);
    case 'communication-request': return parseCommunicationRequest(bundle);
    case 'payment-notice': return parsePaymentNotice(bundle);
    case 'task-response':
    case 'status-response': {
      const entries: J[] = (bundle as J)?.entry ?? [];
      const hasTask = Array.isArray(entries) && entries.some((e) => e?.resource?.resourceType === 'Task');
      return hasTask ? parseTaskResponse(bundle) : parseClaimResponse(bundle);
    }
    default: return null;
  }
}

function header(headers: CallbackRequest['headers'], name: string): string | undefined {
  if (!headers) return undefined;
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === want) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

export function createCallbackHandler(cfg: CallbackConfig): (req: CallbackRequest) => Promise<CallbackOutcome> {
  if (!cfg.participantCode) throw new NhcxError('config', 'ERR_CONFIG', 'missing participantCode');
  const keys = new PrivateKeyRing(cfg.privateKeyPem);
  const ownCode = normalizeCode(cfg.participantCode);
  const now = () => (cfg.now ? cfg.now() : new Date());
  const maxAge = cfg.maxAgeSeconds ?? 86_400;
  const maxFuture = cfg.maxFutureSkewSeconds ?? 300;
  const rejectStatus = cfg.rejectHttpStatus ?? 400;
  let gatewayKey: Promise<CryptoKey> | null = null;
  if (cfg.gatewayAuth) {
    const spki = loadPublicKeyObject(cfg.gatewayAuth.publicKeyPem).export({ type: 'spki', format: 'pem' }).toString();
    gatewayKey = importSPKI(spki, 'RS256');
  }

  const ack = (ids: { apiCallId?: string; correlationId?: string; sender?: string; recipient?: string }, entity: string, error?: { code: string; message: string }): AckBody => ({
    timestamp: formatAckTimestamp(now()),
    api_call_id: ids.apiCallId ?? '',
    correlation_id: ids.correlationId ?? '',
    result: { sender_code: ids.sender ?? '', recipient_code: ids.recipient ?? ownCode, entity_type: entity, protocol_status: error ? 'response.error' : 'request.queued' },
    error: error ?? { code: '', message: '' },
  });

  const reject = (code: string, entity: string, ids: { apiCallId?: string; correlationId?: string; sender?: string }, status = rejectStatus): CallbackOutcome => {
    const message = describeCode(code);
    cfg.logger?.warn('nhcx.callback.rejected', { code, entity, apiCallId: ids.apiCallId, correlationId: ids.correlationId });
    return { accepted: false, httpStatus: status, body: ack(ids, entity, { code, message }), error: { code, message } };
  };

  return async function handle(req: CallbackRequest): Promise<CallbackOutcome> {
    const uc = useCasePath(req.path ?? '');
    const kind = KIND_BY_PATH[uc];
    if (!kind) return reject('ERR_UNKNOWN_PATH', '', {}, 404); // never echo an unrecognised path
    const entity = entityTypeFor(uc);

    // ---- exchange's signed JWT (optional until NHCX publishes the key)
    let gatewayAuthVerified = false;
    if (gatewayKey && cfg.gatewayAuth) {
      const raw = header(req.headers, cfg.gatewayAuth.headerName ?? 'authorization')?.replace(/^Bearer\s+/i, '');
      try {
        if (!raw) throw new Error('missing');
        const { payload } = await jwtVerify(raw, await gatewayKey, {
          algorithms: ['RS256'], issuer: cfg.gatewayAuth.issuer, requiredClaims: ['jti', 'iss', 'sub', 'iat', 'exp'], currentDate: now(),
        });
        if (payload.sub !== payload.iss) throw new Error('sub');
        gatewayAuthVerified = true;
      } catch {
        return reject('ERR_ACCESS_DENIED', entity, {}, 401);
      }
    }

    // ---- body
    let body: J = req.body;
    if (typeof body === 'string') {
      try {
        body = body.trim() === '' ? {} : JSON.parse(body);
      } catch {
        return reject('ERR_INVALID_PAYLOAD', entity, {});
      }
    }
    if (!body || typeof body !== 'object') return reject('ERR_INVALID_PAYLOAD', entity, {});

    // ---- /v1/error: an unstructured report of a request the exchange gave up on. Always 202.
    if (kind === 'error-report') {
      const pick = (...ks: string[]) => ks.map((k) => body[k]).find((v) => isUuid(v)) as string | undefined;
      const ids = { apiCallId: pick('api_call_id', 'x-hcx-api_call_id', 'apiCallId'), correlationId: pick('correlation_id', 'x-hcx-correlation_id', 'correlationId') };
      const errCode = typeof body?.error?.code === 'string' ? body.error.code : typeof body['x-hcx-error_details']?.code === 'string' ? body['x-hcx-error_details'].code : undefined;
      const message: InboundMessage = {
        kind, path: uc, apiCallId: ids.apiCallId ?? '', correlationId: ids.correlationId ?? '', senderCode: '', recipientCode: ownCode,
        errorDetails: errCode ? { code: errCode } : undefined, result: null, bundle: body, duplicate: false, gatewayAuthVerified,
      };
      cfg.logger?.info('nhcx.callback.error_report', { ...ids, code: errCode });
      return { accepted: true, httpStatus: 202, body: ack(ids, entity), message };
    }

    const checkOpts = { expectedRecipient: ownCode, now: now(), maxAgeSeconds: maxAge, maxFutureSkewSeconds: maxFuture };
    let headers: Record<string, unknown>;
    let bundle: unknown = null;
    const isJwe = typeof body.payload === 'string';

    try {
      if (isJwe) {
        headers = readProtectedHeader(body.payload);
        validateProtocolHeaders(headers, checkOpts); // cheap refusal before the RSA work
        const dec = await decryptPayload(body.payload, keys, cfg.acceptedAlgs);
        headers = dec.protectedHeader; // authenticated by AES-GCM
        bundle = dec.payload;
      } else {
        // ProtocolResponse: x-hcx-* fields in the clear (error or redirect), no payload.
        headers = Object.fromEntries(Object.entries(body).filter(([k]) => k.startsWith('x-hcx-')));
        validateProtocolHeaders(headers, checkOpts);
      }
    } catch (e) {
      if (e instanceof NhcxProtocolError) return reject(e.code, entity, { apiCallId: e.apiCallId, correlationId: e.correlationId });
      return reject('ERR_INVALID_PAYLOAD', entity, {});
    }

    const apiCallId = headers['x-hcx-api_call_id'] as string;
    const correlationId = headers['x-hcx-correlation_id'] as string;
    const senderCode = String(headers['x-hcx-sender_code']);
    const ids = { apiCallId, correlationId, sender: senderCode, recipient: String(headers['x-hcx-recipient_code']) };
    const hcxStatus = typeof headers['x-hcx-status'] === 'string' ? (headers['x-hcx-status'] as string) : undefined;
    const errorDetails = headers['x-hcx-error_details'] && typeof headers['x-hcx-error_details'] === 'object'
      ? (headers['x-hcx-error_details'] as ErrorDetails) : undefined;
    const base = {
      path: uc, apiCallId, correlationId, senderCode, recipientCode: ids.recipient,
      workflowId: headers['x-hcx-workflow_id'] !== undefined ? String(headers['x-hcx-workflow_id']) : undefined,
      hcxStatus, timestamp: typeof headers['x-hcx-timestamp'] === 'string' ? headers['x-hcx-timestamp'] as string : undefined,
      errorDetails, gatewayAuthVerified,
    };

    if (cfg.isDuplicate && (await cfg.isDuplicate(apiCallId))) {
      cfg.logger?.info('nhcx.callback.duplicate', { apiCallId, correlationId, entity });
      return { accepted: true, httpStatus: 202, body: ack(ids, entity), message: { ...base, kind: isJwe ? kind : 'protocol-error', result: null, bundle: null, duplicate: true } };
    }

    if (!isJwe || hcxStatus === 'response.error') {
      const message: InboundMessage = { ...base, kind: kind === 'status-response' && hcxStatus !== 'response.error' ? kind : 'protocol-error', result: null, bundle, duplicate: false };
      cfg.logger?.info('nhcx.callback.accepted', { kind: message.kind, apiCallId, correlationId, workflowId: base.workflowId, code: errorDetails?.code });
      return { accepted: true, httpStatus: 202, body: ack(ids, entity), message };
    }

    let result: ParsedResult | null;
    try {
      result = parseFor(kind, bundle);
    } catch (e) {
      const code = e instanceof NhcxProtocolError ? e.code : 'ERR_INVALID_DOMAIN_PAYLOAD';
      return reject(code, entity, ids);
    }
    cfg.logger?.info('nhcx.callback.accepted', { kind, apiCallId, correlationId, workflowId: base.workflowId });
    return { accepted: true, httpStatus: 202, body: ack(ids, entity), message: { ...base, kind, result, bundle, duplicate: false } };
  };
}
