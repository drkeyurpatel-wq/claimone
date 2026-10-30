// ClaimOne — shared types (status model from H1 Claims, rules from ClaimOne)

export type ClaimStatus =
  | 'draft'
  | 'preauth_pending' | 'preauth_approved' | 'preauth_query' | 'preauth_rejected' | 'preauth_enhanced'
  | 'claim_submitted' | 'claim_under_review' | 'claim_query'
  | 'claim_approved' | 'claim_partial' | 'claim_rejected'
  | 'settlement_pending' | 'settled' | 'closed' | 'written_off';

export type ClaimType = 'cashless' | 'reimbursement' | 'pmjay' | 'cghs' | 'echs' | 'state_scheme' | 'corporate';
export type Priority = 'low' | 'medium' | 'high' | 'critical';
export type QueryCategory = 'clinical' | 'billing' | 'documentation' | 'policy' | 'other';
export type Role = 'admin' | 'manager' | 'desk' | 'viewer' | 'bot';

export interface Payer {
  id: string;
  tenant_id: string | null;
  code: string;
  name: string;
  type: 'tpa' | 'insurer' | 'government' | 'psu' | 'corporate';
  portal_url: string | null;
  is_nhcx_live: boolean;
  nhcx_code?: string | null;
  channel?: PayerChannel;
  query_tat_hours: number;
  is_active: boolean;
}

export interface Claim {
  id: string;
  tenant_id: string;
  centre_id: string;
  payer_id: string;
  claim_number: string;
  claim_type: ClaimType;
  status: ClaimStatus;
  priority: Priority;
  patient_name: string;
  patient_phone: string | null;
  patient_uhid: string | null;
  abha_id: string | null;
  admission_ref: string | null;
  policy_number: string | null;
  policy_holder_name: string | null;
  primary_diagnosis: string | null;
  icd_code: string | null;
  procedure_name: string | null;
  package_code: string | null;
  package_name: string | null;
  package_amount: number | null;
  treating_doctor_name: string | null;
  department_name: string | null;
  admission_date: string | null;
  discharge_date: string | null;
  estimated_amount: number | null;
  claimed_amount: number | null;
  approved_amount: number | null;
  settled_amount: number | null;
  tds_amount: number | null;
  deduction_amount: number | null;
  patient_payable: number | null;
  tpa_claim_number: string | null;
  tpa_preauth_number: string | null;
  settlement_utr: string | null;
  settlement_date: string | null;
  preauth_submitted_at: string | null;
  submitted_at: string | null;
  assigned_to: string | null;
  query_count: number;
  is_query_pending: boolean;
  medpay_synced: boolean;
  notes: string | null;
  tags: string[] | null;
  created_at: string;
  updated_at: string;
  // admission facts from the HMIS (0013)
  case_source?: 'manual' | 'ecw' | 'hmis';
  admitted_at?: string | null;
  intimated_at?: string | null;
  discharged_at?: string | null;
  bill_no?: string | null;
  bill_amount?: number | null;
  discount_amount?: number | null;
  patient_paid?: number | null;
  bed_category?: string | null;
  sponsor_name?: string | null;
  status_changed_at?: string | null;
  /** Accept / Fight on the insurer's cut (0019). */
  cut_decision?: 'accepted' | 'fought' | null;
  cut_note?: string | null;
  cut_decided_at?: string | null;
  /** The pre-auth approval, kept apart from the claim approval (0020). */
  preauth_approved_amount?: number | null;
  /** When the last payer query was answered (0023); the follow-up runs from here. */
  query_replied_at?: string | null;
  /** Dispute letters sent (0023): 1 reconsideration, 2 escalation to the insurer, 3 patient grievance. */
  dispute_level?: number | null;
  dispute_sent_at?: string | null;
  // NHCX case details (0014)
  patient_gender?: 'male' | 'female' | 'other' | 'unknown' | null;
  patient_age_years?: number | null;
  member_id?: string | null;
  treating_doctor_hpr_id?: string | null;
  treatment_type?: 'medical' | 'surgical' | null;
  clm_payers?: (Pick<Payer, 'id' | 'code' | 'name' | 'type'> & Partial<Pick<Payer, 'channel' | 'is_nhcx_live' | 'nhcx_code'>>) | null;
}

/** How a payer is reached when it is not live on NHCX. */
export type PayerChannel = 'portal' | 'email' | 'tms' | 'direct';
export type Workspace = 'admission' | 'claims' | 'payments';

export interface ClaimDocument {
  id: string;
  claim_id: string;
  doc_code: string | null;
  document_name: string;
  document_category: 'clinical' | 'billing' | 'identity' | 'insurance' | 'correspondence' | 'other';
  file_path: string | null;
  /** Ticked as attached on the insurer website — no file kept. */
  attested?: boolean;
  file_size_bytes: number | null;
  mime_type: string | null;
  source: 'manual' | 'bot' | 'nhcx' | 'hmis';
  status: 'uploaded' | 'valid' | 'invalid';
  review_note: string | null;
  verified_at: string | null;
  created_at: string;
}

