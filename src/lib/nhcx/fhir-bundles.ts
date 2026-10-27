// ClaimOne — FHIR R4 bundles for NHCX (from H1 Claims). Not wired yet; see nhcx-client.ts.
// lib/nhcx/fhir-bundles.ts
// FHIR R4 Bundle generators for NHCX integration
// Spec: https://nrces.in/ndhm/fhir/r4/hcx-profile.html
// HCX v0.9: https://docs.hcxprotocol.io/

const uuidv4 = () => crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); });

// ============================================================
// TYPES
// ============================================================
export interface NHCXConfig {
  participantCode: string;  // Hospital's NHCX participant code
  facilityHfrId: string;    // HFR ID (IN3XXXXXXXX)
  facilityName: string;     // "Hospital"
  facilityCity: string;
  facilityState: string;
  facilityPincode: string;
  nhcxGatewayUrl: string;   // sandbox: https://hcxbeta.nha.gov.in or production
  username: string;
  secret: string;
}

export interface PatientData {
  id: string;
  uhid: string;
  firstName: string;
  lastName: string;
  gender: 'male' | 'female' | 'other';
  dateOfBirth?: string;       // YYYY-MM-DD
  ageYears?: number;
  phone: string;
  abhaNumber?: string;        // ABHA Health ID (XX-XXXX-XXXX-XXXX)
  abhaAddress?: string;       // user@abdm
  address?: string;
  pincode?: string;
}

export interface InsuranceData {
  insurerName: string;
  insurerNhcxCode?: string;   // Insurer's NHCX participant code
  tpaName?: string;
  tpaNhcxCode?: string;       // TPA's NHCX participant code
  policyNumber: string;
  policyType?: string;        // 'individual' | 'family_floater' | 'group'
  sumInsured?: number;
  validFrom?: string;
  validTo?: string;
  subscriberId?: string;      // Employee ID for group policies
  scheme?: string;            // 'pmjay' | 'cghs' | 'echs' | 'private'
}

export interface ClaimData {
  claimId: string;
  claimType: 'preauthorization' | 'claim' | 'predetermination';
  admissionDate: string;
  dischargeDate?: string;
  diagnosisCodes: { code: string; display: string; system?: string }[]; // ICD-10
  procedureCodes?: { code: string; display: string; system?: string }[];
  billItems: { description: string; quantity: number; unitPrice: number; totalAmount: number; category?: string }[];
  totalAmount: number;
  roomType?: string;
  doctorName?: string;
  doctorRegistrationNo?: string;
  supportingDocuments?: { type: string; contentType: string; data: string }[]; // base64 docs
}

// ============================================================
// FHIR RESOURCE BUILDERS
// ============================================================

/** Build FHIR Patient resource */
function buildPatient(patient: PatientData): any {
  const resource: any = {
    resourceType: 'Patient',
    id: uuidv4(),
    meta: { profile: ['https://nrces.in/ndhm/fhir/r4/StructureDefinition/Patient'] },
    identifier: [
      { type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'MR' }] }, system: 'https://hospital.example.com/uhid', value: patient.uhid },
    ],
    name: [{ text: `${patient.firstName} ${patient.lastName}`, given: [patient.firstName], family: patient.lastName }],
    gender: patient.gender,
    telecom: [{ system: 'phone', value: patient.phone }],
  };
  if (patient.abhaNumber) {
    resource.identifier.push({ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0203', code: 'SN' }] }, system: 'https://healthid.ndhm.gov.in', value: patient.abhaNumber });
  }
  if (patient.dateOfBirth) resource.birthDate = patient.dateOfBirth;
  else if (patient.ageYears) {
    const dob = new Date(); dob.setFullYear(dob.getFullYear() - patient.ageYears);
    resource.birthDate = dob.toISOString().split('T')[0];
  }
  if (patient.address) resource.address = [{ text: patient.address, postalCode: patient.pincode, country: 'IN' }];
  return resource;
}

/** Build FHIR Organization resource (Hospital) */
function buildProviderOrganization(config: NHCXConfig): any {
  return {
    resourceType: 'Organization',
    id: uuidv4(),
    meta: { profile: ['https://nrces.in/ndhm/fhir/r4/StructureDefinition/Organization'] },
    identifier: [{ system: 'https://facility.abdm.gov.in', value: config.facilityHfrId }],
    name: config.facilityName,
    address: [{ city: config.facilityCity, state: config.facilityState, postalCode: config.facilityPincode, country: 'IN' }],
  };
}

/** Build FHIR Organization resource (Insurer) */
function buildInsurerOrganization(insurance: InsuranceData): any {
  return {
    resourceType: 'Organization',
    id: uuidv4(),
    meta: { profile: ['https://nrces.in/ndhm/fhir/r4/StructureDefinition/Organization'] },
    identifier: insurance.insurerNhcxCode ? [{ system: 'https://hcxbeta.nha.gov.in', value: insurance.insurerNhcxCode }] : [],
    name: insurance.insurerName,
  };
}

/** Build FHIR Coverage resource */
function buildCoverage(patient: any, insurer: any, insurance: InsuranceData): any {
  return {
    resourceType: 'Coverage',
    id: uuidv4(),
    meta: { profile: ['https://nrces.in/ndhm/fhir/r4/StructureDefinition/Coverage'] },
    status: 'active',
    type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: insurance.scheme === 'pmjay' ? 'PUBLICPOL' : 'EHCPOL' }] },
    subscriber: { reference: `Patient/${patient.id}` },
    subscriberId: insurance.subscriberId || insurance.policyNumber,
    beneficiary: { reference: `Patient/${patient.id}` },
    relationship: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/subscriber-relationship', code: 'self' }] },
    period: { start: insurance.validFrom, end: insurance.validTo },
    payor: [{ reference: `Organization/${insurer.id}` }],
    class: [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/coverage-class', code: 'plan' }] }, value: insurance.policyNumber, name: insurance.policyType || 'Health Insurance' }],
  };
}

