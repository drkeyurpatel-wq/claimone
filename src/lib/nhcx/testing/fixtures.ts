// Test fixtures: a synthetic patient and case. The identifying values are made up
// and deliberately distinctive so the PHI-leak test can search for them.

import type { ClaimInput, CoverageInput, EnhancementInput, PatientInput, PreauthInput, ProviderInput } from '../types';

export const PHI = {
  name: 'Savitaben Zalavadia',
  mobile: '9824012345',
  abhaHyphenated: '91-7654-3210-9876',
  abhaDigits: '91765432109876',
  abhaAddress: 'savita.zalavadia@abdm',
  uhid: 'H1SHL-0099871',
} as const;

export const PROVIDER_CODE = '1000004446@hcx';
export const PAYER_CODE = '1000003538@hcx';

export const provider: ProviderInput = { hfrId: 'IN2410000123', name: 'Health1 Super Speciality Hospital, Shilaj', participantCode: PROVIDER_CODE };

export const patient: PatientInput = {
  uhid: PHI.uhid,
  name: PHI.name,
  gender: 'female',
  birthDate: '1968-03-14',
  mobile: PHI.mobile,
  abhaNumber: PHI.abhaDigits,
  abhaAddress: PHI.abhaAddress,
};

export const coverage: CoverageInput = {
  payerCode: PAYER_CODE,
  payerName: 'Sandbox Payer',
  policyNumber: 'POL-2026-778812',
  memberId: 'MEM-55120931',
  sumInsured: 500000,
  productCode: 'FAMILY-FLOATER-GOLD',
};

const tinyPdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF').toString('base64');

export function preauthInput(overrides: Partial<PreauthInput> = {}): PreauthInput {
  return {
    caseNumber: 'H1-PA-2026-000412',
    provider,
    patient,
    coverage,
    encounter: { admissionDate: '2026-10-20T09:30:00+05:30', dischargeDate: '2026-10-25T11:00:00+05:30' },
    diagnoses: [
      { icd10Code: 'I63.9', display: 'Cerebral infarction, unspecified', onAdmission: true, snomed: { code: '432504007', display: 'Cerebral infarction' } },
      { icd10Code: 'E11.9', display: 'Type 2 diabetes mellitus without complications' },
    ],
    procedures: [{ code: 'NS-MT-01', display: 'Mechanical thrombectomy', procedureType: 'surgical', date: '2026-10-20T11:00:00+05:30' }],
    items: [
      { code: 'NS-MT-01', display: 'Mechanical thrombectomy package', categoryCode: 'NS', categoryDisplay: 'Neuro Surgery', quantity: 1, unitPrice: 285000 },
      { code: 'ICU-DAY', display: 'ICU stay per day', categoryCode: 'ROOM', categoryDisplay: 'Room and boarding', quantity: 3, unitPrice: 12500, amount: 37500, procedureIndexes: [] },
    ],
    practitioners: [
      { name: 'Dr. A. Mehta', hprId: '71-8422-5818-7201', qualification: { code: 'MD', display: 'Doctor of Medicine' } },
      { name: 'Dr. R. Shah', hprId: '71-1111-2222-3333' },
    ],
    documents: [
      { code: 'MAND0408', display: 'Clinical notes and admission notes', contentType: 'application/pdf', title: 'Admission notes', dataBase64: tinyPdf },
      { code: 'RAD', display: 'Radiology reports', contentType: 'image/jpeg', title: 'CT brain', dataBase64: Buffer.from([0xff, 0xd8, 0xff, 0xe0]).toString('base64') },
    ],
    timestamp: new Date('2026-10-20T04:00:00Z'),
    ...overrides,
  };
}

export function enhancementInput(preAuthRef: string): EnhancementInput {
  const base = preauthInput();
  return {
    ...base,
    preAuthRef,
    items: [
      ...base.items,
      { code: 'ICU-DAY-EXT', display: 'ICU stay extension per day', categoryCode: 'ROOM', categoryDisplay: 'Room and boarding', quantity: 2, unitPrice: 12500, procedureIndexes: [] },
    ],
  };
}

export function claimInput(preAuthRef: string): ClaimInput {
  const base = preauthInput();
  return {
    ...base,
    preAuthRef,
    encounter: { admissionDate: '2026-10-20T09:30:00+05:30', dischargeDate: '2026-10-26T12:00:00+05:30', dischargeDisposition: 'Discharged to home' },
    items: [
      { code: 'NS-MT-01', display: 'Mechanical thrombectomy package', categoryCode: 'NS', categoryDisplay: 'Neuro Surgery', quantity: 1, unitPrice: 285000 },
      { code: 'ICU-DAY', display: 'ICU stay per day', categoryCode: 'ROOM', categoryDisplay: 'Room and boarding', quantity: 5, unitPrice: 12500, procedureIndexes: [] },
      { code: 'PHARM', display: 'Pharmacy and consumables', categoryCode: 'PHARMACY', categoryDisplay: 'Pharmacy', quantity: 1, unitPrice: 18450.5, procedureIndexes: [] },
    ],
    documents: [
      ...(base.documents ?? []),
      { code: 'MB', display: 'Final bill', categoryCode: 'MB', categoryDisplay: 'Bill', contentType: 'application/pdf', title: 'Final bill', dataBase64: tinyPdf },
      { code: 'MAND0006', display: 'Detailed discharge summary', categoryCode: 'HDS', categoryDisplay: 'Hospital discharge summary', contentType: 'application/pdf', title: 'Discharge summary', dataBase64: tinyPdf },
    ],
  };
}
