// NHCX client library — input and output types.
//
// Inputs are what ClaimOne fills from its own rows. All money is INR rupees as a
// number (paise as decimals, e.g. 1500.5). Dates are ISO strings: YYYY-MM-DD for
// dates, full ISO 8601 for date-times (rendered in IST, +05:30, on the wire).

import type { HcxStatus, NhcxAction } from './constants';

export type { HcxStatus, NhcxAction };

/** Indian rupees. */
export type Inr = number;

// ---------------------------------------------------------------- config

/** Anything that can hand out a bearer token (e.g. a shared token cache). */
export interface TokenProvider {
  getToken(opts?: { forceRefresh?: boolean }): Promise<string>;
}

/**
 * How the client obtains its bearer token.
 * - `abdm-sessions`: ABDM gateway v3 sessions call (JSON clientId/clientSecret, REQUEST-ID/TIMESTAMP/X-CM-ID headers).
 * - `get-session`: participant service `/get/session` (form-encoded client_id/client_secret).
 * - `hcx-password`: HCX v0.9 `/participant/auth/token/generate` (participant_code, username, secret).
 * - `provider`: caller-supplied token provider.
 */
export type NhcxAuthConfig =
  | { kind: 'abdm-sessions'; url: string; clientId: string; clientSecret: string; cmId: string }
  | { kind: 'get-session'; url: string; clientId: string; clientSecret: string }
  | { kind: 'hcx-password'; url: string; username: string; secret: string }
  | { kind: 'provider'; provider: TokenProvider };

/** Structured log sink. The library only ever passes ids, codes, actions and counts — never payloads. */
export interface NhcxLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export type JweAlg = 'RSA-OAEP-256' | 'RSA-OAEP';

export interface RetryConfig {
  /** Total attempts including the first (default 4). */
  maxAttempts: number;
  /** First backoff in ms (default 500); doubles each attempt with full jitter. */
  baseDelayMs: number;
  /** Backoff ceiling in ms (default 8000). */
  maxDelayMs: number;
}

export interface NhcxConfig {
  /** Our participant code on the exchange, e.g. "1000004446@hcx". */
  participantCode: string;
  /** Hospital's HFR id (goes into Organization.identifier typed NPI; must match the registry record). */
  hfrId: string;
  /** Hospital name as registered. */
  providerName: string;
  /** Use-case base, e.g. https://apisbx.abdm.gov.in/hcx (paths like /v1/preauth/submit are appended). */
  gatewayBaseUrl: string;
  /** Participant service base (fetch/certs, participant/search). */
  registryBaseUrl: string;
  auth: NhcxAuthConfig;
  /** HTTP header carrying the token. NHCX documents `bearer_auth`; HCX v0.9 uses `Authorization`. Default `bearer_auth`. */
  authHeaderName?: string;
  /** Key wrap for outgoing JWE. NHCX samples use RSA-OAEP-256; the HCX v0.9 text says RSA-OAEP. Default RSA-OAEP-256. */
  jweAlg?: JweAlg;
  /** Override any gateway path (per payer differences, e.g. payment ack on /v1/task/submit). */
  paths?: Partial<Record<NhcxAction, string>>;
  /** Registry certificate lookup path (default /fetch/certs). */
  certPath?: string;
  /** Registry participant lookup path (default /participant/search). */
  participantSearchPath?: string;
  retry?: Partial<RetryConfig>;
  /** Per HTTP call timeout (default 30 000 ms). */
  requestTimeoutMs?: number;
  /** Recipient certificate cache TTL (default 24 h). */
  certCacheTtlMs?: number;
  /** Refresh the token this long before it expires (default 120 000 ms). */
  tokenRefreshSkewMs?: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  logger?: NhcxLogger;
}

