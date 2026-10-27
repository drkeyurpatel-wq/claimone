// ClaimOne — NHCX (National Health Claims Exchange) client, carried over from H1 Claims.
// STATUS: not wired to any screen. FHIR bundle builders are usable; payload
// encryption is NOT implemented and buildJWEPayload() refuses to run.
// mapHMISClaimToNHCX() still expects the retired HMIS row shapes — map from
// clm_claims when this is picked up.
// lib/nhcx/nhcx-client.ts
// NHCX Gateway API client for HMIS
// Protocol: HCX v0.9 | Auth: JWT Bearer | Payload: JWE (RSA-OAEP + A256GCM)

const uuidv4 = () => crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); });
import type { NHCXConfig } from './fhir-bundles';

// ============================================================
// NHCX API ENDPOINTS
// ============================================================
const ENDPOINTS = {
  // Auth
  TOKEN: '/participant/auth/token/generate',
  // Primary flows
  COVERAGE_CHECK: '/coverageeligibility/check',
  PREAUTH_SUBMIT: '/preauth/submit',
  CLAIM_SUBMIT: '/claim/submit',
  PREDETERMINATION_SUBMIT: '/predetermination/submit',
  // Supporting
  CLAIM_STATUS: '/hcx/status/search',
  // Payment
  PAYMENT_NOTICE_ON_REQUEST: '/paymentnotice/on_request',
} as const;

// ============================================================
// AUTH
// ============================================================

/** Get API access token from NHCX gateway */
export async function getAuthToken(config: NHCXConfig): Promise<{ accessToken: string; expiresIn: number } | null> {
  try {
    const res = await fetch(`${config.nhcxGatewayUrl}${ENDPOINTS.TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        participant_code: config.participantCode,
        username: config.username,
        secret: config.secret,
      }).toString(),
    });

    if (!res.ok) {
      console.error('[NHCX] Auth failed:', res.status, await res.text());
      return null;
    }

    const data = await res.json();
    return { accessToken: data.access_token, expiresIn: data.expires_in };
  } catch (error) {
    console.error('[NHCX] Auth error:', error);
    return null;
  }
}

// ============================================================
// JWE PAYLOAD CONSTRUCTION
// ============================================================
// Note: Full JWE encryption requires RSA keys. In production, use jose library.
// For sandbox testing, NHCX accepts base64-encoded payloads with simplified headers.

interface HCXProtocolHeaders {
  'x-hcx-sender_code': string;
  'x-hcx-recipient_code': string;
  'x-hcx-request_id': string;
  'x-hcx-correlation_id': string;
  'x-hcx-timestamp': string;
  'x-hcx-status': string;
  'x-hcx-workflow_id': string;
  'x-hcx-debug_flag'?: string;
}

/** Build HCX protocol headers */
function buildProtocolHeaders(
  config: NHCXConfig, recipientCode: string,
  correlationId?: string, workflowId?: string
): HCXProtocolHeaders {
  const requestId = uuidv4();
  return {
    'x-hcx-sender_code': config.participantCode,
    'x-hcx-recipient_code': recipientCode,
    'x-hcx-request_id': requestId,
    'x-hcx-correlation_id': correlationId || requestId,
    'x-hcx-timestamp': new Date().toISOString(),
    'x-hcx-status': 'request.initiate',
    'x-hcx-workflow_id': workflowId || uuidv4(),
  };
}

/**
 * Build JWE payload for NHCX
 *
 * In production: Use `jose` library for proper RSA-OAEP + A256GCM JWE encryption.
 * For sandbox: Simplified base64 encoding is accepted for testing.
 *
 * The proper flow would be:
 * 1. Build FHIR bundle (our fhir-bundles.ts does this)
 * 2. JSON.stringify the bundle
 * 3. Encrypt with recipient's public RSA key using RSA-OAEP + A256GCM
 * 4. Sign with our private key
 * 5. Serialize as JWE compact: protected.encrypted_key.iv.ciphertext.tag
 */
export function buildJWEPayload(
  config: NHCXConfig, recipientCode: string,
  fhirBundle: any, correlationId?: string, workflowId?: string
): never {
  const headers = buildProtocolHeaders(config, recipientCode, correlationId, workflowId);

  // Protected header (base64url encoded)
  const protectedHeader = {
    alg: 'RSA-OAEP',
    enc: 'A256GCM',
    ...headers,
  };

  // H1 Claims built this "JWE" with placeholder key, IV and tag, and the
  // FHIR bundle only base64-encoded — patient data readable by anyone on
  // the path. Refuse until real RSA-OAEP + A256GCM encryption (the `jose`
  // package, with the recipient's certificate from the NHCX registry) exists.
  void protectedHeader; void fhirBundle;
  throw new Error('NHCX payload encryption is not implemented — do not send claims to NHCX yet');
  // unreachable until encryption is implemented
}

// ============================================================
// API CALLS
// ============================================================

/** Submit a request to NHCX gateway */
async function submitToGateway(
  config: NHCXConfig, endpoint: string, jwePayload: string, accessToken: string
): Promise<{ success: boolean; apiCallId?: string; correlationId?: string; error?: string; timestamp?: string }> {
  try {
    const res = await fetch(`${config.nhcxGatewayUrl}${endpoint}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ payload: jwePayload }),
    });

    const data = await res.json();

    if (res.status === 202) {
      return {
        success: true,
        apiCallId: data.api_call_id,
        correlationId: data.correlation_id,
        timestamp: data.timestamp,
      };
    }

    return {
      success: false,
      error: data.error?.message || data.error?.code || `HTTP ${res.status}`,
    };
  } catch (error: any) {
    return { success: false, error: error.message || 'Network error' };
  }
}

