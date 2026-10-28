// NHCX protocol constants — profile URLs, code systems, workflow codes, paths.
//
// Sources (checked Oct 2026):
// - HCX protocol v0.9 spec, github.com/hcx-project/hcx-specs (message-structure,
//   message-security-and-integrity, error-descriptions, openapi_hcx.yaml).
//   docs.hcxprotocol.io itself no longer serves the spec (domain redirects away).
// - NHA's NHCX integration package, github.com/nha-in/nhcx-package (docs/,
//   baseurl.yaml, workflow.yaml, sample bundles) and the NHA reference adapter
//   github.com/nha-in/nhcx-adapter.
// - NRCeS FHIR IG profiles, https://nrces.in/ndhm/fhir/r4/ (canonical URLs below).
//
// Anything the sources disagree on is a config value in NhcxConfig, not a constant.

const NRCES = 'https://nrces.in/ndhm/fhir/r4';

/** Canonical NRCeS StructureDefinition URLs declared in meta.profile. */
export const PROFILE = {
  ClaimBundle: `${NRCES}/StructureDefinition/ClaimBundle`,
  CoverageEligibilityRequestBundle: `${NRCES}/StructureDefinition/CoverageEligibilityRequestBundle`,
  TaskBundle: `${NRCES}/StructureDefinition/TaskBundle`,
  Claim: `${NRCES}/StructureDefinition/Claim`,
  CoverageEligibilityRequest: `${NRCES}/StructureDefinition/CoverageEligibilityRequest`,
  Patient: `${NRCES}/StructureDefinition/Patient`,
  Organization: `${NRCES}/StructureDefinition/Organization`,
  Coverage: `${NRCES}/StructureDefinition/Coverage`,
  Practitioner: `${NRCES}/StructureDefinition/Practitioner`,
  PractitionerRole: `${NRCES}/StructureDefinition/PractitionerRole`,
  Location: `${NRCES}/StructureDefinition/Location`,
  Procedure: `${NRCES}/StructureDefinition/Procedure`,
  Task: `${NRCES}/StructureDefinition/Task`,
  Communication: `${NRCES}/StructureDefinition/Communication`,
} as const;

/** Code systems used by the builders. */
export const SYSTEM = {
  identifierType: `${NRCES}/CodeSystem/ndhm-identifier-type-code`,
  v20203: 'http://terminology.hl7.org/CodeSystem/v2-0203',
  v20360: 'http://terminology.hl7.org/CodeSystem/v2-0360',
  supportingInfoCategory: `${NRCES}/CodeSystem/ndhm-supportinginfo-category`,
  supportingInfoCode: `${NRCES}/CodeSystem/ndhm-supportinginfo-code`,
  documentCode: 'https://nhcx.abdm.gov.in/document-code',
  procedureType: 'https://nhcx.abdm.gov.in/procedure-type',
  procedureCode: `${NRCES}/CodeSystem/ndhm-procedure-code`,
  benefitCategory: `${NRCES}/CodeSystem/ndhm-benefit-category`,
  programCode: `${NRCES}/CodeSystem/ndhm-program-code`,
  reasonCode: `${NRCES}/CodeSystem/ndhm-reason-code`,
  taskCodes: `${NRCES}/CodeSystem/ndhm-task-codes`,
  taskOutputType: `${NRCES}/CodeSystem/ndhm-task-output-type`,
  taskOutputValue: `${NRCES}/CodeSystem/ndhm-task-output-value`,
  taskInputType: `${NRCES}/CodeSystem/ndhm-task-input-type-code`,
  financialTaskCode: 'http://terminology.hl7.org/CodeSystem/financialtaskcode',
  financialTaskInputType: 'http://terminology.hl7.org/CodeSystem/financialtaskinputtype',
  communicationCategory: 'http://terminology.hl7.org/CodeSystem/communication-category',
  snomed: 'http://snomed.info/sct',
  icd10: 'http://hl7.org/fhir/sid/icd-10',
  diagnosisType: 'http://terminology.hl7.org/CodeSystem/ex-diagnosistype',
  diagnosisOnAdmission: 'http://terminology.hl7.org/CodeSystem/ex-diagnosis-on-admission',
  processPriority: 'http://terminology.hl7.org/CodeSystem/processpriority',
  careTeamRole: 'http://terminology.hl7.org/CodeSystem/claimcareteamrole',
  organizationType: 'http://terminology.hl7.org/CodeSystem/organization-type',
  actCode: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
  subscriberRelationship: 'http://terminology.hl7.org/CodeSystem/subscriber-relationship',
  nhcxIdentifier: 'https://nhcx.abdm.gov.in',
  hpr: 'https://hpr.abdm.gov.in',
  abha: 'https://healthid.abdm.gov.in',
} as const;

