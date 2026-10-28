// FHIR R4 bundles for NHCX (NRCeS profiles) — builders for what a hospital sends,
// parsers for what payers send back.
//
// Element choices follow NHA's NHCX FHIR Reference (nhcx-package/docs/05-FHIR Reference)
// and its sample bundles: Bundle.type "collection", meta.profile on every resource we
// send, references by urn:uuid, timestamps in IST (+05:30), Claim.identifier typed CLN,
// item ids Item/n, supportingInfo ids SupportingInformation/n with sequences,
// Practitioner HPR id typed HPIN, exactly one focal insurance, total = Σ item.net.
// Parsers are tolerant: payer bundles often omit profiles and systems.

import { randomUUID } from 'node:crypto';
import {
  ALLOWED_ATTACHMENT_TYPES, CLAIM_TYPE_INPATIENT, MAX_ATTACHMENT_BYTES, MAX_BUNDLE_ATTACHMENT_BYTES, PROFILE, SYSTEM,
} from './constants';
import { NhcxProtocolError, NhcxValidationError } from './errors';
import { formatAbhaNumber, formatIstDateTime } from './jwe';
import type {
  ClaimDecision, ClaimInput, CodeDisplay, CommunicationResponseInput, CoverageInput, DiagnosisInput, DocumentInput,
  EligibilityInput, EnhancementInput, FhirBundle, FhirResource, Inr, LineItemInput, ParsedClaimResponse,
  ParsedCommunicationRequest, ParsedDeduction, ParsedEligibilityResponse, ParsedPaymentNotice, ParsedTaskResponse,
  PatientInput, PaymentAckInput, PractitionerInput, PreauthInput, ProcedureInput, ProviderInput,
} from './types';

// ================================================================ helpers

const urn = () => `urn:uuid:${randomUUID()}`;
const idOf = (fullUrl: string) => fullUrl.replace('urn:uuid:', '');
const coding = (system: string | undefined, code: string, display?: string) => {
  const c: Record<string, string> = { code };
  if (system) c.system = system;
  if (display) c.display = display;
  return c;
};
const cc = (system: string | undefined, code: string, display?: string) => ({ coding: [coding(system, code, display)] });
export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const money = (v: Inr) => ({ value: round2(v), currency: 'INR' });
const ref = (fullUrl: string, display?: string) => (display ? { reference: fullUrl, display } : { reference: fullUrl });
const FHIR_ID = /^[A-Za-z0-9\-.]{1,64}$/;

function need(cond: unknown, field: string, problem: string): asserts cond {
  if (!cond) throw new NhcxValidationError(field, problem);
}