// ============================================================
// HIGH-LEVEL API FUNCTIONS
// ============================================================

/** Check coverage eligibility */
export async function checkCoverageEligibility(
  config: NHCXConfig, fhirBundle: any, recipientCode: string, workflowId?: string
): Promise<{ success: boolean; apiCallId?: string; correlationId?: string; workflowId?: string; error?: string }> {
  const auth = await getAuthToken(config);
  if (!auth) return { success: false, error: 'Authentication failed' };

  const wfId = workflowId || uuidv4();
  const { payload, headers } = buildJWEPayload(config, recipientCode, fhirBundle, undefined, wfId);
  const result = await submitToGateway(config, ENDPOINTS.COVERAGE_CHECK, payload, auth.accessToken);

  return { ...result, workflowId: wfId, correlationId: headers['x-hcx-correlation_id'] };
}

/** Submit pre-authorization */
export async function submitPreAuth(
  config: NHCXConfig, fhirBundle: any, recipientCode: string, workflowId?: string
): Promise<{ success: boolean; apiCallId?: string; correlationId?: string; workflowId?: string; error?: string }> {
  const auth = await getAuthToken(config);
  if (!auth) return { success: false, error: 'Authentication failed' };

  const wfId = workflowId || uuidv4();
  const { payload, headers } = buildJWEPayload(config, recipientCode, fhirBundle, undefined, wfId);
  const result = await submitToGateway(config, ENDPOINTS.PREAUTH_SUBMIT, payload, auth.accessToken);

  return { ...result, workflowId: wfId, correlationId: headers['x-hcx-correlation_id'] };
}

/** Submit final claim */
export async function submitClaim(
  config: NHCXConfig, fhirBundle: any, recipientCode: string, workflowId?: string
): Promise<{ success: boolean; apiCallId?: string; correlationId?: string; workflowId?: string; error?: string }> {
  const auth = await getAuthToken(config);
  if (!auth) return { success: false, error: 'Authentication failed' };

  const wfId = workflowId || uuidv4();
  const { payload, headers } = buildJWEPayload(config, recipientCode, fhirBundle, undefined, wfId);
  const result = await submitToGateway(config, ENDPOINTS.CLAIM_SUBMIT, payload, auth.accessToken);

  return { ...result, workflowId: wfId, correlationId: headers['x-hcx-correlation_id'] };
}

/** Submit pre-determination (cost estimate) */
export async function submitPredetermination(
  config: NHCXConfig, fhirBundle: any, recipientCode: string, workflowId?: string
): Promise<{ success: boolean; apiCallId?: string; correlationId?: string; workflowId?: string; error?: string }> {
  const auth = await getAuthToken(config);
  if (!auth) return { success: false, error: 'Authentication failed' };

  const wfId = workflowId || uuidv4();
  const { payload, headers } = buildJWEPayload(config, recipientCode, fhirBundle, undefined, wfId);
  const result = await submitToGateway(config, ENDPOINTS.PREDETERMINATION_SUBMIT, payload, auth.accessToken);

  return { ...result, workflowId: wfId, correlationId: headers['x-hcx-correlation_id'] };
}

