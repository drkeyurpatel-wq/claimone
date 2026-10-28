// NhcxClient — the hospital's outbound side of NHCX: token, registry lookups,
// sealing a FHIR bundle as JWE and posting it to the gateway.
//
// Every answer arrives later on our callback (see callback.ts); send() returns
// only the gateway's synchronous receipt and the ids to store against the case.

import { DEFAULT_PATHS, DEFAULT_WORKFLOW, type NhcxAction } from './constants';
import { NhcxError, NhcxValidationError, describeCode, extractErrorCode } from './errors';
import { buildProtocolHeaders, encryptPayload, importRecipientKey, isUuid, newId, normalizeCode } from './jwe';
import type { FhirBundle, JweAlg, NhcxConfig, ParticipantRecord, RetryConfig, SendOptions, SendResult } from './types';

const DEFAULT_RETRY: RetryConfig = { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 8000 };
const DAY_MS = 24 * 60 * 60 * 1000;

interface HttpResult { status: number; json: unknown; text: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

export class NhcxClient {
  private readonly cfg: NhcxConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly retry: RetryConfig;
  private readonly alg: JweAlg;
  private token: { value: string; expiresAt: number } | null = null;
  private tokenInFlight: Promise<string> | null = null;
  private readonly certCache = new Map<string, { key: CryptoKey; expiresAt: number }>();

  constructor(config: NhcxConfig) {
    const required: Array<keyof NhcxConfig> = ['participantCode', 'hfrId', 'providerName', 'gatewayBaseUrl', 'registryBaseUrl', 'auth'];
    for (const k of required) {
      if (!config[k]) throw new NhcxError('config', 'ERR_CONFIG', `missing config.${k}`);
    }
    for (const k of ['gatewayBaseUrl', 'registryBaseUrl'] as const) {
      if (!/^https?:\/\//.test(config[k])) throw new NhcxError('config', 'ERR_CONFIG', `config.${k} must be an http(s) URL`);
    }
    this.cfg = { ...config, participantCode: normalizeCode(config.participantCode) };
    this.fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.retry = { ...DEFAULT_RETRY, ...config.retry };
    this.alg = config.jweAlg ?? 'RSA-OAEP-256';
  }

  get participantCode(): string {
    return this.cfg.participantCode;
  }

  // ------------------------------------------------------------ plumbing

  private now(): number {
    return (this.cfg.now ? this.cfg.now() : new Date()).getTime();
  }

  private sleep(ms: number): Promise<void> {
    return this.cfg.sleep ? this.cfg.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }

  private backoff(attempt: number): number {
    const cap = Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** (attempt - 1));
    return Math.floor((this.cfg.random ?? Math.random)() * cap);
  }

  private log(level: 'info' | 'warn' | 'error', msg: string, meta: Record<string, unknown>): void {
    this.cfg.logger?.[level](msg, meta);
  }

