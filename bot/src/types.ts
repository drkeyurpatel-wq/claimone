// bot/src/types.ts — Type definitions for the H1 Claims Bot Framework

// ═══ TPA Config Schema ═══

export interface TPAConfig {
  tpa_code: string;           // matches clm_payers.code (payer id is looked up at runtime)
  tpa_name: string;
  /**
   * Date a person last watched every flow work against the live portal.
   * null = never. Write flows (submit_preauth / submit_claim) refuse to run
   * while this is null, so a guessed selector cannot file a wrong pre-auth.
   */
  verified_on: string | null;
  portal: {
    url: string;
    type: 'web' | 'api';
  };
  auth: {
    method: 'form' | 'api_key' | 'oauth';
    login_url: string;
    selectors: {
      username: string;
      password: string;
      submit: string;
      success: string;        // selector that confirms login succeeded
      captcha?: string;
      otp_input?: string;
    };
    captcha: boolean;
    otp: boolean;
    session_cookie_name?: string;
  };
  flows: {
    submit_preauth?: FlowDefinition;
    submit_claim?: FlowDefinition;
    check_status: FlowDefinition;      // required — minimum viable
    download_letter?: FlowDefinition;
    check_preauth_status?: FlowDefinition;
    enhancement?: FlowDefinition;
  };
  status_mapping: Record<string, string>;  // portal status → clm_status enum
  rate_limit: {
    requests_per_minute: number;
    session_timeout_minutes: number;
    max_retries: number;
  };
  // Hospital-specific credentials (loaded from env, NOT stored in config)
  env_prefix: string;  // e.g. 'HDFC' → reads HDFC_USERNAME, HDFC_PASSWORD from env
}

export interface FlowDefinition {
  description: string;
  steps: FlowStep[];
  timeout_seconds?: number;
  retry_on_failure?: boolean;
}

export type FlowStep =
  | { action: 'goto'; url: string }
  | { action: 'wait'; selector: string; timeout?: number }
  | { action: 'fill'; selector: string; value: string }       // value supports {{claim.field}} templates
  | { action: 'select'; selector: string; value: string }
  | { action: 'click'; selector: string }
  | { action: 'upload'; selector: string; files: string }      // files = {{document_paths}}
  | { action: 'download'; selector: string; output: string }   // output = key name for downloaded file
  | { action: 'extract'; selector: string; output: string }    // output = key name for extracted text
  | { action: 'extract_table'; selector: string; output: string; columns: string[] }
  | { action: 'screenshot'; name: string }
  | { action: 'sleep'; ms: number }
  | { action: 'if_visible'; selector: string; then: FlowStep[]; else?: FlowStep[] }
  | { action: 'log'; message: string };

// ═══ Bot Run Types ═══

export type BotAction = 'submit_preauth' | 'submit_claim' | 'check_status' | 'download_letter' | 'poll_all';
export type BotRunStatus = 'running' | 'success' | 'partial' | 'failed' | 'timeout' | 'captcha_blocked' | 'skipped';

export interface BotRunRecord {
  id?: string;
  payer_id: string | null;
  centre_id: string;
  action: Exclude<BotAction, 'poll_all'>;
  claim_id?: string;
  status: BotRunStatus;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
  steps_completed: number;
  total_steps: number;
  error_message?: string;
  screenshot_path?: string;
  portal_response?: Record<string, any>;
  claims_processed: number;
  claims_updated: number;
}

// ═══ Claim Data for Template Resolution ═══

export interface ClaimData {
  id: string;
  claim_number: string;
  status: string;
  patient_name: string;
  patient_phone: string;
  patient_uhid: string;
  abha_id?: string;
  primary_diagnosis: string;
  icd_code?: string;
  procedure_name?: string;
  treating_doctor_name?: string;
  department_name?: string;
  admission_date: string;
  discharge_date?: string;
  estimated_amount: number;
  approved_amount?: number;
  claimed_amount?: number;
  tpa_claim_number?: string;
  tpa_preauth_number?: string;
  policy_number?: string;
  policy_holder_name?: string;
  document_paths?: string[];
}

// ═══ Engine Events ═══

export type EngineEvent =
  | { type: 'run_start'; tpa: string; action: BotAction; claimCount: number }
  | { type: 'step_complete'; step: number; total: number; action: string }
  | { type: 'claim_updated'; claimId: string; oldStatus: string; newStatus: string }
  | { type: 'error'; message: string; screenshot?: string }
  | { type: 'run_complete'; duration: number; processed: number; updated: number };