// ============================================================
// BUNDLE GENERATORS
// ============================================================

/** Generate CoverageEligibilityRequest Bundle */
export function buildCoverageEligibilityRequestBundle(
  config: NHCXConfig, patient: PatientData, insurance: InsuranceData
): { bundle: any; recipientCode: string } {
  const fhirPatient = buildPatient(patient);
  const provider = buildProviderOrganization(config);
  const insurer = buildInsurerOrganization(insurance);
  const coverage = buildCoverage(fhirPatient, insurer, insurance);

  const eligibilityRequest: any = {
    resourceType: 'CoverageEligibilityRequest',
    id: uuidv4(),
    meta: { profile: ['https://nrces.in/ndhm/fhir/r4/StructureDefinition/CoverageEligibilityRequest'] },
    status: 'active',
    purpose: ['validation', 'benefits'],
    patient: { reference: `Patient/${fhirPatient.id}` },
    created: new Date().toISOString(),
    provider: { reference: `Organization/${provider.id}` },
    insurer: { reference: `Organization/${insurer.id}` },
    insurance: [{ coverage: { reference: `Coverage/${coverage.id}` } }],
  };

  const bundle = {
    resourceType: 'Bundle',
    id: uuidv4(),
    meta: { lastUpdated: new Date().toISOString(), profile: ['https://nrces.in/ndhm/fhir/r4/StructureDefinition/CoverageEligibilityRequestBundle'] },
    identifier: { system: 'https://hospital.example.com/bundle', value: uuidv4() },
    type: 'collection',
    timestamp: new Date().toISOString(),
    entry: [
      { fullUrl: `CoverageEligibilityRequest/${eligibilityRequest.id}`, resource: eligibilityRequest },
      { fullUrl: `Patient/${fhirPatient.id}`, resource: fhirPatient },
      { fullUrl: `Organization/${provider.id}`, resource: provider },
      { fullUrl: `Organization/${insurer.id}`, resource: insurer },
      { fullUrl: `Coverage/${coverage.id}`, resource: coverage },
    ],
  };

  return { bundle, recipientCode: insurance.tpaNhcxCode || insurance.insurerNhcxCode || '' };
}