export interface ClaimQuery {
  id: string;
  claim_id: string;
  query_number: number;
  query_text: string;
  query_category: QueryCategory;
  priority: Priority;
  source: string;
  raised_by: string | null;
  raised_at: string;
  routed_to_role: string | null;
  response_text: string | null;
  responded_at: string | null;
  sla_deadline: string;
  escalation_level: number;
  status: 'open' | 'in_progress' | 'escalated' | 'responded' | 'closed';
}

export interface OpenQuery extends ClaimQuery {
  claim_number: string;
  patient_name: string;
  centre_id: string;
  payer_name: string;
  is_sla_breached: boolean;
  hours_left: number;
}

export interface DocRuleRow {
  id: string;
  tenant_id: string | null;
  payer_id: string | null;
  claim_type: ClaimType | null;
  stage: 'preauth' | 'final' | 'reimbursement';
  doc_code: string;
  doc_label: string;
  is_mandatory: boolean;
  min_amount: number | null;
  sort_order: number;
}

export interface TimelineEvent {
  claim_id: string;
  event_type: string;
  event_text: string;
  source: string;
  notes: string | null;
  created_at: string;
  /** Who did it (0023); null for uploads, the bot and the system. */
  actor_name?: string | null;
}

export interface AgingRow {
  centre_id: string;
  centre_code: string;
  payer_id: string;
  payer_name: string;
  aging_bucket: '0-30' | '31-60' | '61-90' | '91-180' | '180+';
  claim_count: number;
  total_amount: number;
}

export interface PayerScorecard {
  payer_id: string;
  payer_name: string;
  payer_type: string;
  total_claims: number;
  settled_count: number;
  rejected_count: number;
  pending_queries: number;
  avg_settlement_days: number | null;
  rejection_rate_pct: number | null;
  total_claimed: number | null;
  total_approved: number | null;
  total_settled: number | null;
  total_deductions: number | null;
  deduction_pct: number | null;
}

export interface LeakageRow {
  centre_id: string;
  payer_id: string;
  payer_name: string;
  doctor_name: string;
  kind: 'deduction' | 'rejection' | 'fighting';
  category: string;
  is_preventable: boolean;
  month: string;
  items: number;
  amount: number;
}

export interface BotRun {
  id: string;
  payer_id: string | null;
  action: 'submit_preauth' | 'submit_claim' | 'check_status' | 'download_letter';
  claim_id: string | null;
  status: 'running' | 'success' | 'partial' | 'failed' | 'timeout' | 'captcha_blocked' | 'skipped';
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  steps_completed: number;
  total_steps: number;
  error_message: string | null;
  claims_processed: number;
  claims_updated: number;
}

// ─── Display helpers ───

export const STATUS_CONFIG: Record<ClaimStatus, { label: string; color: string; bg: string }> = {
  draft: { label: 'Draft', color: 'text-slate-600', bg: 'bg-slate-100' },
  preauth_pending: { label: 'Pre-auth pending', color: 'text-amber-700', bg: 'bg-amber-50' },
  preauth_approved: { label: 'Pre-auth approved', color: 'text-green-700', bg: 'bg-green-50' },
  preauth_query: { label: 'Pre-auth query', color: 'text-orange-700', bg: 'bg-orange-50' },
  preauth_rejected: { label: 'Pre-auth rejected', color: 'text-red-700', bg: 'bg-red-50' },
  preauth_enhanced: { label: 'Enhancement approved', color: 'text-blue-700', bg: 'bg-blue-50' },
  claim_submitted: { label: 'Claim submitted', color: 'text-blue-700', bg: 'bg-blue-50' },
  claim_under_review: { label: 'Under review', color: 'text-amber-700', bg: 'bg-amber-50' },
  claim_query: { label: 'Claim query', color: 'text-orange-700', bg: 'bg-orange-50' },
  claim_approved: { label: 'Approved', color: 'text-green-700', bg: 'bg-green-50' },
  claim_partial: { label: 'Part approved', color: 'text-yellow-700', bg: 'bg-yellow-50' },
  claim_rejected: { label: 'Rejected', color: 'text-red-700', bg: 'bg-red-50' },
  settlement_pending: { label: 'Awaiting payment', color: 'text-purple-700', bg: 'bg-purple-50' },
  settled: { label: 'Settled', color: 'text-emerald-700', bg: 'bg-emerald-50' },
  closed: { label: 'Closed', color: 'text-slate-700', bg: 'bg-slate-100' },
  written_off: { label: 'Written off', color: 'text-red-800', bg: 'bg-red-100' },
};

export const CLAIM_TYPE_LABELS: Record<ClaimType, string> = {
  cashless: 'Cashless',
  reimbursement: 'Reimbursement',
  pmjay: 'PMJAY / MA',
  cghs: 'CGHS',
  echs: 'ECHS',
  state_scheme: 'State scheme',
  corporate: 'Corporate',
};

export const PRIORITY_CONFIG: Record<Priority, { label: string; color: string; bg: string }> = {
  low: { label: 'Low', color: 'text-slate-600', bg: 'bg-slate-100' },
  medium: { label: 'Medium', color: 'text-blue-600', bg: 'bg-blue-50' },
  high: { label: 'High', color: 'text-orange-600', bg: 'bg-orange-50' },
  critical: { label: 'Critical', color: 'text-red-600', bg: 'bg-red-50' },
};