export interface CallbackConfig {
  /** Our participant code; incoming x-hcx-recipient_code must match it. */
  participantCode: string;
  /** Our RSA private key, PEM (PKCS#8 "PRIVATE KEY" or PKCS#1 "RSA PRIVATE KEY"). */
  privateKeyPem: string;
  /** Algorithms accepted on incoming JWE (default both RSA-OAEP-256 and RSA-OAEP). */
  acceptedAlgs?: JweAlg[];
  /**
   * Duplicate detection. Return true if this x-hcx-api_call_id was already stored.
   * Called only after the message decrypted and validated.
   */
  isDuplicate?: (apiCallId: string) => Promise<boolean> | boolean;
  /** Reject messages whose x-hcx-timestamp is older than this (default 86 400 s; PAYR-1005 uses 24 h). */
  maxAgeSeconds?: number;
  /** Reject messages timestamped further in the future than this (default 300 s). */
  maxFutureSkewSeconds?: number;
  /**
   * Optional verification of the RS256 JWT the exchange signs its calls with
   * (HCX api-security: claims jti, iss, sub, iat, exp). NHCX has not published the
   * key or the header name, so this is off unless configured.
   */
  gatewayAuth?: { publicKeyPem: string; headerName?: string; issuer?: string };
  /** HTTP status for a rejected delivery (default 400, the HCX ErrorResponse status). */
  rejectHttpStatus?: number;
  now?: () => Date;
  logger?: NhcxLogger;
}

// ---------------------------------------------------------------- ClaimOne-side inputs

export type Gender = 'male' | 'female' | 'other' | 'unknown';

export interface PatientInput {
  /** Hospital UHID / MRN. */
  uhid: string;
  name: string;
  gender: Gender;
  /** YYYY-MM-DD. If absent, ageYears is used to emit a year-only birthDate. */
  birthDate?: string;
  ageYears?: number;
  /** 10-digit mobile. */
  mobile?: string;
  /** 14-digit ABHA number, with or without hyphens. */
  abhaNumber?: string;
  /** ABHA address, e.g. name@abdm. */
  abhaAddress?: string;
}

export interface CoverageInput {
  /** Insurer's participant code (payerid from the policy lookup), e.g. "1518@hcx". */
  payerCode: string;
  payerName: string;
  /** Insurer registry id typed NIIP; defaults to payerCode without the "@…" suffix. */
  payerRegistryId?: string;
  policyNumber: string;
  /** Member / beneficiary id from the policy lookup. */
  memberId: string;
  /** Identifier type for memberId on Patient: MB (generic) or PMJAY. Default MB. */
  memberIdType?: 'MB' | 'PMJAY';
  /** Validated (≥ 0) but not sent: NRCeS publishes no Coverage element for it. */
  sumInsured?: Inr;
  /** Product / plan code (productid). */
  productCode?: string;
  relationship?: 'self' | 'spouse' | 'child' | 'parent' | 'other';
}

export interface EncounterInput {
  /** Admission date-time (ISO). */
  admissionDate: string;
  /** Expected (preauth) or actual (claim) discharge date-time. */
  dischargeDate?: string;
  /** Registration / encounter date-time; defaults to admissionDate. */
  registrationDate?: string;
  /** Discharge disposition for the claim, e.g. "Discharged to home". */
  dischargeDisposition?: string;
}

export interface DiagnosisInput {
  icd10Code: string;
  display: string;
  type?: 'admitting' | 'principal' | 'discharge' | 'differential' | 'provisional';
  onAdmission?: boolean;
  /** Optional SNOMED CT mapping, sent as a second coding (never first). */
  snomed?: { code: string; display: string };
}

export interface ProcedureInput {
  /** Package / procedure code exactly as the payer's plan lists it. */
  code: string;
  display: string;
  system?: string;
  /** surgical | conservative | medical | … (https://nhcx.abdm.gov.in/procedure-type). */
  procedureType?: string;
  /** Planned / performed date-time. */
  date?: string;
  snomed?: { code: string; display: string };
}

