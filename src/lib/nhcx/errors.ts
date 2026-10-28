// Typed NHCX errors. Messages are fixed strings from this file plus ids/codes —
// never gateway response bodies, FHIR payloads or patient fields.

export type NhcxErrorKind = 'config' | 'validation' | 'auth' | 'registry' | 'gateway' | 'transport' | 'protocol' | 'crypto';

export class NhcxError extends Error {
  readonly kind: NhcxErrorKind;
  /** HCX / NHCX error code (e.g. ERR_INVALID_RECIPIENT, NHCX-1006) or a library code. */
  readonly code: string;
  readonly httpStatus?: number;
  readonly retryable: boolean;
  readonly apiCallId?: string;
  readonly correlationId?: string;

  constructor(
    kind: NhcxErrorKind,
    code: string,
    message: string,
    opts: { httpStatus?: number; retryable?: boolean; apiCallId?: string; correlationId?: string } = {},
  ) {
    super(`[NHCX ${code}] ${message}`);
    this.name = 'NhcxError';
    this.kind = kind;
    this.code = code;
    this.httpStatus = opts.httpStatus;
    this.retryable = opts.retryable ?? false;
    this.apiCallId = opts.apiCallId;
    this.correlationId = opts.correlationId;
  }
}

/** Input that cannot become a valid bundle. `field` is a path such as "items[2].amount" — never a value. */
export class NhcxValidationError extends NhcxError {
  readonly field: string;
  constructor(field: string, problem: string) {
    super('validation', 'ERR_LOCAL_VALIDATION', `${field}: ${problem}`);
    this.name = 'NhcxValidationError';
    this.field = field;
  }
}

/** Incoming message refused (decryption, headers, freshness, recipient). */
export class NhcxProtocolError extends NhcxError {
  constructor(code: string, message: string, opts: { apiCallId?: string; correlationId?: string } = {}) {
    super('protocol', code, message, opts);
    this.name = 'NhcxProtocolError';
  }
}

/** Fixed descriptions for codes the gateway or recipients may return. Used instead of echoing response text. */
export const KNOWN_ERROR_TEXT: Record<string, string> = {
  ERR_ACCESS_DENIED: 'Token expired, empty, or lacks access to this API',
  ERR_INVALID_PAYLOAD: 'Request body is not a valid JWE',
  ERR_INVALID_SENDER: 'Sender not in registry or inactive',
  ERR_INVALID_RECIPIENT: 'Recipient not in registry, inactive, or not allowed',
  ERR_MANDATORY_HEADER_MISSING: 'Mandatory protocol header missing',
  ERR_INVALID_API_CALL_ID: 'x-hcx-api_call_id missing or malformed',
  ERR_INVALID_CORRELATION_ID: 'x-hcx-correlation_id missing, malformed, closed or unknown',
  ERR_INVALID_TIMESTAMP: 'x-hcx-timestamp in the future or too old',
  ERR_INVALID_STATUS: 'x-hcx-status not allowed here',
  ERR_INVALID_WORKFLOW_ID: 'x-hcx-workflow_id malformed or unknown',
  ERR_RECIPIENT_NOT_AVAILABLE: 'Recipient endpoint not reachable',
  ERR_SERVICE_UNAVAILABLE: 'Service unavailable',
  ERR_INVALID_ENCRYPTION: 'Payload could not be decrypted',
  ERR_WRONG_DOMAIN_PAYLOAD: 'Wrong FHIR resource for this API',
  ERR_INVALID_DOMAIN_PAYLOAD: 'FHIR payload does not conform to the profile',
  ERR_SENDER_NOT_SUPPORTED: 'Sender not allowed to send this to the recipient',
  ERR_DOMAIN_PROCESSING: 'Business processing failed',
  'NHCX-401': 'User unauthorized',
  'NHCX-1001': 'Receiver system not reachable',
  'NHCX-1002': 'Sender not registered in NHCX',
  'NHCX-1003': 'Receiver not registered in NHCX',
  'NHCX-1004': 'No receiver registered for the requested scheme',
  'NHCX-1005': 'Invalid request header',
  'NHCX-1006': 'Duplicate request (correlation id already used)',
  'NHCX-1007': 'Request structure or values invalid',
  'NHCX-1008': 'Gateway error, try again later',
  'NHCX-1009': 'Gateway processing error',
  'NHCX-1010': 'No data for this correlation id',
  'NHCX-1011': 'Invalid x-hcx-status for this path',
  'NHCX-1012': 'No records for the api call id',
  'NHCX-1013': 'Invalid or blank request',
  'NHCX-1014': 'Unable to send protocol response to sender',
  'NHCX-1015': 'Not authorised / invalid response from receiver',
  'NHCX-1016': 'Invalid API action for this correlation id',
  'NHCX-1017': 'Invalid response received from receiver',
  'NHCX-1018': 'ABHA number must be XX-XXXX-XXXX-XXXX',
};

/** Error code from a gateway error body, if it is a short code-like token. Never returns free text. */
export function extractErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  const candidates: unknown[] = [];
  if (b.error && typeof b.error === 'object') {
    const e = b.error as Record<string, unknown>;
    candidates.push(e.code, e.errorCode);
  }
  candidates.push(b.code, b.errorCode, b.error);
  for (const c of candidates) {
    if (typeof c === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{1,40}$/.test(c)) return c;
  }
  return undefined;
}

export function describeCode(code: string): string {
  return KNOWN_ERROR_TEXT[code] ?? 'Request refused';
}