/** Date-time in IST. Accepts YYYY-MM-DD (midnight IST) or any ISO date-time. */
function istDateTime(value: string, field: string): string {
  need(typeof value === 'string' && value.trim() !== '', field, 'required');
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T00:00:00+05:30`;
  const t = Date.parse(v.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  need(!Number.isNaN(t), field, 'not a valid date-time');
  return formatIstDateTime(new Date(t));
}
function istDate(value: string, field: string): string {
  return istDateTime(value, field).slice(0, 10);
}

function base64Bytes(b64: string, field: string): number {
  const clean = b64.replace(/\s+/g, '');
  need(clean.length > 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(clean) && clean.length % 4 === 0, field, 'not valid base64');
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return (clean.length / 4) * 3 - pad;
}

function validateDocuments(docs: Array<Pick<DocumentInput, 'contentType' | 'dataBase64' | 'title'>>, path: string): void {
  let total = 0;
  docs.forEach((d, i) => {
    const f = `${path}[${i}]`;
    need((ALLOWED_ATTACHMENT_TYPES as readonly string[]).includes(d.contentType), `${f}.contentType`, 'must be pdf, jpeg, png or fhir+json');
    need(d.title && d.title.trim() !== '', `${f}.title`, 'required');
    const bytes = base64Bytes(d.dataBase64, `${f}.dataBase64`);
    need(bytes <= MAX_ATTACHMENT_BYTES, `${f}.dataBase64`, 'larger than 2 MB');
    total += bytes;
  });
  need(total <= MAX_BUNDLE_ATTACHMENT_BYTES, path, 'attachments exceed 20 MB in total');
}

function profiled<T extends FhirResource>(profile: string | undefined, r: T): T {
  return profile ? ({ ...r, meta: { profile: [profile] } } as T) : r;
}

function makeBundle(profile: string, timestamp: Date, entries: Array<{ fullUrl: string; resource: FhirResource }>, identifier?: string): FhirBundle {
  const b: FhirBundle = {
    resourceType: 'Bundle',
    id: randomUUID(),
    meta: { profile: [profile] },
    type: 'collection',
    timestamp: formatIstDateTime(timestamp),
    entry: entries,
  };
  if (identifier) b.identifier = { system: SYSTEM.nhcxIdentifier, value: identifier };
  return b;
}

// ================================================================ shared resources

function providerOrg(p: ProviderInput, fullUrl: string): FhirResource {
  need(p.hfrId?.trim(), 'provider.hfrId', 'required');
  need(p.name?.trim(), 'provider.name', 'required');
  return profiled(PROFILE.Organization, {
    resourceType: 'Organization',
    id: idOf(fullUrl),
    identifier: [{ type: cc(SYSTEM.v20203, 'NPI', 'National provider identifier'), system: SYSTEM.nhcxIdentifier, value: p.hfrId }],
    type: [cc(SYSTEM.organizationType, 'prov', 'Healthcare Provider')],
    name: p.name,
  });
}

function payerOrg(payer: { code: string; name: string; registryId?: string }, fullUrl: string, field = 'coverage'): FhirResource {
  need(payer.code?.trim(), `${field}.payerCode`, 'required');
  need(payer.name?.trim(), `${field}.payerName`, 'required');
  const registryId = payer.registryId ?? payer.code.split('@')[0];
  return profiled(PROFILE.Organization, {
    resourceType: 'Organization',
    id: idOf(fullUrl),
    identifier: [{ type: cc(SYSTEM.v20203, 'NIIP', 'National Insurance Payor Identifier (Payor)'), system: SYSTEM.nhcxIdentifier, value: registryId }],
    type: [cc(SYSTEM.organizationType, 'pay', 'Payer')],
    name: payer.name,
  });
}

function patientResource(p: PatientInput, c: CoverageInput, fullUrl: string): FhirResource {
  need(p.uhid?.trim(), 'patient.uhid', 'required');
  need(p.name?.trim(), 'patient.name', 'required');
  need(['male', 'female', 'other', 'unknown'].includes(p.gender), 'patient.gender', 'must be male, female, other or unknown');
  need(p.birthDate || (typeof p.ageYears === 'number' && p.ageYears >= 0 && p.ageYears < 130), 'patient.birthDate', 'birthDate or ageYears required');
  if (p.mobile !== undefined) need(/^\+?\d{10,13}$/.test(p.mobile.replace(/[\s-]/g, '')), 'patient.mobile', 'must be a 10-digit mobile');

  const identifier: unknown[] = [
    { type: cc(SYSTEM.v20203, 'MR', 'Medical record number'), system: SYSTEM.nhcxIdentifier, value: p.uhid },
    c.memberIdType === 'PMJAY'
      ? { type: cc(SYSTEM.identifierType, 'PMJAY', 'Pradhan Mantri Jan Aarogya Yojana (PMJAY) ID'), system: SYSTEM.nhcxIdentifier, value: c.memberId }
      : { type: cc(SYSTEM.v20203, 'MB', 'Member Number'), system: SYSTEM.nhcxIdentifier, value: c.memberId },
  ];
  if (p.abhaNumber) {
    let abha: string;
    try {
      abha = formatAbhaNumber(p.abhaNumber);
    } catch {
      throw new NhcxValidationError('patient.abhaNumber', 'must have 14 digits');
    }
    identifier.push({ type: cc(SYSTEM.identifierType, 'ABHA', 'Ayushman Bharat Health Account (ABHA) ID'), system: SYSTEM.abha, value: abha });
  }
  if (p.abhaAddress) {
    need(/^[A-Za-z0-9._]+@[A-Za-z]+$/.test(p.abhaAddress), 'patient.abhaAddress', 'must look like name@abdm');
    identifier.push({ type: { text: 'ABHA Address' }, system: SYSTEM.abha, value: p.abhaAddress });
  }
  const r: FhirResource = {
    resourceType: 'Patient',
    id: idOf(fullUrl),
    identifier,
    name: [{ text: p.name }],
    gender: p.gender,
    birthDate: p.birthDate
      ? istDate(p.birthDate, 'patient.birthDate')
      : String(new Date().getUTCFullYear() - Math.floor(p.ageYears as number)),
  };
  if (p.mobile) r.telecom = [{ system: 'phone', value: p.mobile.replace(/[\s-]/g, ''), use: 'mobile' }];
  return profiled(PROFILE.Patient, r);
}

function coverageResource(c: CoverageInput, patientUrl: string, payerUrl: string, fullUrl: string): FhirResource {
  need(c.policyNumber?.trim(), 'coverage.policyNumber', 'required');
  need(c.memberId?.trim(), 'coverage.memberId', 'required');
  if (c.sumInsured !== undefined) need(Number.isFinite(c.sumInsured) && c.sumInsured >= 0, 'coverage.sumInsured', 'must be ≥ 0');
  const r: FhirResource = {
    resourceType: 'Coverage',
    id: idOf(fullUrl),
    identifier: [{ type: cc(SYSTEM.v20203, 'NH', 'National Health Plan Identifier'), system: SYSTEM.nhcxIdentifier, value: c.policyNumber }],
    status: 'active',
    type: cc(SYSTEM.actCode, 'HIP', 'health insurance plan policy'),
    subscriber: ref(patientUrl),
    subscriberId: c.memberId,
    beneficiary: ref(patientUrl),
    relationship: cc(SYSTEM.subscriberRelationship, c.relationship ?? 'self'),
    payor: [ref(payerUrl)],
  };
  if (c.productCode) r.class = [{ type: cc(SYSTEM.v20203, 'XV', 'Health Plan Identifier'), value: c.productCode }];
  // sumInsured is deliberately not emitted: no NRCeS Coverage element or extension for it
  // is published; the payer's eligibility response (allowedMoney) is the authority.
  return profiled(PROFILE.Coverage, r);
}

function practitionerResource(p: PractitionerInput, i: number, fullUrl: string): FhirResource {
  need(p.name?.trim(), `practitioners[${i}].name`, 'required');
  need(p.hprId?.trim(), `practitioners[${i}].hprId`, 'required (HPR id typed HPIN; refused as PAYR-1083 otherwise)');
  const r: FhirResource = {
    resourceType: 'Practitioner',
    id: idOf(fullUrl),
    identifier: [
      { type: cc(SYSTEM.identifierType, 'HPID', 'Healthcare Professional ID (HPID)'), system: SYSTEM.nhcxIdentifier, value: p.hprId },
      { type: cc(SYSTEM.identifierType, 'HPIN', 'Health Practitioner ID issued by NDHM'), system: SYSTEM.hpr, value: p.hprId },
    ],
    name: [{ text: p.name }],
  };
  if (p.qualification) {
    r.qualification = [{ code: cc(p.qualification.system ?? SYSTEM.v20360, p.qualification.code, p.qualification.display) }];
  }
  return profiled(PROFILE.Practitioner, r);
}

// ================================================================ Claim bundles

type ClaimUse = 'preauthorization' | 'claim';

function buildClaimBundle(input: PreauthInput & { preAuthRef?: string }, use: ClaimUse): FhirBundle {
  need(input.caseNumber?.trim(), 'caseNumber', 'required');
  need(Array.isArray(input.diagnoses) && input.diagnoses.length > 0, 'diagnoses', 'at least one ICD-10 diagnosis required');
  need(Array.isArray(input.items) && input.items.length > 0, 'items', 'at least one line item required');
  need(Array.isArray(input.practitioners) && input.practitioners.length > 0, 'practitioners', 'at least one practitioner required');
  if (use === 'claim') need(input.encounter?.dischargeDate, 'encounter.dischargeDate', 'required on a claim');
  const procedures = input.procedures ?? [];
  const documents = input.documents ?? [];
  validateDocuments(documents, 'documents');

  const now = input.timestamp ?? new Date();
  const created = formatIstDateTime(now);
  const u = { claim: urn(), patient: urn(), provider: urn(), payer: urn(), coverage: urn() };
  const practitionerUrls = input.practitioners.map(() => urn());
  const procedureUrls = procedures.map(() => urn());

  const admission = istDateTime(input.encounter?.admissionDate, 'encounter.admissionDate');
  const discharge = input.encounter.dischargeDate ? istDateTime(input.encounter.dischargeDate, 'encounter.dischargeDate') : undefined;
  if (discharge) need(Date.parse(discharge) >= Date.parse(admission), 'encounter.dischargeDate', 'before admission');

  // ---- supporting info: documents first, then dates and remarks; one running sequence
  const supportingInfo: Record<string, unknown>[] = [];
  const docSeqs: number[] = [];
  documents.forEach((d, i) => {
    need(d.code?.trim(), `documents[${i}].code`, 'required');
    const seq = supportingInfo.length + 1;
    docSeqs.push(seq);
    supportingInfo.push({
      id: `SupportingInformation/${seq}`,
      sequence: seq,
      category: cc(SYSTEM.supportingInfoCategory, d.categoryCode ?? 'INV', d.categoryDisplay ?? (d.categoryCode ? undefined : 'Document Type - Investigation')),
      code: cc(d.codeSystem ?? SYSTEM.documentCode, d.code, d.display),
      valueAttachment: { contentType: d.contentType, data: d.dataBase64.replace(/\s+/g, ''), title: d.title },
    });
  });
  const addInfo = (cat: string, catDisplay: string, code: string, codeDisplay: string, value: string) => {
    const seq = supportingInfo.length + 1;
    supportingInfo.push({
      sequence: seq,
      category: cc(SYSTEM.supportingInfoCategory, cat, catDisplay),
      code: cc(SYSTEM.supportingInfoCode, code, codeDisplay),
      valueString: value,
    });
  };
  addInfo('ONS', 'Period, start or end dates of aspects of the Condition. (e.g. admission, discharge etc)', 'ADDD', 'Admission date -Discharge date', admission);
  addInfo('OTH', 'Other', 'EDT', 'EncounterDateTime',
    input.encounter.registrationDate ? istDateTime(input.encounter.registrationDate, 'encounter.registrationDate') : admission);
  if (use === 'claim' && discharge) {
    addInfo('ONS', 'Period, start or end dates of aspects of the Condition. (e.g. admission, discharge etc)', 'DSDE', 'Discharge start-discharge end time', discharge);
    if (input.encounter.dischargeDisposition) {
      addInfo('DIS', 'Discharge status and discharge to location detail', 'DTH', 'DischargeToHome (Discharge disposition status)', input.encounter.dischargeDisposition);
    }
  }
  if (input.queryAnswerRemarks) addInfo('NMI', 'Claim query detail', 'CQD', 'Claim query detail', input.queryAnswerRemarks);

  // ---- diagnoses: ICD-10 first, SNOMED second
  const diagnosis = input.diagnoses.map((d: DiagnosisInput, i) => {
    need(/^[A-Z][0-9]{2}(\.[0-9A-Z]{1,4})?$/i.test(d.icd10Code?.trim() ?? ''), `diagnoses[${i}].icd10Code`, 'not an ICD-10 code');
    need(d.display?.trim(), `diagnoses[${i}].display`, 'required');
    const codings = [coding(SYSTEM.icd10, d.icd10Code.trim().toUpperCase(), d.display)];
    if (d.snomed) codings.push(coding(SYSTEM.snomed, d.snomed.code, d.snomed.display));
    const type = d.type ?? (i === 0 ? (use === 'claim' ? 'discharge' : 'admitting') : 'differential');
    const typeDisplay: Record<string, string> = {
      admitting: 'Admitting Diagnosis', principal: 'Principal Diagnosis', discharge: 'Discharge Diagnosis',
      differential: 'Differential Diagnosis', provisional: 'Provisional Diagnosis',
    };
    const dx: Record<string, unknown> = {
      sequence: i + 1,
      diagnosisCodeableConcept: { coding: codings },
      type: [cc(SYSTEM.diagnosisType, type, typeDisplay[type])],
    };
    if (d.onAdmission !== undefined) {
      dx.onAdmission = cc(SYSTEM.diagnosisOnAdmission, d.onAdmission ? 'yes' : 'no', d.onAdmission ? 'Yes' : 'No');
    }
    return dx;
  });

  // ---- procedures
  const procedureEntries = procedures.map((p: ProcedureInput, i) => {
    need(p.code?.trim(), `procedures[${i}].code`, 'required');
    need(p.display?.trim(), `procedures[${i}].display`, 'required');
    const date = p.date ? istDateTime(p.date, `procedures[${i}].date`) : admission;
    const resource = profiled(PROFILE.Procedure, {
      resourceType: 'Procedure',
      id: idOf(procedureUrls[i]),
      status: use === 'claim' ? 'completed' : 'preparation',
      code: {
        text: p.display,
        coding: [p.snomed ? coding(SYSTEM.snomed, p.snomed.code, p.snomed.display) : coding(SYSTEM.snomed, '71388002', 'Procedure (procedure)')],
      },
      subject: ref(u.patient),
      performedDateTime: date,
    });
    const claimProc: Record<string, unknown> = {
      id: `Procedure/${i + 1}`,
      sequence: i + 1,
      date,
      procedureReference: ref(procedureUrls[i], p.display),
    };
    if (p.procedureType) claimProc.type = [cc(SYSTEM.procedureType, p.procedureType)];
    return { resource, claimProc };
  });

  // ---- items
  const item = input.items.map((it: LineItemInput, i) => {
    const f = `items[${i}]`;
    need(it.code?.trim(), `${f}.code`, 'required');
    need(it.display?.trim(), `${f}.display`, 'required');
    need(it.categoryCode?.trim(), `${f}.categoryCode`, 'required');
    need(Number.isFinite(it.quantity) && it.quantity > 0, `${f}.quantity`, 'must be > 0');
    need(Number.isFinite(it.unitPrice) && it.unitPrice >= 0, `${f}.unitPrice`, 'must be ≥ 0');
    const net = round2(it.quantity * it.unitPrice);
    if (it.amount !== undefined) need(Math.abs(round2(it.amount) - net) < 0.01, `${f}.amount`, 'must equal quantity × unitPrice');
    const dxIdx = it.diagnosisIndexes ?? input.diagnoses.map((_, k) => k);
    const prIdx = it.procedureIndexes ?? (procedures.length ? [0] : []);
    dxIdx.forEach((k) => need(k >= 0 && k < input.diagnoses.length, `${f}.diagnosisIndexes`, 'out of range'));
    prIdx.forEach((k) => need(k >= 0 && k < procedures.length, `${f}.procedureIndexes`, 'out of range'));
    const line: Record<string, unknown> = {
      id: `Item/${i + 1}`,
      sequence: i + 1,
      careTeamSequence: [1],
      diagnosisSequence: dxIdx.map((k) => k + 1),
      category: cc(it.categorySystem ?? SYSTEM.benefitCategory, it.categoryCode, it.categoryDisplay),
      productOrService: cc(it.system ?? SYSTEM.procedureCode, it.code, it.display),
      quantity: { value: it.quantity },
      unitPrice: money(it.unitPrice),
      factor: 1,
      net: money(net),
    };
    if (prIdx.length) line.procedureSequence = prIdx.map((k) => k + 1);
    if (docSeqs.length) line.informationSequence = docSeqs;
    if (it.modifier) line.modifier = [cc(undefined, it.modifier.code, it.modifier.display)];
    if (it.programCode) line.programCode = [cc(SYSTEM.programCode, it.programCode.code, it.programCode.display)];
    const from = it.servicedFrom ?? admission;
    const to = it.servicedTo ?? discharge ?? from;
    line.servicedPeriod = { start: istDate(from, `${f}.servicedFrom`), end: istDate(to, `${f}.servicedTo`) };
    return { line, net };
  });
  const total = round2(item.reduce((s, x) => s + x.net, 0));

  const insurance: Record<string, unknown> = { sequence: 1, focal: true, coverage: ref(u.coverage) };
  if (input.preAuthRef) insurance.preAuthRef = [input.preAuthRef];

  const claimId = FHIR_ID.test(input.caseNumber) ? input.caseNumber : idOf(u.claim);
  const claim: FhirResource = profiled(PROFILE.Claim, {
    resourceType: 'Claim',
    id: claimId,
    identifier: [{ type: cc(SYSTEM.identifierType, 'CLN', 'Claim number'), system: SYSTEM.nhcxIdentifier, value: input.caseNumber }],
    status: 'active',
    type: cc(CLAIM_TYPE_INPATIENT.system, CLAIM_TYPE_INPATIENT.code, CLAIM_TYPE_INPATIENT.display),
    use,
    patient: ref(u.patient),
    billablePeriod: discharge ? { start: admission, end: discharge } : { start: admission },
    created,
    insurer: ref(u.payer),
    provider: ref(u.provider),
    priority: cc(SYSTEM.processPriority, 'normal', 'Normal'),
    careTeam: input.practitioners.map((p, i) => ({
      sequence: i + 1,
      provider: ref(practitionerUrls[i]),
      role: i === 0 ? cc(SYSTEM.careTeamRole, 'primary', 'Primary provider') : cc(SYSTEM.careTeamRole, 'assist', 'Assisting Provider'),
      qualification: cc(SYSTEM.snomed, p.specialty?.code ?? '394802001', p.specialty?.display ?? 'General medicine'),
    })),
    supportingInfo,
    diagnosis,
    ...(procedureEntries.length ? { procedure: procedureEntries.map((p) => p.claimProc) } : {}),
    insurance: [insurance],
    item: item.map((x) => x.line),
    total: money(total),
  });

  const entries = [
    { fullUrl: u.claim, resource: claim },
    { fullUrl: u.patient, resource: patientResource(input.patient, input.coverage, u.patient) },
    { fullUrl: u.provider, resource: providerOrg(input.provider, u.provider) },
    { fullUrl: u.payer, resource: payerOrg({ code: input.coverage.payerCode, name: input.coverage.payerName, registryId: input.coverage.payerRegistryId }, u.payer) },
    { fullUrl: u.coverage, resource: coverageResource(input.coverage, u.patient, u.payer, u.coverage) },
    ...input.practitioners.map((p, i) => ({ fullUrl: practitionerUrls[i], resource: practitionerResource(p, i, practitionerUrls[i]) })),
    ...procedureEntries.map((p, i) => ({ fullUrl: procedureUrls[i], resource: p.resource })),
  ];
  return makeBundle(PROFILE.ClaimBundle, now, entries, input.caseNumber);
}

/** New pre-authorisation (send on preauth/submit, workflow 12). */
export function buildPreauthBundle(input: PreauthInput): FhirBundle {
  return buildClaimBundle(input, 'preauthorization');
}

/**
 * Enhancement (pre-auth update): same case number, Claim.use stays preauthorization,
 * items are cumulative (approved + new). Send on preauth/submit with workflow 13, use_case Enhancement.
 */
export function buildEnhancementBundle(input: EnhancementInput): FhirBundle {
  need(input.preAuthRef?.trim(), 'preAuthRef', 'required for an enhancement');
  return buildClaimBundle(input, 'preauthorization');
}

/** Final / discharge claim (send on claim/submit, workflow 15). */
export function buildClaimSubmissionBundle(input: ClaimInput): FhirBundle {
  return buildClaimBundle(input, 'claim');
}

// ================================================================ eligibility

/** Coverage eligibility check (send on coverageeligibility/check). */
export function buildCoverageEligibilityBundle(input: EligibilityInput): FhirBundle {
  need(['discovery', 'validation', 'benefits', 'auth-requirements'].includes(input.purpose), 'purpose', 'unknown purpose');
  const now = input.timestamp ?? new Date();
  const u = { req: urn(), patient: urn(), provider: urn(), payer: urn(), coverage: urn(), location: urn() };
  const items = input.items ?? [];
  if (input.purpose === 'benefits' || input.purpose === 'auth-requirements') {
    need(items.length > 0, 'items', `required for purpose ${input.purpose}`);
  }
  const req: FhirResource = profiled(PROFILE.CoverageEligibilityRequest, {
    resourceType: 'CoverageEligibilityRequest',
    id: idOf(u.req),
    identifier: [{ system: SYSTEM.nhcxIdentifier, value: idOf(u.req) }],
    status: 'active',
    priority: cc(SYSTEM.processPriority, 'normal', 'Normal'),
    purpose: [input.purpose],
    patient: ref(u.patient),
    servicedDate: istDate(input.servicedDate ?? formatIstDateTime(now), 'servicedDate'),
    created: formatIstDateTime(now),
    provider: ref(u.provider),
    insurer: ref(u.payer),
    facility: ref(u.location),
    insurance: [{ focal: true, coverage: ref(u.coverage) }],
    ...(items.length
      ? {
          item: items.map((it, i) => {
            need(it.code?.trim(), `items[${i}].code`, 'required');
            const out: Record<string, unknown> = {
              productOrService: cc(it.system ?? SYSTEM.procedureCode, it.code, it.display),
              quantity: { value: it.quantity ?? 1 },
            };
            if (it.categoryCode) out.category = cc(SYSTEM.benefitCategory, it.categoryCode, it.categoryDisplay);
            return out;
          }),
        }
      : {}),
  });
  const location: FhirResource = profiled(PROFILE.Location, {
    resourceType: 'Location', id: idOf(u.location), name: input.provider.name, managingOrganization: ref(u.provider),
  });
  return makeBundle(PROFILE.CoverageEligibilityRequestBundle, now, [
    { fullUrl: u.req, resource: req },
    { fullUrl: u.patient, resource: patientResource(input.patient, input.coverage, u.patient) },
    { fullUrl: u.provider, resource: providerOrg(input.provider, u.provider) },
    { fullUrl: u.payer, resource: payerOrg({ code: input.coverage.payerCode, name: input.coverage.payerName, registryId: input.coverage.payerRegistryId }, u.payer) },
    { fullUrl: u.location, resource: location },
    { fullUrl: u.coverage, resource: coverageResource(input.coverage, u.patient, u.payer, u.coverage) },
  ]);
}

// ================================================================ communication response

/**
 * Answer to a payer's CommunicationRequest (send on communication/on_request with the
 * request's correlation id). Task coded deliver, completed, include → Communication
 * whose basedOn names the payer's request.
 */
export function buildCommunicationResponseBundle(input: CommunicationResponseInput): FhirBundle {
  need(input.message?.trim(), 'message', 'required');
  need(input.request?.caseNumber?.trim(), 'request.caseNumber', 'required');
  const attachments = input.attachments ?? [];
  validateDocuments(attachments, 'attachments');
  const now = input.timestamp ?? new Date();
  const u = { task: urn(), comm: urn(), provider: urn(), payer: urn() };
  const comm: FhirResource = profiled(PROFILE.Communication, {
    resourceType: 'Communication',
    id: idOf(u.comm),
    identifier: [{ system: SYSTEM.nhcxIdentifier, value: input.request.caseNumber }],
    ...(input.request.communicationRequestFullUrl ? { basedOn: [ref(input.request.communicationRequestFullUrl, 'CommunicationRequest')] } : {}),
    status: 'completed',
    category: [cc(SYSTEM.communicationCategory, 'notification')],
    priority: 'routine',
    sent: formatIstDateTime(now),
    recipient: [ref(u.payer)],
    sender: ref(u.provider),
    payload: [
      { contentString: input.message },
      ...attachments.map((a) => ({
        contentAttachment: { contentType: a.contentType, title: a.title, creation: formatIstDateTime(now), data: a.dataBase64.replace(/\s+/g, '') },
        extension: [{ url: `${SYSTEM.nhcxIdentifier}/StructureDefinition/document-type`, valueString: a.code }],
      })),
    ],
  });
  const task: FhirResource = profiled(PROFILE.Task, {
    resourceType: 'Task',
    id: idOf(u.task),
    status: 'completed',
    intent: 'order',
    code: cc(SYSTEM.taskCodes, 'deliver'),
    authoredOn: formatIstDateTime(now),
    requester: ref(u.provider, 'Organization'),
    owner: ref(u.payer, 'Organization'),
    input: [{ type: cc(SYSTEM.financialTaskInputType, 'include'), valueReference: ref(u.comm, 'Communication') }],
    ...(input.request.reasonCode ? { reasonCode: cc(SYSTEM.reasonCode, input.request.reasonCode) } : {}),
  });
  return makeBundle(PROFILE.TaskBundle, now, [
    { fullUrl: u.task, resource: task },
    { fullUrl: u.comm, resource: comm },
    { fullUrl: u.provider, resource: providerOrg(input.provider, u.provider) },
    { fullUrl: u.payer, resource: payerOrg(input.payer, u.payer, 'payer') },
  ], input.request.caseNumber);
}

// ================================================================ payment acknowledgement

/** Business acknowledgement of a payment notice (send on paymentnotice/on_request, response.complete). */
export function buildPaymentAckBundle(input: PaymentAckInput): FhirBundle {
  need(input.caseNumber?.trim(), 'caseNumber', 'required');
  const now = input.timestamp ?? new Date();
  const u = { task: urn(), provider: urn(), payer: urn() };
  const task: FhirResource = profiled(PROFILE.Task, {
    resourceType: 'Task',
    id: idOf(u.task),
    status: 'completed',
    intent: 'order',
    code: cc(SYSTEM.financialTaskCode, 'status'),
    description: input.description ?? `Received the payment for claim ${input.caseNumber}`,
    authoredOn: formatIstDateTime(now),
    requester: ref(u.provider),
    owner: ref(u.payer),
    output: [
      { type: cc(SYSTEM.taskOutputType, 'status', 'Status'), valueCodeableConcept: cc(SYSTEM.taskOutputValue, 'paymentack', 'Payment is acknowledged') },
      { type: cc(SYSTEM.taskInputType, 'claimNumber', 'ClaimNumber'), valueString: input.caseNumber },
    ],
  });
  return makeBundle(PROFILE.TaskBundle, now, [
    { fullUrl: u.task, resource: task },
    { fullUrl: u.provider, resource: providerOrg(input.provider, u.provider) },
    { fullUrl: u.payer, resource: payerOrg(input.payer, u.payer, 'payer') },
  ], input.caseNumber);
}

// ================================================================ parsers

// Parsed JSON from a payer: shape is not trusted, read defensively.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

interface Indexed { fullUrl?: string; resource: J }

function bundleEntries(bundle: unknown, what: string): Indexed[] {
  const b = bundle as J;
  if (b && typeof b === 'object' && b.resourceType === 'Bundle' && Array.isArray(b.entry)) {
    return b.entry.filter((e: J) => e && typeof e === 'object' && e.resource && typeof e.resource === 'object');
  }
  if (b && typeof b === 'object' && typeof b.resourceType === 'string') return [{ resource: b }];
  throw new NhcxProtocolError('ERR_WRONG_DOMAIN_PAYLOAD', `expected a FHIR Bundle carrying ${what}`);
}
const ofType = (entries: Indexed[], t: string) => entries.filter((e) => e.resource.resourceType === t);
const firstCode = (c: J): string | undefined => (Array.isArray(c?.coding) ? c.coding.find((x: J) => x?.code)?.code : undefined);
const firstDisplay = (c: J): string | undefined =>
  (Array.isArray(c?.coding) ? c.coding.find((x: J) => x?.display)?.display : undefined) ?? (typeof c?.text === 'string' ? c.text : undefined);
const amountOf = (m: J): number | undefined => {
  const v = typeof m === 'number' ? m : typeof m?.value === 'number' ? m.value : typeof m?.value === 'string' ? Number(m.value) : undefined;
  return v !== undefined && Number.isFinite(v) ? round2(v) : undefined;
};
const str = (v: J): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const identifierValue = (r: J): string | undefined => {
  const ids: J[] = Array.isArray(r?.identifier) ? r.identifier : r?.identifier ? [r.identifier] : [];
  const cln = ids.find((i) => firstCode(i?.type) === 'CLN');
  return str((cln ?? ids[0])?.value);
};
const resolve = (entries: Indexed[], reference: string | undefined): J | undefined => {
  if (!reference) return undefined;
  const tail = reference.split('/').pop();
  return entries.find((e) => e.fullUrl === reference)?.resource
    ?? entries.find((e) => e.resource.id && (reference === `${e.resource.resourceType}/${e.resource.id}` || reference === `urn:uuid:${e.resource.id}` || (tail && e.resource.id === tail)))?.resource;
};

/** CoverageEligibilityResponse (on_check). */
export function parseCoverageEligibilityResponse(bundle: unknown): ParsedEligibilityResponse {
  const entries = bundleEntries(bundle, 'a CoverageEligibilityResponse');
  const r = ofType(entries, 'CoverageEligibilityResponse')[0]?.resource;
  if (!r) throw new NhcxProtocolError('ERR_WRONG_DOMAIN_PAYLOAD', 'no CoverageEligibilityResponse in bundle');
  const ins: J[] = Array.isArray(r.insurance) ? r.insurance : [];
  const items: ParsedEligibilityResponse['items'] = [];
  for (const i of ins) {
    for (const it of Array.isArray(i?.item) ? i.item : []) {
      items.push({
        code: firstCode(it.productOrService),
        display: firstDisplay(it.productOrService),
        authorizationRequired: typeof it.authorizationRequired === 'boolean' ? it.authorizationRequired : undefined,
        benefits: (Array.isArray(it.benefit) ? it.benefit : []).map((b: J) => ({
          type: firstCode(b.type), allowed: amountOf(b.allowedMoney), used: amountOf(b.usedMoney),
        })),
        requiredDocuments: (Array.isArray(it.authorizationSupporting) ? it.authorizationSupporting : []).map((s: J) => ({
          code: firstCode(s), display: firstDisplay(s),
        })),
      });
    }
  }
  return {
    kind: 'coverage-eligibility-response',
    outcome: str(r.outcome),
    disposition: str(r.disposition),
    inforce: ins.length ? ins.some((i) => i?.inforce === true) : undefined,
    benefitPeriod: ins[0]?.benefitPeriod ? { start: str(ins[0].benefitPeriod.start), end: str(ins[0].benefitPeriod.end) } : undefined,
    requestReference: str(r.request?.reference),
    items,
    errors: (Array.isArray(r.error) ? r.error : []).map((e: J) => ({ code: firstCode(e.code), display: firstDisplay(e.code) })),
  };
}

function decide(outcome: string | undefined, reason: string | undefined, claimed?: number, approved?: number, hasDeduction = false): ClaimDecision {
  const o = outcome?.toLowerCase();
  const r = reason?.toLowerCase();
  const reduced = (claimed !== undefined && approved !== undefined && approved + 0.005 < claimed) || hasDeduction;
  if (r === 'approved' || r === 'approve') return o === 'partial' || reduced ? 'partially_approved' : 'approved';
  if (r === 'queried' || r === 'query') return 'queried';
  if (r === 'rejected' || r === 'denied' || r === 'reject') return 'rejected';
  if (r === 'submitted') return 'acknowledged';
  if (r === 'cancelled' || r === 'canceled') return 'cancelled';
  if (o === 'queued') return 'acknowledged';
  if (o === 'error') return 'rejected';
  if (o === 'complete' && approved !== undefined && approved > 0) return reduced ? 'partially_approved' : 'approved';
  return 'unknown';
}

function parseClaimResponseResource(r: J): ParsedClaimResponse {
  const adjCat = (a: J) => firstCode(a?.category)?.toLowerCase();
  const claimLevel: J[] = Array.isArray(r.adjudication) ? r.adjudication : [];
  const statusReason = firstCode(claimLevel.find((a) => adjCat(a) === 'status')?.reason)?.toLowerCase();

  const totals: J[] = Array.isArray(r.total) ? r.total : [];
  const totalOf = (cat: string) => amountOf(totals.find((t) => adjCat(t) === cat)?.amount);
  const deductions: ParsedDeduction[] = [];
  const items = (Array.isArray(r.item) ? r.item : []).map((it: J) => {
    const adj: J[] = Array.isArray(it.adjudication) ? it.adjudication : [];
    const find = (cat: string) => adj.find((a) => adjCat(a) === cat);
    const reasons = adj
      .filter((a) => adjCat(a) === 'reason' || adjCat(a) === 'deductible')
      .map((a) => firstDisplay(a.reason) ?? firstCode(a.reason))
      .filter((s: J): s is string => typeof s === 'string' && s.trim() !== '')
      .map((s: string) => s.trim());
    const submitted = amountOf(find('submitted')?.amount);
    const eligible = amountOf(find('eligible')?.amount) ?? amountOf(find('benefit')?.amount);
    const deductibleAdj = adj.filter((a) => adjCat(a) === 'deductible');
    const deductible = deductibleAdj.length ? round2(deductibleAdj.reduce((s, a) => s + (amountOf(a.amount) ?? 0), 0)) : undefined;
    const seq = typeof it.itemSequence === 'number' ? it.itemSequence : undefined;
    for (const a of deductibleAdj) {
      const amt = amountOf(a.amount);
      if (amt !== undefined && amt > 0) deductions.push({ itemSequence: seq, amount: amt, reason: firstDisplay(a.reason) ?? firstCode(a.reason) ?? reasons[0] });
    }
    if (!deductibleAdj.length && submitted !== undefined && eligible !== undefined && eligible + 0.005 < submitted && statusReason !== 'rejected') {
      deductions.push({ itemSequence: seq, amount: round2(submitted - eligible), reason: reasons[0] });
    }
    return { sequence: seq, submitted, eligible, deductible, status: firstCode(find('status')?.reason), reasons };
  });
  for (const a of claimLevel.filter((x) => adjCat(x) === 'deductible')) {
    const amt = amountOf(a.amount);
    if (amt !== undefined && amt > 0) deductions.push({ amount: amt, reason: firstDisplay(a.reason) ?? firstCode(a.reason) });
  }

  const claimed = totalOf('submitted') ?? (items.length && items.every((i: J) => i.submitted !== undefined) ? round2(items.reduce((s: number, i: J) => s + i.submitted, 0)) : undefined);
  const approved = totalOf('benefit') ?? totalOf('eligible');
  const decision = decide(str(r.outcome), statusReason, claimed, approved, deductions.length > 0);
  const errors: CodeDisplay[] = (Array.isArray(r.error) ? r.error : []).map((e: J) => ({ code: firstCode(e.code), display: firstDisplay(e.code) }));
  const notes: string[] = (Array.isArray(r.processNote) ? r.processNote : []).map((n: J) => str(n?.text)).filter(Boolean) as string[];

  return {
    kind: 'claim-response',
    use: str(r.use),
    caseNumber: identifierValue(r),
    preAuthRef: str(r.preAuthRef),
    outcome: str(r.outcome),
    statusReason,
    decision,
    disposition: str(r.disposition),
    claimedAmount: claimed,
    approvedAmount: decision === 'rejected' ? (approved ?? 0) : approved,
    deductionAmount: claimed !== undefined && approved !== undefined && decision !== 'queried' && decision !== 'acknowledged'
      ? round2(claimed - approved) : undefined,
    copayAmount: totalOf('copay'),
    deductions,
    items,
    errors,
    notes,
  };
}

/** ClaimResponse for a pre-auth, enhancement or claim (on_submit). */
export function parseClaimResponse(bundle: unknown): ParsedClaimResponse {
  const entries = bundleEntries(bundle, 'a ClaimResponse');
  const r = ofType(entries, 'ClaimResponse')[0]?.resource;
  if (!r) throw new NhcxProtocolError('ERR_WRONG_DOMAIN_PAYLOAD', 'no ClaimResponse in bundle');
  return parseClaimResponseResource(r);
}

/** Payer's query / communication request (arrives on communication/request). */
export function parseCommunicationRequest(bundle: unknown): ParsedCommunicationRequest {
  const entries = bundleEntries(bundle, 'a CommunicationRequest');
  const task = ofType(entries, 'Task')[0]?.resource;
  const crEntry = ofType(entries, 'CommunicationRequest')[0] ?? ofType(entries, 'Communication')[0];
  if (!crEntry) throw new NhcxProtocolError('ERR_WRONG_DOMAIN_PAYLOAD', 'no CommunicationRequest in bundle');
  const r = crEntry.resource;
  const payload: J[] = Array.isArray(r.payload) ? r.payload : [];
  const text = payload.map((p) => str(p?.contentString)).filter(Boolean).join('\n') || str(task?.description) || '';
  const reason = (Array.isArray(r.reasonCode) ? r.reasonCode[0] : r.reasonCode) ?? task?.reasonCode;
  const reasonCode = firstCode(reason);
  const caseFromClaim = identifierValue(resolve(entries, r.basedOn?.[0]?.reference) ?? ofType(entries, 'Claim')[0]?.resource);
  return {
    kind: 'communication-request',
    caseNumber: identifierValue(r) ?? caseFromClaim,
    reasonCode: reasonCode === 'claimArbitartion' ? 'claimArbitration' : reasonCode,
    category: firstCode(Array.isArray(r.category) ? r.category[0] : r.category),
    priority: str(r.priority),
    text,
    communicationRequestId: str(r.id),
    communicationRequestFullUrl: crEntry.fullUrl ?? (r.id ? `CommunicationRequest/${r.id}` : undefined),
    attachmentCount: payload.filter((p) => p?.contentAttachment).length,
    intent: str(task?.intent),
  };
}

/** Payment notice (arrives on paymentnotice/request; workflows 30, 31, 33). */
export function parsePaymentNotice(bundle: unknown): ParsedPaymentNotice {
  const entries = bundleEntries(bundle, 'a PaymentNotice');
  const notice = ofType(entries, 'PaymentNotice')[0]?.resource;
  const recon = ofType(entries, 'PaymentReconciliation')[0]?.resource ?? resolve(entries, notice?.payment?.reference);
  if (!notice && !recon) throw new NhcxProtocolError('ERR_WRONG_DOMAIN_PAYLOAD', 'no PaymentNotice in bundle');

  let net: number | undefined;
  let tds: number | undefined;
  let approved: number | undefined;
  const otherLines: Array<{ type: string; amount: number }> = [];
  for (const d of Array.isArray(recon?.detail) ? recon.detail : []) {
    const type = (firstCode(d?.type) ?? '').toLowerCase();
    const amt = amountOf(d?.amount);
    if (amt === undefined) continue;
    if (type === 'payment') net = round2((net ?? 0) + amt);
    else if (type === 'tds') tds = round2((tds ?? 0) + amt);
    else if (type === 'approvedamount') approved = amt;
    else otherLines.push({ type: firstCode(d.type) as string, amount: amt });
  }
  if (net === undefined) net = amountOf(recon?.paymentAmount);
  const deductionLines = otherLines.filter((l) => ['servicetax', 'recovered', 'penality', 'penalty', 'advance'].includes(l.type.toLowerCase()));
  const reconciles = approved !== undefined && net !== undefined
    ? Math.abs(round2(net + (tds ?? 0) + deductionLines.reduce((s, l) => s + l.amount, 0)) - approved) < 0.01
    : null;
  return {
    kind: 'payment-notice',
    caseNumber: identifierValue(notice) ?? identifierValue(recon),
    paymentStatus: firstCode(notice?.paymentStatus),
    noticeAmount: amountOf(notice?.amount),
    netAmount: net,
    tdsAmount: tds,
    approvedAmount: approved,
    otherLines,
    utr: str(recon?.paymentIdentifier?.value),
    paymentDate: str(recon?.paymentDate) ?? str(notice?.paymentDate),
    disposition: str(recon?.disposition),
    reconciles,
  };
}

/** Task answer (task/on_submit, on_status): may wrap a ClaimResponse. */
export function parseTaskResponse(bundle: unknown): ParsedTaskResponse {
  const entries = bundleEntries(bundle, 'a Task');
  const task = ofType(entries, 'Task')[0]?.resource;
  const cr = ofType(entries, 'ClaimResponse')[0]?.resource;
  return {
    kind: 'task-response',
    taskCode: firstCode(task?.code),
    taskStatus: str(task?.status),
    claimResponse: cr ? parseClaimResponseResource(cr) : undefined,
  };
}

/** Every reference in a bundle that should resolve inside it (for tests and pre-send checks). */
export function unresolvedReferences(bundle: FhirBundle): string[] {
  const urls = new Set(bundle.entry.map((e) => e.fullUrl));
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (k === 'reference' && typeof x === 'string' && x.startsWith('urn:uuid:') && !urls.has(x)) out.push(x);
        else walk(x);
      }
    }
  };
  bundle.entry.forEach((e) => walk(e.resource));
  return out;
}