export interface LineItemInput {
  /** Service / package code exactly as the plan lists it (bill head for final claims). */
  code: string;
  display: string;
  system?: string;
  /** Benefit category (e.g. "MG" General Medicine, "Surgical", "ROOM", "PHARMACY"). */
  categoryCode: string;
  categoryDisplay: string;
  categorySystem?: string;
  quantity: number;
  unitPrice: Inr;
  /** Line amount; must equal quantity × unitPrice when given. */
  amount?: Inr;
  servicedFrom?: string;
  servicedTo?: string;
  /** Indexes (0-based) into diagnoses / procedures this line relates to. Default: all diagnoses, first procedure. */
  diagnosisIndexes?: number[];
  procedureIndexes?: number[];
  /** Ward tier / stratification code (item.modifier). */
  modifier?: { code: string; display: string };
  /** Program code (e.g. AB-PMJAY) for scheme claims. */
  programCode?: { code: string; display: string };
}

export interface DocumentInput {
  /** Document code from the payer's auth-requirements (e.g. MAND0408, POI, MB, HDS). */
  code: string;
  display: string;
  codeSystem?: string;
  /** Supporting-info category: INV (investigation), HDS (discharge summary), MB (bill), POI, … Default INV. */
  categoryCode?: string;
  categoryDisplay?: string;
  contentType: string;
  title: string;
  /** Base64 of the file bytes (encoded once). */
  dataBase64: string;
}

export interface PractitionerInput {
  name: string;
  /** HPR id (Healthcare Professional Registry), e.g. 71-8422-5818-7201. */
  hprId: string;
  qualification?: { code: string; display: string; system?: string };
  /** Speciality as SNOMED (careTeam.qualification), default General medicine. */
  specialty?: { code: string; display: string };
}

export interface ProviderInput {
  hfrId: string;
  name: string;
  participantCode: string;
}

interface ClaimLikeInput {
  /** Provider's case number (Claim.identifier typed CLN). Every later message on the case names it. */
  caseNumber: string;
  provider: ProviderInput;
  patient: PatientInput;
  coverage: CoverageInput;
  encounter: EncounterInput;
  diagnoses: DiagnosisInput[];
  procedures?: ProcedureInput[];
  items: LineItemInput[];
  practitioners: PractitionerInput[];
  documents?: DocumentInput[];
  /** Overall case remarks when answering a query (NMI / CQD). */
  queryAnswerRemarks?: string;
  /** Bundle send time (default now). */
  timestamp?: Date;
}

export type PreauthInput = ClaimLikeInput;

export interface EnhancementInput extends ClaimLikeInput {
  /** Approval reference from the approved pre-auth (ClaimResponse.preAuthRef). */
  preAuthRef: string;
}

export interface ClaimInput extends ClaimLikeInput {
  /** Approval reference from the pre-auth; absent only for a claim with no pre-auth. */
  preAuthRef?: string;
}

export type EligibilityPurpose = 'discovery' | 'validation' | 'benefits' | 'auth-requirements';

export interface EligibilityInput {
  provider: ProviderInput;
  patient: PatientInput;
  coverage: CoverageInput;
  purpose: EligibilityPurpose;
  /** Date of service (YYYY-MM-DD or ISO), not the date of asking. */
  servicedDate?: string;
  items?: Array<{ code: string; display: string; system?: string; categoryCode?: string; categoryDisplay?: string; quantity?: number }>;
  timestamp?: Date;
}

export interface CommunicationResponseInput {
  provider: ProviderInput;
  payer: { code: string; name: string; registryId?: string };
  /** From the parsed CommunicationRequest. */
  request: Pick<ParsedCommunicationRequest, 'caseNumber' | 'communicationRequestFullUrl' | 'reasonCode'>;
  message: string;
  attachments?: Array<Pick<DocumentInput, 'code' | 'contentType' | 'title' | 'dataBase64'>>;
  timestamp?: Date;
}

export interface PaymentAckInput {
  provider: ProviderInput;
  payer: { code: string; name: string; registryId?: string };
  caseNumber: string;
  description?: string;
  timestamp?: Date;
}

// ---------------------------------------------------------------- FHIR (minimal, loose)

