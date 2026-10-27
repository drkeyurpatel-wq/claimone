// The 16 original ClaimOne tests, ported to the merged model (stage + claim type),
// plus tests for the parts added in the merge.
import { describe, test, expect } from 'vitest';
import {
  validateClaim, resolveRules, docStatusByCode, submissionStage, stageAmount, specificity,
  type DocumentRule, type ClaimForValidation,
} from './validation';

const TENANT = 'tenant-health1';
const OTHER_TENANT = 'tenant-other';
const PAYER = 'payer-bajaj';
const OTHER_PAYER = 'payer-star';

const rule = (o: Partial<DocumentRule>): DocumentRule => ({
  tenantId: null, payerId: null, claimType: null, stage: 'final',
  docCode: 'discharge_summary', docLabel: 'Signed discharge summary',
  isMandatory: true, minAmount: null, ...o,
});

const claim = (o: Partial<ClaimForValidation> = {}): ClaimForValidation => ({
  tenantId: TENANT, payerId: PAYER, claimType: 'cashless', stage: 'final',
  amount: 100000, documents: {}, ...o,
});

describe('submission gate (original ClaimOne)', () => {
  test('blocks submission when a mandatory document is missing', () => {
    const r = validateClaim(claim(), [rule({})]);
    expect(r.canSubmit).toBe(false);
    expect(r.blockers).toHaveLength(1);
    expect(r.readinessPct).toBe(0);
  });

  test('allows submission when every mandatory document is valid', () => {
    const r = validateClaim(claim({ documents: { discharge_summary: 'valid' } }), [rule({})]);
    expect(r.canSubmit).toBe(true);
    expect(r.readinessPct).toBe(100);
  });

  test('uploaded-but-unverified does NOT satisfy a rule', () => {
    const r = validateClaim(claim({ documents: { discharge_summary: 'uploaded' } }), [rule({})]);
    expect(r.canSubmit).toBe(false);
  });

  test('invalid document blocks submission', () => {
    const r = validateClaim(claim({ documents: { discharge_summary: 'invalid' } }), [rule({})]);
    expect(r.canSubmit).toBe(false);
  });

  test('non-mandatory gaps warn but never block', () => {
    const rules = [
      rule({ docCode: 'discharge_summary', isMandatory: true }),
      rule({ docCode: 'nutrition_note', docLabel: 'Nutrition note', isMandatory: false }),
    ];
    expect(validateClaim(claim(), rules).blockers).toHaveLength(1);
    const ok = validateClaim(claim({ documents: { discharge_summary: 'valid' } }), rules);
    expect(ok.canSubmit).toBe(true);
    expect(ok.warnings).toHaveLength(1);
  });

  test('amount-gated rule does not apply below threshold', () => {
    const r = validateClaim(claim({ amount: 49999 }),
      [rule({ docCode: 'implant_invoice', docLabel: 'Implant invoice', minAmount: 50000 })]);
    expect(r.canSubmit).toBe(true);
    expect(r.checks).toHaveLength(0);
    expect(r.readinessPct).toBe(100);
  });

  test('amount-gated rule applies exactly at the threshold', () => {
    const r = validateClaim(claim({ amount: 50000 }),
      [rule({ docCode: 'implant_invoice', docLabel: 'Implant invoice', minAmount: 50000 })]);
    expect(r.canSubmit).toBe(false);
    expect(r.blockers[0].appliedBecause).toMatch(/50,000/);
  });

  test("another hospital's rule never applies to this claim", () => {
    const r = validateClaim(claim(), [rule({ tenantId: OTHER_TENANT, docCode: 'extra_form', docLabel: 'Extra form' })]);
    expect(r.checks).toHaveLength(0);
    expect(r.canSubmit).toBe(true);
  });

  test("another payer's rule never applies to this claim", () => {
    const r = validateClaim(claim(), [rule({ payerId: OTHER_PAYER, docCode: 'star_annexure', docLabel: 'Star annexure' })]);
    expect(r.checks).toHaveLength(0);
  });

  test('rules for a different stage are ignored', () => {
    const r = validateClaim(claim({ stage: 'reimbursement' }), [rule({ stage: 'final' })]);
    expect(r.checks).toHaveLength(0);
  });

  test('tenant+payer rule overrides the global default for the same doc', () => {
    const resolved = resolveRules([
      rule({ docCode: 'icp', docLabel: 'Indoor case papers', isMandatory: true }),
      rule({ docCode: 'icp', docLabel: 'Indoor case papers', isMandatory: false, tenantId: TENANT, payerId: PAYER }),
    ], claim());
    expect(resolved).toHaveLength(1);
    expect(resolved[0].isMandatory).toBe(false);
  });

  test('tenant rule outranks payer rule outranks global', () => {
    const resolved = resolveRules([
      rule({ docCode: 'x', docLabel: 'global' }),
      rule({ docCode: 'x', docLabel: 'payer', payerId: PAYER }),
      rule({ docCode: 'x', docLabel: 'tenant', tenantId: TENANT }),
    ], claim());
    expect(resolved).toHaveLength(1);
    expect(resolved[0].docLabel).toBe('tenant');
  });

  test('empty rule set is submittable, not a division by zero', () => {
    const r = validateClaim(claim(), []);
    expect(r.canSubmit).toBe(true);
    expect(r.readinessPct).toBe(100);
  });

  test('unknown document codes on the claim are ignored, not counted', () => {
    const r = validateClaim(claim({ documents: { discharge_summary: 'valid', random_scan: 'valid' } }), [rule({})]);
    expect(r.checks).toHaveLength(1);
    expect(r.readinessPct).toBe(100);
  });

  test('readiness is a whole percentage between 0 and 100', () => {
    const r = validateClaim(claim({ documents: { a: 'valid', b: 'valid' } }), [
      rule({ docCode: 'a', docLabel: 'A' }), rule({ docCode: 'b', docLabel: 'B' }), rule({ docCode: 'c', docLabel: 'C' }),
    ]);
    expect(r.readinessPct).toBe(67);
  });

  test('does not mutate the rules array passed in', () => {
    const rules = [rule({ docCode: 'b', docLabel: 'B' }), rule({ docCode: 'a', docLabel: 'A' })];
    const snapshot = rules.map((x) => x.docCode).join(',');
    validateClaim(claim(), rules);
    expect(rules.map((x) => x.docCode).join(',')).toBe(snapshot);
  });
});