  /** One HTTP call with a timeout. Network failures and timeouts become retryable transport errors. */
  private async httpOnce(url: string, init: RequestInit): Promise<HttpResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.requestTimeoutMs ?? 30_000);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch {
      throw new NhcxError('transport', controller.signal.aborted ? 'ERR_TIMEOUT' : 'ERR_NETWORK',
        controller.signal.aborted ? 'request timed out' : 'network error', { retryable: true });
    } finally {
      clearTimeout(timer);
    }
    let text = '';
    try {
      text = await res.text();
    } catch {
      text = '';
    }
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: res.status, json, text };
  }

  /** Retries 5xx responses and transport failures only, with exponential backoff and full jitter. */
  private async httpWithRetry(url: string, init: () => Promise<RequestInit>, label: string): Promise<{ res: HttpResult; attempts: number }> {
    for (let attempt = 1; ; attempt++) {
      let res: HttpResult | undefined;
      let err: NhcxError | undefined;
      try {
        res = await this.httpOnce(url, await init());
      } catch (e) {
        if (!(e instanceof NhcxError) || !e.retryable) throw e;
        err = e;
      }
      if (res && res.status < 500) return { res, attempts: attempt };
      if (attempt >= this.retry.maxAttempts) {
        if (err) throw err;
        throw new NhcxError('gateway', extractErrorCode(res!.json) ?? `HTTP_${res!.status}`, `${label} failed after ${attempt} attempts`,
          { httpStatus: res!.status, retryable: true });
      }
      const delay = this.backoff(attempt);
      this.log('warn', 'nhcx.retry', { label, attempt, httpStatus: res?.status, code: err?.code, delayMs: delay });
      await this.sleep(delay);
    }
  }

  // ------------------------------------------------------------ token

  /** Bearer token, cached until shortly before expiry. Concurrent callers share one fetch. */
  async getToken(forceRefresh = false): Promise<string> {
    const auth = this.cfg.auth;
    if (auth.kind === 'provider') return auth.provider.getToken({ forceRefresh });
    const skew = this.cfg.tokenRefreshSkewMs ?? 120_000;
    if (!forceRefresh && this.token && this.now() < this.token.expiresAt - skew) return this.token.value;
    if (this.tokenInFlight) return this.tokenInFlight;
    this.tokenInFlight = this.fetchToken().finally(() => {
      this.tokenInFlight = null;
    });
    return this.tokenInFlight;
  }

  private async fetchToken(): Promise<string> {
    const auth = this.cfg.auth;
    if (auth.kind === 'provider') return auth.provider.getToken();
    const init = async (): Promise<RequestInit> => {
      if (auth.kind === 'abdm-sessions') {
        return {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'REQUEST-ID': newId(),
            TIMESTAMP: new Date(this.now()).toISOString(),
            'X-CM-ID': auth.cmId,
          },
          body: JSON.stringify({ clientId: auth.clientId, clientSecret: auth.clientSecret, grantType: 'client_credentials' }),
        };
      }
      const form: Record<string, string> = auth.kind === 'get-session'
        ? { client_id: auth.clientId, client_secret: auth.clientSecret, grant_type: 'client_credentials' }
        : { participant_code: this.cfg.participantCode, username: auth.username, secret: auth.secret };
      return {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(form).toString(),
      };
    };
    const { res } = await this.httpWithRetry(auth.url, init, 'token');
    const body = (res.json ?? {}) as J;
    const value = typeof body.accessToken === 'string' ? body.accessToken : typeof body.access_token === 'string' ? body.access_token : '';
    if (res.status >= 300 || !value) {
      this.log('error', 'nhcx.token.refused', { httpStatus: res.status });
      throw new NhcxError('auth', extractErrorCode(res.json) ?? 'ERR_TOKEN_REFUSED', 'token request refused', { httpStatus: res.status });
    }
    const expiresIn = Number(body.expiresIn ?? body.expires_in);
    const ttl = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 1200 * 1000;
    this.token = { value, expiresAt: this.now() + ttl };
    this.log('info', 'nhcx.token.issued', { ttlSeconds: Math.round(ttl / 1000) });
    return value;
  }

  private async authHeaders(forceRefresh = false): Promise<Record<string, string>> {
    const token = await this.getToken(forceRefresh);
    return {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      [this.cfg.authHeaderName ?? 'bearer_auth']: `Bearer ${token}`,
    };
  }

  /** POST JSON with auth; on 401 refresh the token once and retry. */
  private async postAuthed(url: string, body: () => unknown, label: string): Promise<{ res: HttpResult; attempts: number }> {
    let refreshed = false;
    let total = 0;
    for (;;) {
      const force = refreshed;
      const r = await this.httpWithRetry(url, async () => ({ method: 'POST', headers: await this.authHeaders(force), body: JSON.stringify(body()) }), label);
      total += r.attempts;
      if (r.res.status === 401 && !refreshed) {
        refreshed = true;
        this.log('warn', 'nhcx.token.rejected', { label });
        continue;
      }
      return { res: r.res, attempts: total };
    }
  }

  // ------------------------------------------------------------ registry

  private registryUrl(path: string): string {
    return this.cfg.registryBaseUrl.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
  }

  /** Participant record by code (registry /participant/search). Null when not found. */
  async searchParticipant(participantCode: string): Promise<ParticipantRecord | null> {
    const code = normalizeCode(participantCode);
    const { res } = await this.postAuthed(this.registryUrl(this.cfg.participantSearchPath ?? '/participant/search'),
      () => ({ participant_code: code }), 'registry.search');
    if (res.status === 404) return null;
    if (res.status >= 300) {
      throw new NhcxError('registry', extractErrorCode(res.json) ?? `HTTP_${res.status}`, 'participant search refused', { httpStatus: res.status });
    }
    const body = res.json as J;
    const list: J[] = Array.isArray(body) ? body
      : Array.isArray(body?.participants) ? body.participants
      : Array.isArray(body?.participantdetails) ? body.participantdetails
      : body && typeof body === 'object' && body.participant_code ? [body] : [];
    const p = list.find((x) => typeof x?.participant_code === 'string' && x.participant_code.toLowerCase() === code.toLowerCase()) ?? list[0];
    if (!p) return null;
    return {
      participantCode: String(p.participant_code ?? code),
      name: typeof p.participant_name === 'string' ? p.participant_name : undefined,
      roles: Array.isArray(p.roles) ? p.roles.map(String) : undefined,
      status: Array.isArray(p.status) ? String(p.status[0]) : typeof p.status === 'string' ? p.status : undefined,
      endpointUrl: typeof p.endpoint_url === 'string' ? p.endpoint_url : undefined,
      encryptionCert: typeof p.encryption_cert === 'string' ? p.encryption_cert : undefined,
    };
  }

  /** The recipient's encryption key (registry /fetch/certs), cached for 24 h by default. */
  async getRecipientKey(participantCode: string): Promise<CryptoKey> {
    const code = normalizeCode(participantCode);
    const hit = this.certCache.get(code.toLowerCase());
    if (hit && this.now() < hit.expiresAt) return hit.key;

    const { res } = await this.postAuthed(this.registryUrl(this.cfg.certPath ?? '/fetch/certs'), () => ({ participantid: code }), 'registry.certs');
    if (res.status >= 300) {
      throw new NhcxError('registry', extractErrorCode(res.json) ?? `HTTP_${res.status}`, 'certificate lookup refused', { httpStatus: res.status });
    }
    const body = res.json as J;
    let material: string | undefined =
      [body?.encryption_cert, body?.encryptionCert, body?.cert, body?.certificate, body?.participants?.[0]?.encryption_cert]
        .find((v) => typeof v === 'string' && v.trim() !== '')
      ?? (res.text.includes('-----BEGIN') ? res.text : undefined);
    if (!material) throw new NhcxError('registry', 'ERR_CERT_NOT_FOUND', 'registry returned no encryption certificate');
    if (/^https?:\/\//.test(material.trim())) {
      // HCX registry schema: encryption_cert is a "uri/file path to encryption certificate".
      const { res: certRes } = await this.httpWithRetry(material.trim(), async () => ({ method: 'GET' }), 'registry.certfile');
      if (certRes.status >= 300 || !certRes.text) throw new NhcxError('registry', 'ERR_CERT_NOT_FOUND', 'certificate URL not readable', { httpStatus: certRes.status });
      material = certRes.text;
    }
    const key = await importRecipientKey(material, this.alg);
    this.certCache.set(code.toLowerCase(), { key, expiresAt: this.now() + (this.cfg.certCacheTtlMs ?? DAY_MS) });
    return key;
  }

  /** Drop a cached certificate (e.g. after the recipient reports a decryption failure). */
  invalidateRecipientKey(participantCode: string): void {
    this.certCache.delete(normalizeCode(participantCode).toLowerCase());
  }

  // ------------------------------------------------------------ send

  /**
   * Seals `payload` for `recipientCode` and posts it to the gateway.
   *
   * - api_call_id is fresh per HTTP attempt; request_id is fixed per send().
   * - Originating request without correlationId: correlation = api_call_id (NHCX rule),
   *   so a retried attempt carries a fresh pair (a failed correlation id is retired).
   * - on_* actions require correlationId (echo the payer's request) and default to response.complete.
   * - Retries 5xx and timeouts only; 4xx throws NhcxError(kind 'gateway') with the HCX code.
   */
  async send(action: NhcxAction, payload: FhirBundle | string, recipientCode: string, opts: SendOptions = {}): Promise<SendResult> {
    const path = this.cfg.paths?.[action] ?? DEFAULT_PATHS[action];
    if (!path) throw new NhcxValidationError('action', 'unknown action');
    const isResponse = action.includes('/on_');
    if (isResponse && !opts.correlationId) throw new NhcxValidationError('correlationId', `required for ${action} (echo the request's correlation id)`);
    if (action === 'hcx/status' && !opts.correlationId) throw new NhcxValidationError('correlationId', 'status needs the api_call_id of the message asked about');
    if (opts.correlationId && !isUuid(opts.correlationId)) throw new NhcxValidationError('correlationId', 'must be a UUID');
    if (!recipientCode?.trim()) throw new NhcxValidationError('recipientCode', 'required');
    if (typeof payload !== 'string' && payload?.resourceType !== 'Bundle') throw new NhcxValidationError('payload', 'must be a FHIR Bundle');

    const recipient = normalizeCode(recipientCode);
    const status = opts.status ?? (isResponse ? 'response.complete' : 'request.initiated');
    const workflowId = opts.workflowId ?? DEFAULT_WORKFLOW[action];
    const requestId = newId();
    const url = this.cfg.gatewayBaseUrl.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
    const key = await this.getRecipientKey(recipient);

    let current = { apiCallId: '', correlationId: '' };
    const makeBody = async () => {
      const apiCallId = newId();
      const headers = buildProtocolHeaders({
        senderCode: this.cfg.participantCode,
        recipientCode: recipient,
        status,
        apiCallId,
        correlationId: opts.correlationId,
        requestId,
        workflowId,
        timestamp: new Date(this.now()),
        beneficiaryAbha: opts.beneficiaryAbha,
        useCase: opts.useCase,
        debugFlag: opts.debugFlag,
      });
      current = { apiCallId, correlationId: headers['x-hcx-correlation_id'] };
      return { payload: await encryptPayload({ payload, recipientKey: key, headers, alg: this.alg }) };
    };

    let refreshed = false;
    let attempts = 0;
    for (;;) {
      const force = refreshed;
      const r = await this.httpWithRetry(url, async () => ({
        method: 'POST',
        headers: await this.authHeaders(force),
        body: JSON.stringify(await makeBody()),
      }), action).catch((e: unknown) => {
        if (e instanceof NhcxError) {
          throw new NhcxError(e.kind, e.code, e.message.replace(/^\[NHCX [^\]]+\] /, ''), {
            httpStatus: e.httpStatus, retryable: e.retryable, apiCallId: current.apiCallId, correlationId: current.correlationId,
          });
        }
        throw e;
      });
      attempts += r.attempts;
      const res = r.res;
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        this.log('warn', 'nhcx.token.rejected', { action, apiCallId: current.apiCallId });
        continue;
      }
      const body = (res.json ?? {}) as J;
      const code = extractErrorCode(res.json);
      if (res.status >= 300 || (code && code !== '' && body?.error?.code)) {
        const c = code ?? `HTTP_${res.status}`;
        this.log('error', 'nhcx.send.refused', { action, httpStatus: res.status, code: c, apiCallId: current.apiCallId, correlationId: current.correlationId });
        throw new NhcxError(res.status === 401 || res.status === 403 ? 'auth' : 'gateway', c, `${action}: ${describeCode(c)}`, {
          httpStatus: res.status, apiCallId: current.apiCallId, correlationId: current.correlationId,
        });
      }
      const result: SendResult = {
        action,
        apiCallId: current.apiCallId,
        correlationId: current.correlationId,
        requestId,
        workflowId,
        httpStatus: res.status,
        protocolStatus: typeof body?.result?.protocol_status === 'string' ? body.result.protocol_status : undefined,
        attempts,
      };
      this.log('info', 'nhcx.send.accepted', {
        action, apiCallId: result.apiCallId, correlationId: result.correlationId, workflowId, httpStatus: res.status, attempts,
      });
      return result;
    }
  }

  /**
   * Status API: empty payload, correlation_id = the api_call_id of the message asked about,
   * sender/recipient as on that message. The answer arrives on /v1/on_status.
   */
  checkStatus(target: { apiCallId: string; recipientCode: string }, opts: Omit<SendOptions, 'correlationId'> = {}): Promise<SendResult> {
    return this.send('hcx/status', '', target.recipientCode, { ...opts, correlationId: target.apiCallId });
  }
}
