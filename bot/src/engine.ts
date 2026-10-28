// bot/src/engine.ts — Generic TPA Portal Bot Engine
// Config-driven Playwright automation — one engine, N TPA configs

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { TPAConfig, FlowStep, FlowDefinition, BotAction, BotRunRecord, ClaimData } from './types';
import { fetchPendingClaims, applyPortalResult, recordEvent, logBotRun, updateBotRun, uploadLetter, findPayerId, letterCodeFor, dropStatement } from './supabase';
import { statementRows, statementWindow } from './statement';
import { logger } from './logger';

// ═══ Config Loader ═══

// TPA_CONFIG_DIR lets a test point the bot at a practice portal; normally unset.
const configDir = () => process.env.TPA_CONFIG_DIR || path.join(__dirname, '..', 'tpa-configs');

export function loadTPAConfig(tpaCode: string): TPAConfig {
  if (!/^[a-z0-9_]+$/.test(tpaCode)) throw new Error('Bad TPA code');
  const configPath = path.join(configDir(), `${tpaCode}.json`);
  if (!fs.existsSync(configPath)) {
    throw new Error(`TPA config not found: ${configPath}`);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

export function listAvailableTPAs(): string[] {
  const dir = configDir();
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''));
}

// ═══ Template Resolution ═══
// Replaces {{field}} in config values with actual claim data

function resolveTemplate(template: string, claim: ClaimData): string {
  return template.replace(/\{\{(\w+(?:\.\w+)?)\}\}/g, (_, key) => {
    const value = (claim as Record<string, any>)[key];
    return value !== undefined && value !== null ? String(value) : '';
  });
}

// ═══ Main Engine Class ═══

export class BotEngine {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private config: TPAConfig;
  private centreId: string;
  private outputs: Record<string, string> = {};

  constructor(config: TPAConfig, centreId: string) {
    this.config = config;
    this.centreId = centreId;
  }

  // ─── Lifecycle ───