describe('merge additions', () => {
  test('scheme rule (PMJAY) applies only to that claim type', () => {
    const rules = [rule({ claimType: 'pmjay', docCode: 'pmjay_card', docLabel: 'PMJAY card' })];
    expect(validateClaim(claim({ claimType: 'pmjay' }), rules).canSubmit).toBe(false);
    expect(validateClaim(claim({ claimType: 'cashless' }), rules).checks).toHaveLength(0);
  });

  test('claim-type rule beats a plain rule at the same level, but not a hospital rule', () => {
    expect(specificity({ tenantId: null, payerId: null, claimType: 'pmjay' }))
      .toBeGreaterThan(specificity({ tenantId: null, payerId: null, claimType: null }));
    expect(specificity({ tenantId: TENANT, payerId: null, claimType: null }))
      .toBeGreaterThan(specificity({ tenantId: null, payerId: PAYER, claimType: 'pmjay' }));
  });

  test('on a tie the mandatory rule wins, whatever the order (matches SQL)', () => {
    const a = rule({ docCode: 'x', docLabel: 'X', isMandatory: false, payerId: PAYER });
    const b = rule({ docCode: 'x', docLabel: 'X', isMandatory: true, payerId: PAYER });
    expect(resolveRules([a, b], claim())[0].isMandatory).toBe(true);
    expect(resolveRules([b, a], claim())[0].isMandatory).toBe(true);
  });

  test('docStatusByCode: any valid copy wins; unreviewed beats rejected', () => {
    const s = docStatusByCode([
      { doc_code: 'a', status: 'invalid' }, { doc_code: 'a', status: 'valid' },
      { doc_code: 'b', status: 'invalid' }, { doc_code: 'b', status: 'uploaded' },
      { doc_code: null, status: 'valid' },
    ]);
    expect(s).toEqual({ a: 'valid', b: 'uploaded' });
  });

  test('submission stage follows target status and claim type', () => {
    expect(submissionStage('preauth_pending', 'cashless')).toBe('preauth');
    expect(submissionStage('claim_submitted', 'cashless')).toBe('final');
    expect(submissionStage('claim_submitted', 'reimbursement')).toBe('reimbursement');
    expect(submissionStage('claim_approved', 'cashless')).toBeNull();
  });

  test('pre-auth thresholds use the estimate; final uses the claimed amount', () => {
    const c = { estimated_amount: 40000, claimed_amount: 60000 };
    expect(stageAmount('preauth', c)).toBe(40000);
    expect(stageAmount('final', c)).toBe(60000);
    expect(stageAmount('final', { estimated_amount: 40000, claimed_amount: null })).toBe(40000);
  });
});

describe('next stage', async () => {
  const { nextStage } = await import('./validation');
  test('draft cashless goes to pre-auth; draft reimbursement goes straight to reimbursement', () => {
    expect(nextStage('draft', 'cashless')).toBe('preauth');
    expect(nextStage('draft', 'reimbursement')).toBe('reimbursement');
  });
  test('after pre-auth approval the final claim is next; settled claims have no next stage', () => {
    expect(nextStage('preauth_approved', 'pmjay')).toBe('final');
    expect(nextStage('settled', 'cashless')).toBeNull();
  });
});