/** Generate Claim Bundle (PreAuth or Final Claim) */
export function buildClaimBundle(
  config: NHCXConfig, patient: PatientData, insurance: InsuranceData, claim: ClaimData
): { bundle: any; recipientCode: string } {
  const fhirPatient = buildPatient(patient);
  const provider = buildProviderOrganization(config);
  const insurer = buildInsurerOrganization(insurance);
  const coverage = buildCoverage(fhirPatient, insurer, insurance);

  // Build Claim resource
  const claimResource: any = {
    resourceType: 'Claim',
    id: uuidv4(),
    meta: { profile: ['https://nrces.in/ndhm/fhir/r4/StructureDefinition/Claim'] },
    status: 'active',
    type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claim-type', code: 'institutional' }] },
    use: claim.claimType,
    patient: { reference: `Patient/${fhirPatient.id}` },
    created: new Date().toISOString(),
    provider: { reference: `Organization/${provider.id}` },
    insurer: { reference: `Organization/${insurer.id}` },
    priority: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/processpriority', code: 'normal' }] },
    insurance: [{ sequence: 1, focal: true, coverage: { reference: `Coverage/${coverage.id}` } }],
    diagnosis: claim.diagnosisCodes.map((dx, i) => ({
      sequence: i + 1,
      diagnosisCodeableConcept: { coding: [{ system: dx.system || 'http://hl7.org/fhir/sid/icd-10', code: dx.code, display: dx.display }] },
      type: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/ex-diagnosistype', code: i === 0 ? 'admitting' : 'clinical' }] }],
    })),
    item: claim.billItems.map((item, i) => ({
      sequence: i + 1,
      productOrService: { coding: [{ system: 'https://hospital.example.com/tariff', code: `ITEM-${i + 1}`, display: item.description }] },
      quantity: { value: item.quantity },
      unitPrice: { value: item.unitPrice, currency: 'INR' },
      net: { value: item.totalAmount, currency: 'INR' },
      ...(item.category ? { category: { coding: [{ system: 'https://hospital.example.com/category', code: item.category }] } } : {}),
    })),
    total: { value: claim.totalAmount, currency: 'INR' },
  };

  // Add procedure codes
  if (claim.procedureCodes?.length) {
    claimResource.procedure = claim.procedureCodes.map((proc, i) => ({
      sequence: i + 1,
      procedureCodeableConcept: { coding: [{ system: proc.system || 'http://hl7.org/fhir/sid/icd-10-pcs', code: proc.code, display: proc.display }] },
    }));
  }

  // Add billable period
  if (claim.admissionDate) {
    claimResource.billablePeriod = { start: claim.admissionDate, ...(claim.dischargeDate ? { end: claim.dischargeDate } : {}) };
  }

  // Add supporting documents
  const supportingInfoEntries: any[] = [];
  if (claim.supportingDocuments?.length) {
    claim.supportingDocuments.forEach((doc, i) => {
      claimResource.supportingInfo = claimResource.supportingInfo || [];
      claimResource.supportingInfo.push({
        sequence: i + 1,
        category: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claiminformationcategory', code: 'info' }] },
        valueAttachment: { contentType: doc.contentType, data: doc.data, title: doc.type },
      });
    });
  }

  // Add care team (doctor)
  if (claim.doctorName) {
    const practitioner: any = {
      resourceType: 'Practitioner',
      id: uuidv4(),
      name: [{ text: claim.doctorName }],
    };
    if (claim.doctorRegistrationNo) {
      practitioner.identifier = [{ system: 'https://doctor.ndhm.gov.in', value: claim.doctorRegistrationNo }];
    }
    claimResource.careTeam = [{ sequence: 1, provider: { reference: `Practitioner/${practitioner.id}` }, role: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/claimcareteamrole', code: 'primary' }] } }];
    supportingInfoEntries.push({ fullUrl: `Practitioner/${practitioner.id}`, resource: practitioner });
  }

  const bundle = {
    resourceType: 'Bundle',
    id: uuidv4(),
    meta: { lastUpdated: new Date().toISOString(), profile: ['https://nrces.in/ndhm/fhir/r4/StructureDefinition/ClaimRequestBundle'] },
    identifier: { system: 'https://hospital.example.com/bundle', value: uuidv4() },
    type: 'collection',
    timestamp: new Date().toISOString(),
    entry: [
      { fullUrl: `Claim/${claimResource.id}`, resource: claimResource },
      { fullUrl: `Patient/${fhirPatient.id}`, resource: fhirPatient },
      { fullUrl: `Organization/${provider.id}`, resource: provider },
      { fullUrl: `Organization/${insurer.id}`, resource: insurer },
      { fullUrl: `Coverage/${coverage.id}`, resource: coverage },
      ...supportingInfoEntries,
    ],
  };

  return { bundle, recipientCode: insurance.tpaNhcxCode || insurance.insurerNhcxCode || '' };
}

/** Parse ClaimResponse from NHCX callback */
export function parseClaimResponse(bundle: any): {
  status: string; disposition: string; approvedAmount?: number;
  adjudicationItems?: { description: string; claimedAmount: number; approvedAmount: number; reason?: string }[];
} {
  const claimResponse = bundle?.entry?.find((e: any) => e.resource?.resourceType === 'ClaimResponse')?.resource;
  if (!claimResponse) return { status: 'unknown', disposition: 'Unable to parse response' };

  const adjItems = (claimResponse.item || []).map((item: any) => {
    const adj = item.adjudication || [];
    return {
      description: item.itemSequence,
      claimedAmount: adj.find((a: any) => a.category?.coding?.[0]?.code === 'submitted')?.amount?.value || 0,
      approvedAmount: adj.find((a: any) => a.category?.coding?.[0]?.code === 'benefit')?.amount?.value || 0,
      reason: adj.find((a: any) => a.reason)?.reason?.text,
    };
  });

  return {
    status: claimResponse.outcome || claimResponse.status,
    disposition: claimResponse.disposition || '',
    approvedAmount: claimResponse.total?.find((t: any) => t.category?.coding?.[0]?.code === 'benefit')?.amount?.value,
    adjudicationItems: adjItems,
  };
}

/** Parse CoverageEligibilityResponse */
export function parseCoverageEligibilityResponse(bundle: any): {
  eligible: boolean; inforce: boolean; benefits?: { type: string; allowed: number; used: number }[];
} {
  const response = bundle?.entry?.find((e: any) => e.resource?.resourceType === 'CoverageEligibilityResponse')?.resource;
  if (!response) return { eligible: false, inforce: false };

  const insurance = response.insurance?.[0];
  const benefits = (insurance?.item || []).flatMap((item: any) =>
    (item.benefit || []).map((b: any) => ({
      type: b.type?.coding?.[0]?.display || b.type?.text || 'Benefit',
      allowed: b.allowedMoney?.value || b.allowedUnsignedInt || 0,
      used: b.usedMoney?.value || b.usedUnsignedInt || 0,
    }))
  );

  return { eligible: response.outcome === 'complete', inforce: insurance?.inforce || false, benefits };
}