  async init(): Promise<void> {
    logger.info({ tpa: this.config.tpa_code }, 'Initializing browser');
    this.browser = await chromium.launch({
      headless: process.env.HEADLESS !== 'false',
      executablePath: process.env.CHROMIUM_PATH || undefined, // optional: use an already-installed Chromium
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    this.context = await this.browser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(30000);
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }

  // ─── Login ───

  async login(): Promise<boolean> {
    if (!this.page) throw new Error('Browser not initialized');
    const auth = this.config.auth;
    const prefix = this.config.env_prefix;
    const username = process.env[`${prefix}_USERNAME`];
    const password = process.env[`${prefix}_PASSWORD`];

    if (!username || !password) {
      throw new Error(`Missing credentials: ${prefix}_USERNAME / ${prefix}_PASSWORD`);
    }

    logger.info({ tpa: this.config.tpa_code, url: auth.login_url }, 'Logging in');

    try {
      await this.page.goto(auth.login_url, { waitUntil: 'networkidle', timeout: 30000 });

      if (auth.captcha) {
        logger.warn('CAPTCHA detected — cannot auto-login. Manual intervention required.');
        await this.takeScreenshot('captcha_detected');
        return false;
      }

      await this.page.fill(auth.selectors.username, username);
      await this.page.fill(auth.selectors.password, password);
      await this.page.click(auth.selectors.submit);

      if (auth.otp) {
        // An OTP goes to a phone; there is no one at the mini PC to type it.
        logger.warn({ tpa: this.config.tpa_code }, 'Portal asks for an OTP — automated login is not possible');
        await this.takeScreenshot('otp_required');
        return false;
      }
      await this.page.waitForSelector(auth.selectors.success, { timeout: 15000 });

      logger.info({ tpa: this.config.tpa_code }, 'Login successful');
      return true;
    } catch (error: any) {
      logger.error({ error: error.message, tpa: this.config.tpa_code }, 'Login failed');
      await this.takeScreenshot('login_failed');
      return false;
    }
  }

  // ─── Execute a Flow ───

  async executeFlow(
    flowName: string,
    flow: FlowDefinition,
    claim?: ClaimData
  ): Promise<{ success: boolean; outputs: Record<string, string>; stepsCompleted: number }> {
    if (!this.page) throw new Error('Browser not initialized');

    this.outputs = {};
    let stepsCompleted = 0;

    logger.info({ tpa: this.config.tpa_code, flow: flowName, steps: flow.steps.length }, 'Executing flow');

    for (const step of flow.steps) {
      try {
        await this.executeStep(step, claim);
        stepsCompleted++;
        logger.debug({ step: stepsCompleted, total: flow.steps.length, action: step.action }, 'Step completed');
      } catch (error: any) {
        logger.error({ error: error.message, step: stepsCompleted + 1, action: step.action }, 'Step failed');
        await this.takeScreenshot(`${flowName}_step${stepsCompleted + 1}_failed`);
        return { success: false, outputs: this.outputs, stepsCompleted };
      }
    }

    return { success: true, outputs: this.outputs, stepsCompleted };
  }

  // ─── Execute Single Step ───

  private async executeStep(step: FlowStep, claim?: ClaimData): Promise<void> {
    if (!this.page) throw new Error('Browser not initialized');
    const resolve = (val: string) => claim ? resolveTemplate(val, claim) : val;

    switch (step.action) {
      case 'goto':
        const url = step.url.startsWith('http') ? resolve(step.url) : `${this.config.portal.url}${resolve(step.url)}`;
        await this.page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        break;

      case 'wait':
        await this.page.waitForSelector(resolve(step.selector), { timeout: step.timeout || 10000 });
        break;

      case 'fill':
        await this.page.waitForSelector(resolve(step.selector), { timeout: 5000 });
        await this.page.fill(resolve(step.selector), resolve(step.value));
        break;

      case 'select':
        await this.page.selectOption(resolve(step.selector), resolve(step.value));
        break;

      case 'click':
        await this.page.waitForSelector(resolve(step.selector), { timeout: 5000 });
        await this.page.click(resolve(step.selector));
        await this.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        break;

      case 'upload': {
        const files = resolve(step.files).split(',').map(f => f.trim()).filter(Boolean);
        if (files.length > 0) {
          const input = await this.page.waitForSelector(resolve(step.selector), { timeout: 5000 });
          await input?.setInputFiles(files);
        }
        break;
      }

      case 'download': {
        const [download] = await Promise.all([
          this.page.waitForEvent('download', { timeout: 30000 }),
          this.page.click(resolve(step.selector)),
        ]);
        const buffer = await download.createReadStream().then(stream => {
          const chunks: Buffer[] = [];
          return new Promise<Buffer>((res, rej) => {
            stream.on('data', (c: Buffer) => chunks.push(c));
            stream.on('end', () => res(Buffer.concat(chunks)));
            stream.on('error', rej);
          });
        });
        this.outputs[step.output] = `downloaded_${download.suggestedFilename()}`;
        // Store buffer for later upload
        this.outputs[`${step.output}_buffer`] = buffer.toString('base64');
        this.outputs[`${step.output}_filename`] = download.suggestedFilename();
        break;
      }

      case 'extract': {
        const el = await this.page.waitForSelector(resolve(step.selector), { timeout: 5000 });
        const text = await el?.textContent() || '';
        this.outputs[step.output] = text.trim();
        logger.debug({ output: step.output, chars: text.trim().length }, 'Extracted value'); // never log the value: it can be patient data
        break;
      }

      case 'extract_table': {
        const rows = await this.page.$$(resolve(step.selector));
        const tableData: Record<string, string>[] = [];
        for (const row of rows) {
          const cells = await row.$$('td');
          const rowData: Record<string, string> = {};
          for (let i = 0; i < Math.min(cells.length, step.columns.length); i++) {
            rowData[step.columns[i]] = (await cells[i].textContent() || '').trim();
          }
          tableData.push(rowData);
        }
        this.outputs[step.output] = JSON.stringify(tableData);
        break;
      }

      case 'screenshot':
        await this.takeScreenshot(resolve(step.name));
        break;

      case 'sleep':
        await new Promise(r => setTimeout(r, step.ms));
        break;

      case 'if_visible': {
        const visible = await this.page.isVisible(resolve(step.selector)).catch(() => false);
        const branch = visible ? step.then : (step.else || []);
        for (const subStep of branch) {
          await this.executeStep(subStep, claim);
        }
        break;
      }

      case 'log':
        logger.info({ message: step.message }, 'Flow log'); // template not resolved: no patient data in logs
        break;
    }
  }

  // ─── Screenshot ───

  lastScreenshot: string | null = null;

  /** Screenshots stay on this machine (they show patient data) and are pruned after 7 days. */
  async takeScreenshot(name: string): Promise<string | null> {
    if (!this.page) return null;
    try {
      const dir = path.join(process.cwd(), 'screenshots', this.config.tpa_code);
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${Date.now()}_${name.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`);
      await this.page.screenshot({ path: file, fullPage: false });
      this.lastScreenshot = path.relative(process.cwd(), file);
      return this.lastScreenshot;
    } catch (e: any) {
      logger.error({ error: e.message }, 'Screenshot failed');
      return null;
    }
  }


  // ═══ High-Level Actions ═══

  async pollClaimStatuses(payerId: string): Promise<{ processed: number; updated: number }> {
    const claims = await fetchPendingClaims(payerId, this.centreId, 'check_status');
    if (claims.length === 0) return { processed: 0, updated: 0 };
    const flow = this.config.flows.check_status;
    if (!flow) throw new Error('check_status flow not defined');

    let processed = 0, updated = 0;
    for (const claim of claims) {
      try {
        await this.rateLimit();
        const result = await this.executeFlow('check_status', flow, claim);
        processed++;
        const portalStatus = result.success ? result.outputs.portal_status?.trim() : undefined;
        if (!portalStatus) continue;

        const mapped = this.config.status_mapping[portalStatus];
        if (!mapped) {
          logger.warn({ claim: claim.claim_number, portalStatus }, 'Unmapped portal status — add it to status_mapping');
          continue;
        }
        // H1 Claims compared the new status with the claim *number*, so it
        // "updated" every claim on every poll. Compare with the status.
        const fields: { approved_amount?: number; tpa_claim_number?: string } = {};
        if (result.outputs.approved_amount) {
          const n = Number(result.outputs.approved_amount.replace(/[₹,\s]/g, ''));
          if (Number.isFinite(n) && n >= 0) fields.approved_amount = n;
        }
        if (result.outputs.tpa_claim_number && !claim.tpa_claim_number) fields.tpa_claim_number = result.outputs.tpa_claim_number.trim();
        const statusChange = mapped !== claim.status ? mapped : null;
        if (!statusChange && Object.keys(fields).length === 0) continue;

        try {
          await applyPortalResult(claim.id, statusChange, fields, `Portal shows "${portalStatus}"`);
          updated++;
          logger.info({ claim: claim.claim_number, from: claim.status, to: statusChange }, 'Claim updated from portal');
        } catch (e: any) {
          // e.g. portal says "Settled" but settlement needs a person; or an illegal jump
          logger.warn({ claim: claim.claim_number, to: statusChange, reason: e.message }, 'Portal result not applied');
        }
      } catch (error: any) {
        logger.error({ error: error.message, claim: claim.claim_number }, 'Polling failed for claim');
      }
    }
    return { processed, updated };
  }

  async submitPreauths(payerId: string): Promise<{ processed: number; updated: number }> {
    const flow = this.config.flows.submit_preauth;
    if (!flow) throw new Error('submit_preauth flow not defined');
    if (!this.config.verified_on) throw new Error(`submit_preauth for ${this.config.tpa_code} is not verified against the live portal`);

    const claims = await fetchPendingClaims(payerId, this.centreId, 'submit_preauth');
    let processed = 0, updated = 0;
    for (const claim of claims) {
      try {
        await this.rateLimit();
        // Record the attempt first: if anything below fails half-way, the
        // claim is not filed a second time 15 minutes later.
        await recordEvent(claim.id, 'bot_preauth_attempted', { payer: this.config.tpa_code });
        const result = await this.executeFlow('submit_preauth', flow, claim);
        processed++;
        const ref = result.outputs.tpa_preauth_number?.trim();
        if (result.success && ref) {
          await applyPortalResult(claim.id, null, { tpa_preauth_number: ref }, 'Pre-auth filed on portal');
          updated++;
        } else {
          await recordEvent(claim.id, 'bot_preauth_unconfirmed', { success: result.success, steps: result.stepsCompleted });
          logger.warn({ claim: claim.claim_number }, 'Pre-auth not confirmed — check the portal by hand');
        }
      } catch (error: any) {
        logger.error({ error: error.message, claim: claim.claim_number }, 'Pre-auth submission failed');
      }
    }
    return { processed, updated };
  }

  async downloadLetters(payerId: string): Promise<{ processed: number; updated: number }> {
    const flow = this.config.flows.download_letter;
    if (!flow) throw new Error('download_letter flow not defined');

    const claims = await fetchPendingClaims(payerId, this.centreId, 'download_letter');
    let processed = 0, updated = 0;
    for (const claim of claims) {
      try {
        await this.rateLimit();
        const result = await this.executeFlow('download_letter', flow, claim);
        processed++;
        if (result.success && result.outputs.letter_path_buffer) {
          const buffer = Buffer.from(result.outputs.letter_path_buffer, 'base64');
          const filename = result.outputs.letter_path_filename || 'letter.pdf';
          await uploadLetter(claim.id, letterCodeFor(claim.status), filename, buffer, 'application/pdf');
          updated++;
        }
      } catch (error: any) {
        logger.error({ error: error.message, claim: claim.claim_number }, 'Letter download failed');
      }
    }
    return { processed, updated };
  }

  /** Download this week's payment statement and drop it in the inbox for staff. */
  async downloadPayments(payerId: string): Promise<{ processed: number; updated: number }> {
    const flow = this.config.flows.download_payments;
    if (!flow) throw new Error('download_payments flow not defined');
    // {{from_date}} / {{to_date}} in the flow: the last 14 days, so a missed week is caught next time
    const result = await this.executeFlow('download_payments', flow, statementWindow(new Date(), 14) as unknown as ClaimData);
    if (!result.success) return { processed: 0, updated: 0 };
    const rows = await statementRows(result.outputs);
    if (rows.length < 2) {
      logger.info({ tpa: this.config.tpa_code }, 'Statement has no payment rows');
      return { processed: 1, updated: 0 };
    }
    const name = result.outputs.payments_file_filename || `${this.config.tpa_code}_payments.xlsx`;
    const fresh = await dropStatement(this.centreId, payerId, `${this.config.tpa_name} website`, name, rows);
    logger.info({ tpa: this.config.tpa_code, rows: rows.length, fresh }, fresh ? 'Statement ready for staff' : 'Statement already in the inbox');
    return { processed: 1, updated: fresh ? 1 : 0 };
  }

  // ─── Rate Limiter ───
  private lastRequest = 0;
  private async rateLimit(): Promise<void> {
    const minGap = (60 / this.config.rate_limit.requests_per_minute) * 1000;
    const elapsed = Date.now() - this.lastRequest;
    if (elapsed < minGap) {
      await new Promise(r => setTimeout(r, minGap - elapsed));
    }
    this.lastRequest = Date.now();
  }
}

// ═══ Run a Full Bot Cycle ═══

export async function runBotCycle(tpaCode: string, action: BotAction, centreId: string): Promise<void> {
  const config = loadTPAConfig(tpaCode);
  const act = action === 'poll_all' ? 'check_status' : action;
  const payerId = await findPayerId(config.tpa_code);
  const run: BotRunRecord = {
    payer_id: payerId, centre_id: centreId, action: act, status: 'running',
    started_at: new Date().toISOString(), steps_completed: 0, total_steps: 0, claims_processed: 0, claims_updated: 0,
  };

  if ((act === 'submit_preauth' || act === 'submit_claim') && !config.verified_on) {
    await updateBotRun(await logBotRun({ ...run, status: 'skipped' }), {
      status: 'skipped', completed_at: new Date().toISOString(),
      error_message: 'Write flow not verified against the live portal (set verified_on in the config)',
    });
    logger.warn({ tpa: tpaCode, action: act }, 'Skipped: config not verified');
    return;
  }

  const runId = await logBotRun(run);
  const startTime = Date.now();
  const engine = new BotEngine(config, centreId);
  try {
    await engine.init();
    const loggedIn = await engine.login();
    if (!loggedIn) {
      await updateBotRun(runId, {
        status: config.auth.captcha ? 'captcha_blocked' : 'failed',
        completed_at: new Date().toISOString(), duration_ms: Date.now() - startTime, error_message: 'Portal login failed',
        screenshot_path: engine.lastScreenshot ?? undefined,
      });
      return;
    }

    let result = { processed: 0, updated: 0 };
    if (act === 'check_status') result = await engine.pollClaimStatuses(payerId);
    else if (act === 'submit_preauth') result = await engine.submitPreauths(payerId);
    else if (act === 'download_letter') result = await engine.downloadLetters(payerId);
    else if (act === 'download_payments') result = await engine.downloadPayments(payerId);

    await updateBotRun(runId, {
      status: result.processed > 0 && result.updated === 0 && act !== 'check_status' && act !== 'download_payments' ? 'partial' : 'success',
      completed_at: new Date().toISOString(), duration_ms: Date.now() - startTime,
      claims_processed: result.processed, claims_updated: result.updated,
    });
    logger.info({ tpa: tpaCode, action: act, ...result, durationMs: Date.now() - startTime }, 'Bot cycle complete');
  } catch (error: any) {
    await engine.takeScreenshot('fatal_error');
    await updateBotRun(runId, {
      status: 'failed', completed_at: new Date().toISOString(), duration_ms: Date.now() - startTime,
      error_message: String(error.message).slice(0, 500), screenshot_path: engine.lastScreenshot ?? undefined,
    });
    logger.error({ error: error.message, tpa: tpaCode }, 'Bot cycle failed');
  } finally {
    await engine.close();
  }
}