// ============================================================
// CALLBACK RESPONSE PROCESSING
// ============================================================

/** Process incoming NHCX callback (on_check, on_submit) */
export function processCallback(payload: string): {
  headers: Partial<HCXProtocolHeaders>;
  fhirBundle: any;
  status: string;
  error?: any;
} {
  try {
    // JWE compact format: protected.encrypted_key.iv.ciphertext.tag
    const parts = payload.split('.');
    if (parts.length !== 5) return { headers: {}, fhirBundle: null, status: 'error', error: 'Invalid JWE format' };

    // Decode protected header
    const headerJson = Buffer.from(parts[0], 'base64url').toString('utf8');
    const headers = JSON.parse(headerJson);

    // In production, decrypt ciphertext using our private RSA key
    // For sandbox, try base64 decode
    let fhirBundle = null;
    try {
      const bundleJson = Buffer.from(parts[3], 'base64url').toString('utf8');
      fhirBundle = JSON.parse(bundleJson);
    } catch {
      // Encrypted — need proper JWE decryption in production
    }

    return {
      headers,
      fhirBundle,
      status: headers['x-hcx-status'] || 'unknown',
    };
  } catch (error: any) {
    return { headers: {}, fhirBundle: null, status: 'error', error: error.message };
  }
}

// ============================================================
// HMIS → NHCX DATA MAPPER
// ============================================================

/** Map HMIS claim record to NHCX-ready data structures */
export function mapHMISClaimToNHCX(claim: any, patient: any, insurance: any, billItems: any[]): {
  patientData: import('./fhir-bundles').PatientData;
  insuranceData: import('./fhir-bundles').InsuranceData;
  claimData: import('./fhir-bundles').ClaimData;
} {
  return {
    patientData: {
      id: patient.id,
      uhid: patient.uhid,
      firstName: patient.first_name,
      lastName: patient.last_name || '',
      gender: patient.gender?.toLowerCase() || 'other',
      ageYears: patient.age_years,
      phone: patient.phone_primary || '',
      abhaNumber: patient.abha_number,
      address: patient.address,
      pincode: patient.pincode,
    },
    insuranceData: {
      insurerName: insurance?.insurer?.name || claim.insurer_name || '',
      insurerNhcxCode: insurance?.insurer?.nhcx_code,
      tpaName: insurance?.tpa?.name || claim.tpa_name,
      tpaNhcxCode: insurance?.tpa?.nhcx_code,
      policyNumber: insurance?.policy_number || claim.policy_number || '',
      policyType: insurance?.policy_type,
      sumInsured: insurance?.sum_insured ? parseFloat(insurance.sum_insured) : undefined,
      validFrom: insurance?.valid_from,
      validTo: insurance?.valid_to,
      scheme: insurance?.scheme || claim.scheme,
    },
    claimData: {
      claimId: claim.id,
      claimType: claim.claim_type === 'preauth' ? 'preauthorization' : claim.claim_type === 'claim' ? 'claim' : 'predetermination',
      admissionDate: claim.admission_date || claim.created_at?.split('T')[0],
      dischargeDate: claim.discharge_date,
      diagnosisCodes: (claim.diagnosis_codes || []).map((d: any) => ({
        code: d.code || d, display: d.display || d, system: 'http://hl7.org/fhir/sid/icd-10',
      })),
      procedureCodes: (claim.procedure_codes || []).map((p: any) => ({
        code: p.code || p, display: p.display || p,
      })),
      billItems: billItems.map(i => ({
        description: i.description || i.service_name,
        quantity: parseFloat(i.quantity) || 1,
        unitPrice: parseFloat(i.unit_rate || i.unit_price) || 0,
        totalAmount: parseFloat(i.net_amount || i.amount) || 0,
        category: i.category,
      })),
      totalAmount: claim.claimed_amount ? parseFloat(claim.claimed_amount) : billItems.reduce((s: number, i: any) => s + parseFloat(i.net_amount || i.amount || 0), 0),
      doctorName: claim.doctor_name,
      doctorRegistrationNo: claim.doctor_reg_no,
    },
  };
}