export type FhirResource = { resourceType: string; id?: string; [key: string]: unknown };
export interface FhirBundle {
  resourceType: 'Bundle';
  id: string;
  meta?: { profile?: string[]; [k: string]: unknown };
  identifier?: { system?: string; value?: string };
  type: 'collection';
  timestamp?: string;
  entry: Array<{ fullUrl: string; resource: FhirResource }>;
}

// ---------------------------------------------------------------- parsed outputs

export interface CodeDisplay { code?: string; display?: string }

export interface ParsedEligibilityResponse {
  kind: 'coverage-eligibility-response';
  outcome?: string;
  disposition?: string;
  inforce?: boolean;
  benefitPeriod?: { start?: string; end?: string };
  requestReference?: string;
  items: Array<{
    code?: string;
    display?: string;
    authorizationRequired?: boolean;
    benefits: Array<{ type?: string; allowed?: Inr; used?: Inr }>;
    requiredDocuments: CodeDisplay[];
  }>;
  errors: CodeDisplay[];
}

export type ClaimDecision =
  | 'approved'
  | 'partially_approved'
  | 'queried'
  | 'rejected'
  | 'acknowledged'
  | 'cancelled'
  | 'unknown';

export interface ParsedDeduction {
  itemSequence?: number;
  amount: Inr;
  reason?: string;
}

export interface ParsedClaimResponse {
  kind: 'claim-response';
  use?: 'preauthorization' | 'claim' | 'predetermination' | string;
  caseNumber?: string;
  preAuthRef?: string;
  outcome?: string;
  /** Claim-level adjudication reason code (approved / queried / rejected / submitted / cancelled). */
  statusReason?: string;
  decision: ClaimDecision;
  disposition?: string;
  /** Payer's submitted total (from its own record). */
  claimedAmount?: Inr;
  /** Payer's benefit / approved total. */
  approvedAmount?: Inr;
  /** claimed − approved, when both are known. */
  deductionAmount?: Inr;
  copayAmount?: Inr;
  /** Itemised deductions with reasons (item-level `deductible`, or eligible < submitted with a reason). */
  deductions: ParsedDeduction[];
  items: Array<{
    sequence?: number;
    submitted?: Inr;
    eligible?: Inr;
    deductible?: Inr;
    status?: string;
    reasons: string[];
  }>;
  /** Denial / error codes from ClaimResponse.error and processNote text. */
  errors: CodeDisplay[];
  notes: string[];
}

export interface ParsedCommunicationRequest {
  kind: 'communication-request';
  caseNumber?: string;
  reasonCode?: string;
  category?: string;
  priority?: string;
  /** Query text (payload contentStrings joined by newline). */
  text: string;
  communicationRequestId?: string;
  /** fullUrl of the CommunicationRequest entry; the answer's Communication.basedOn points here. */
  communicationRequestFullUrl?: string;
  /** Documents the payer attached to its request (count only; the bundle holds the data). */
  attachmentCount: number;
  /** Task intent: order (query) or proposal (notification). */
  intent?: string;
}

export interface ParsedPaymentNotice {
  kind: 'payment-notice';
  caseNumber?: string;
  paymentStatus?: string;
  /** PaymentNotice.amount — net in samples, gross from some payers; do not treat as net. */
  noticeAmount?: Inr;
  /** The `Payment` detail line: the net that reached the account. */
  netAmount?: Inr;
  tdsAmount?: Inr;
  approvedAmount?: Inr;
  otherLines: Array<{ type: string; amount: Inr }>;
  utr?: string;
  paymentDate?: string;
  disposition?: string;
  /** net + TDS (+ other deductions) === approved, when approved is present; else null. */
  reconciles: boolean | null;
}

export interface ParsedTaskResponse {
  kind: 'task-response';
  taskCode?: string;
  taskStatus?: string;
  claimResponse?: ParsedClaimResponse;
}