/** SNOMED CT 737481003 "Inpatient care management (procedure)" — Claim.type per the NHCX FHIR reference. */
export const CLAIM_TYPE_INPATIENT = { system: SYSTEM.snomed, code: '737481003', display: 'Inpatient care management (procedure)' };

/**
 * NHCX workflow step codes (x-hcx-workflow_id), from NHA's Workflow Status Sheet
 * (as reproduced in nhcx-package/workflow.yaml). Provider-sent codes only, plus
 * the payer codes the parser maps.
 */
export const WORKFLOW = {
  preauthNew: '12',
  preauthResubmit: '121',
  preauthEnhancement: '13',
  preauthQueryAnswer: '19',
  enhancementQueryAnswer: '131',
  claimNew: '15',
  claimQueryAnswer: '151',
  paymentAcknowledged: '17',
  /** Insurance plan request and status-enquiry Task: no sheet code, sent as 1. */
  generic: '1',
} as const;

/** Payer-side workflow codes → meaning, for display and parser hints. */
export const PAYER_WORKFLOW: Record<string, string> = {
  '20': 'preauth_received',
  '21': 'preauth_approved',
  '22': 'enhancement_approved',
  '23': 'preauth_rejected',
  '231': 'enhancement_denied',
  '24': 'preauth_queried',
  '241': 'enhancement_queried',
  '25': 'claim_received',
  '26': 'claim_approved',
  '27': 'claim_queried',
  '28': 'claim_in_process',
  '29': 'claim_forwarded',
  '291': 'claim_denied',
  '30': 'payment_initiated',
  '31': 'payment_processed',
  '33': 'payment_settled',
};

export type HcxStatus =
  | 'request.initiated'
  | 'request.queued'
  | 'request.dispatched'
  | 'request.stopped'
  | 'response.partial'
  | 'response.complete'
  | 'response.error'
  | 'response.redirect';

export const HCX_STATUSES: readonly HcxStatus[] = [
  'request.initiated', 'request.queued', 'request.dispatched', 'request.stopped',
  'response.partial', 'response.complete', 'response.error', 'response.redirect',
];

/** Outgoing actions this provider library sends. */
export type NhcxAction =
  | 'coverageeligibility/check'
  | 'preauth/submit'
  | 'claim/submit'
  | 'communication/on_request'
  | 'paymentnotice/on_request'
  | 'hcx/status';

/** Default gateway paths (appended to gatewayBaseUrl). NHCX serves use cases under /v1. */
export const DEFAULT_PATHS: Record<NhcxAction, string> = {
  'coverageeligibility/check': '/v1/coverageeligibility/check',
  'preauth/submit': '/v1/preauth/submit',
  'claim/submit': '/v1/claim/submit',
  'communication/on_request': '/v1/communication/on_request',
  'paymentnotice/on_request': '/v1/paymentnotice/on_request',
  'hcx/status': '/v1/status',
};

/** Default workflow code per action when the caller passes none. */
export const DEFAULT_WORKFLOW: Partial<Record<NhcxAction, string>> = {
  'preauth/submit': WORKFLOW.preauthNew,
  'claim/submit': WORKFLOW.claimNew,
  'paymentnotice/on_request': WORKFLOW.paymentAcknowledged,
};

/** Known environments (nhcx-package/baseurl.yaml). Production addresses must be confirmed at onboarding. */
export const NHCX_ENVIRONMENTS = {
  sandbox: {
    gatewayBaseUrl: 'https://apisbx.abdm.gov.in/hcx',
    registryBaseUrl: 'https://apisbx.abdm.gov.in/pmjay/sbxhcx/participanthcxservice',
    sessionsUrl: 'https://dev.abdm.gov.in/api/hiecm/gateway/v3/sessions',
    cmId: 'sbx',
  },
  production: {
    gatewayBaseUrl: 'https://apisprod.nha.gov.in/hcx',
    registryBaseUrl: 'https://apisprod.nha.gov.in/pmjay/hcx/participanthcxservice',
    sessionsUrl: 'https://apis.abdm.gov.in/api/hiecm/gateway/v3/sessions',
    cmId: 'abdm',
  },
} as const;

/** Attachment content types the reference payer accepts (others are refused with PAYR-1008). */
export const ALLOWED_ATTACHMENT_TYPES = [
  'application/pdf',
  'image/jpeg', 'image/jpg', 'image/png',
  'application/jpg', 'application/jpeg', 'application/png',
  'application/fhir+json',
] as const;

export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
export const MAX_BUNDLE_ATTACHMENT_BYTES = 20 * 1024 * 1024;
