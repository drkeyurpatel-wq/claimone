/**
 * ClaimOne — document validation engine (from ClaimOne, Aug 2026)
 *
 * Pure function: no I/O, no clock. The same code drives the readiness
 * meter in the browser and the pre-check in the API route.
 *
 * The database trigger (clm_unmet_mandatory_docs in 0001_core.sql) is the
 * final authority and MUST implement the same rules:
 *   - stage, tenant, payer, claim type and amount filter the rules
 *   - most specific rule per doc code wins:
 *       (tenant+payer 4 | tenant 3 | payer 2 | global 1) × 2 + (claim type ? 1 : 0)
 *   - equal specificity → the mandatory rule wins
 *   - only 'valid' satisfies a rule; 'uploaded' does not
 */

import type { ClaimType } from '@/lib/claims/types';

export type Stage = 'preauth' | 'final' | 'reimbursement';
export type DocStatus = 'missing' | 'uploaded' | 'valid' | 'invalid';

export interface DocumentRule {
  tenantId: string | null;
  payerId: string | null;
  claimType: ClaimType | null;
  stage: Stage;
  docCode: string;
  docLabel: string;
  isMandatory: boolean;
  minAmount: number | null;
}

export interface ClaimForValidation {
  tenantId: string;
  payerId: string;
  claimType: ClaimType;
  stage: Stage;
  amount: number;
  documents: Record<string, DocStatus>;
}

export interface RuleCheck {
  docCode: string;
  docLabel: string;
  status: DocStatus;
  isMandatory: boolean;
  passed: boolean;
  /** Shown to staff so they trust the block. */
  appliedBecause: string;
}

export interface ValidationResult {
  canSubmit: boolean;
  readinessPct: number;
  checks: RuleCheck[];
  blockers: RuleCheck[];
  warnings: RuleCheck[];
}

const SATISFIED: DocStatus = 'valid';

export function specificity(r: Pick<DocumentRule, 'tenantId' | 'payerId' | 'claimType'>): number {
  const base = r.tenantId && r.payerId ? 4 : r.tenantId ? 3 : r.payerId ? 2 : 1;
  return base * 2 + (r.claimType ? 1 : 0);
}

export function resolveRules(
  rules: DocumentRule[],
  claim: Pick<ClaimForValidation, 'tenantId' | 'payerId' | 'claimType' | 'stage' | 'amount'>,
): DocumentRule[] {
  const applicable = rules.filter((r) => {
    if (r.stage !== claim.stage) return false;
    if (r.tenantId !== null && r.tenantId !== claim.tenantId) return false;
    if (r.payerId !== null && r.payerId !== claim.payerId) return false;
    if (r.claimType !== null && r.claimType !== claim.claimType) return false;
    if (r.minAmount !== null && claim.amount < r.minAmount) return false;
    return true;
  });

  const best = new Map<string, DocumentRule>();
  for (const rule of applicable) {
    const existing = best.get(rule.docCode);
    if (!existing) { best.set(rule.docCode, rule); continue; }
    const a = specificity(rule), b = specificity(existing);
    if (a > b || (a === b && rule.isMandatory && !existing.isMandatory)) best.set(rule.docCode, rule);
  }
  return [...best.values()].sort((a, b) => a.docLabel.localeCompare(b.docLabel));
}

function explain(rule: DocumentRule): string {
  if (rule.minAmount !== null) {
    return `Required on claims of ₹${rule.minAmount.toLocaleString('en-IN')} or more`;
  }
  if (rule.tenantId && rule.payerId) return 'Your hospital rule for this payer';
  if (rule.tenantId) return 'Your hospital rule';
  if (rule.payerId) return 'Payer requirement';
  if (rule.claimType) return 'Scheme requirement';
  return 'Standard requirement';
}

export function validateClaim(claim: ClaimForValidation, rules: DocumentRule[]): ValidationResult {
  const checks: RuleCheck[] = resolveRules(rules, claim).map((rule) => {
    const status = claim.documents[rule.docCode] ?? 'missing';
    return {
      docCode: rule.docCode,
      docLabel: rule.docLabel,
      status,
      isMandatory: rule.isMandatory,
      passed: status === SATISFIED,
      appliedBecause: explain(rule),
    };
  });

  const blockers = checks.filter((c) => c.isMandatory && !c.passed);
  const warnings = checks.filter((c) => !c.isMandatory && !c.passed);
  const readinessPct = checks.length === 0
    ? 100
    : Math.round((checks.filter((c) => c.passed).length / checks.length) * 100);

  return { canSubmit: blockers.length === 0, readinessPct, checks, blockers, warnings };
}

/**
 * Collapse uploaded files into one status per doc code.
 * Any valid copy satisfies the rule; otherwise an unreviewed upload beats a rejected one.
 */
export function docStatusByCode(docs: { doc_code: string | null; status: 'uploaded' | 'valid' | 'invalid' }[]): Record<string, DocStatus> {
  const rank: Record<DocStatus, number> = { missing: 0, invalid: 1, uploaded: 2, valid: 3 };
  const out: Record<string, DocStatus> = {};
  for (const d of docs) {
    if (!d.doc_code) continue;
    const cur = out[d.doc_code] ?? 'missing';
    if (rank[d.status] > rank[cur]) out[d.doc_code] = d.status;
  }
  return out;
}

/** The stage a target status submits for, or null if it is not a submission. */
export function submissionStage(toStatus: string, claimType: ClaimType): Stage | null {
  if (toStatus === 'preauth_pending') return 'preauth';
  if (toStatus === 'claim_submitted') return claimType === 'reimbursement' ? 'reimbursement' : 'final';
  return null;
}

/** The amount thresholds are compared against, per stage (mirrors the SQL). */
export function stageAmount(stage: Stage, c: { estimated_amount: number | null; claimed_amount: number | null }): number {
  return stage === 'preauth' ? (c.estimated_amount ?? 0) : (c.claimed_amount ?? c.estimated_amount ?? 0);
}

/** Which submission a claim is heading to next (mirrors clm_v_readiness). */
export function nextStage(status: string, claimType: ClaimType): Stage | null {
  if (claimType === 'reimbursement' && ['draft', 'claim_query', 'claim_rejected'].includes(status)) return 'reimbursement';
  if (['draft', 'preauth_query', 'preauth_rejected', 'preauth_pending'].includes(status)) return 'preauth';
  if (['preauth_approved', 'preauth_enhanced', 'claim_query', 'claim_rejected', 'claim_submitted', 'claim_under_review'].includes(status)) return 'final';
  return null;
}

/** Turn database rule rows into engine rules. */
export function toRules(rows: { tenant_id: string | null; payer_id: string | null; claim_type: ClaimType | null; stage: Stage; doc_code: string; doc_label: string; is_mandatory: boolean; min_amount: number | null }[]): DocumentRule[] {
  return rows.map((r) => ({
    tenantId: r.tenant_id, payerId: r.payer_id, claimType: r.claim_type, stage: r.stage,
    docCode: r.doc_code, docLabel: r.doc_label, isMandatory: r.is_mandatory,
    minAmount: r.min_amount == null ? null : Number(r.min_amount),
  }));
}