export type ParsedResult =
  | ParsedEligibilityResponse
  | ParsedClaimResponse
  | ParsedCommunicationRequest
  | ParsedPaymentNotice
  | ParsedTaskResponse;

// ---------------------------------------------------------------- protocol

export interface ErrorDetails { code: string; message?: string; trace?: string }

/** x-hcx-* protocol headers (and JOSE alg/enc) carried in the JWE protected header. */
export interface ProtocolHeaders {
  'x-hcx-sender_code': string;
  'x-hcx-recipient_code': string;
  'x-hcx-api_call_id': string;
  'x-hcx-request_id'?: string;
  'x-hcx-correlation_id': string;
  'x-hcx-workflow_id'?: string;
  'x-hcx-timestamp': string;
  'x-hcx-status': HcxStatus;
  'x-hcx-ben-abha-id'?: string;
  'x-hcx-use_case'?: 'New' | 'Enhancement' | 'Resubmit';
  'x-hcx-debug_flag'?: string;
  'x-hcx-error_details'?: ErrorDetails;
  'x-hcx-redirect_to'?: string;
  [domainHeader: `x-hcx-${string}`]: unknown;
}

export interface SendOptions {
  /** NHCX workflow step code (e.g. "12" new pre-auth, "13" enhancement, "15" claim). Defaults per action. */
  workflowId?: string;
  /**
   * Thread id. Omit on an originating request (NHCX sets correlation = api_call_id).
   * Required when answering (communication/on_request, paymentnotice/on_request): echo the request's.
   * For hcx/status: the api_call_id of the message being asked about.
   */
  correlationId?: string;
  useCase?: 'New' | 'Enhancement' | 'Resubmit';
  /** Beneficiary ABHA number; sent hyphenated as x-hcx-ben-abha-id. */
  beneficiaryAbha?: string;
  /** Override x-hcx-status (default request.initiated, or response.complete on on_* paths). */
  status?: HcxStatus;
  debugFlag?: 'Error' | 'Info' | 'Debug' | 'INFO';
}

export interface SendResult {
  action: NhcxAction;
  apiCallId: string;
  correlationId: string;
  requestId: string;
  workflowId?: string;
  httpStatus: number;
  /** protocol_status from the gateway receipt (e.g. request.queued), when present. */
  protocolStatus?: string;
  attempts: number;
}

export interface ParticipantRecord {
  participantCode: string;
  name?: string;
  roles?: string[];
  status?: string;
  endpointUrl?: string;
  encryptionCert?: string;
}

/** Synchronous 202 acknowledgement body (NHCX receipt / HCX SuccessResponse). */
export interface AckBody {
  timestamp: string;
  api_call_id: string;
  correlation_id: string;
  result: { sender_code: string; recipient_code: string; entity_type: string; protocol_status: string };
  error: { code: string; message: string };
}

export type InboundKind =
  | 'coverage-eligibility-response'
  | 'preauth-response'
  | 'claim-response'
  | 'communication-request'
  | 'payment-notice'
  | 'status-response'
  | 'task-response'
  | 'protocol-error'
  | 'error-report';

export interface InboundMessage {
  kind: InboundKind;
  path: string;
  apiCallId: string;
  correlationId: string;
  workflowId?: string;
  senderCode: string;
  recipientCode: string;
  hcxStatus?: string;
  timestamp?: string;
  errorDetails?: ErrorDetails;
  /** Parsed, storable result (null for protocol errors / error reports / empty payloads). */
  result: ParsedResult | null;
  /** Decrypted FHIR bundle (contains PHI — persist only into PHI-tagged columns). */
  bundle: unknown | null;
  /** True when isDuplicate() said this api_call_id was already stored; result is null then. */
  duplicate: boolean;
  /** True when gatewayAuth is configured and the exchange's JWT verified. */
  gatewayAuthVerified: boolean;
}

export type CallbackOutcome =
  | { accepted: true; httpStatus: 202; body: AckBody; message: InboundMessage }
  | { accepted: false; httpStatus: number; body: AckBody; error: { code: string; message: string } };
