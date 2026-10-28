// In-process fake NHCX: ABDM token endpoint + participant registry + gateway +
// one scripted payer. It is a `fetch` implementation, so NhcxClient talks to it
// exactly as it would to the sandbox; payer answers queue up in `outbox` and are
// delivered to the hospital's callback handler with deliverAll().
//
// The fake enforces what the real exchange enforces (per NHCX docs): bearer_auth
// token, {"payload": compact JWE}, mandatory x-hcx headers, sender/recipient
// registered, request.initiated on submit paths / response.* on on_ paths
// (NHCX-1011), no correlation-id reuse on originating requests (NHCX-1006).
// The fake payer decrypts with its own key — the gateway itself never does.

import {
  buildProtocolHeaders, decryptPayload, encryptPayload, formatAckTimestamp, formatIstDateTime, importRecipientKey, isUuid,
  newId, normalizeCode, PrivateKeyRing, readProtectedHeader, sameCode,
} from '../jwe';
import { round2 } from '../fhir';
import { SYSTEM } from '../constants';
import type { CallbackOutcome, FhirBundle, FhirResource, HcxStatus } from '../types';
import type { CallbackRequest } from '../callback';
import { generateTestKeyPair, type TestKeyPair } from './keys';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

export type PayerDecision = 'approve' | 'partial' | 'query' | 'reject';

export interface ReceivedMessage {
  path: string;
  headers: Record<string, unknown>;
  /** Decrypted by the fake payer (null for empty payloads or undecryptable messages). */
  bundle: J | null;
  decrypted: boolean;
}

export interface OutboundCallback {
  path: string;
  body: unknown;
  /** For assertions: the headers the payer sealed. */
  headers: Record<string, unknown>;
}

export interface FakeNhcxOptions {
  providerCode: string;
  /** What the registry returns for the provider (certificate PEM). */
  providerCertificatePem: string;
  payerCode?: string;
  payerName?: string;
  clientId?: string;
  clientSecret?: string;
  tokenTtlSeconds?: number;
  /** Balance the eligibility answer reports (default ₹5,00,000). */
  coverageBalance?: number;
  /** Deduction applied on a 'partial' decision (default ₹2,500, capped at the largest line). */
  partialDeduction?: number;
  now?: () => Date;
}

const HOST = 'https://fake-nhcx.test';

export class FakeNhcx {
  readonly gatewayBaseUrl = `${HOST}/hcx`;
  readonly registryBaseUrl = `${HOST}/registry`;
  readonly sessionsUrl = `${HOST}/sessions`;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly payerCode: string;
  readonly payerName: string;
  readonly payerKeys: TestKeyPair;

  readonly received: ReceivedMessage[] = [];
  readonly outbox: OutboundCallback[] = [];
  /** Every HTTP call the fake saw, for assertions: url path and status returned. */
  readonly calls: Array<{ path: string; status: number }> = [];
  /** Queued decisions per kind; when empty the default applies (preauth approve, claim partial). */
  readonly decisions: { preauth: PayerDecision[]; enhancement: PayerDecision[]; claim: PayerDecision[] } = { preauth: [], enhancement: [], claim: [] };
  /** Next gateway responses to force (e.g. [503, 503]); applies to use-case calls only. */
  readonly failNext: number[] = [];
  /** Delay (ms) before answering gateway calls, to trigger client timeouts; consumed per call. */
  readonly hangNext: number[] = [];
  tokensIssued = 0;

  private readonly opts: Required<Omit<FakeNhcxOptions, 'payerCode' | 'payerName' | 'clientId' | 'clientSecret'>>;
  private readonly providerCode: string;
  private readonly payerRing: PrivateKeyRing;
  private validTokens = new Set<string>();
  private usedCorrelations = new Set<string>();
  /** correlation id of a queried pre-auth → its case data, so the answer can release a decision. */
  private openQueries = new Map<string, { claim: J; workflow: string }>();
  private providerKey: Promise<CryptoKey> | null = null;

  constructor(opts: FakeNhcxOptions) {
    this.providerCode = normalizeCode(opts.providerCode);
    this.payerCode = normalizeCode(opts.payerCode ?? '1000003538@hcx');
    this.payerName = opts.payerName ?? 'Sandbox Payer';
    this.clientId = opts.clientId ?? 'test-client';
    this.clientSecret = opts.clientSecret ?? 'test-secret';
    this.payerKeys = generateTestKeyPair('fake-payer');
    this.payerRing = new PrivateKeyRing(this.payerKeys.privateKeyPem);
    this.opts = {
      providerCode: this.providerCode,
      providerCertificatePem: opts.providerCertificatePem,
      tokenTtlSeconds: opts.tokenTtlSeconds ?? 1200,
      coverageBalance: opts.coverageBalance ?? 500000,
      partialDeduction: opts.partialDeduction ?? 2500,
      now: opts.now ?? (() => new Date()),
    };
  }

  /** Invalidate every issued token (the next use-case call answers 401). */
  revokeTokens(): void {
    this.validTokens.clear();
  }

  // ---------------------------------------------------------------- fetch

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const text = typeof init?.body === 'string' ? init.body : '';
    const signal = init?.signal ?? undefined;
    const reply = (status: number, body: unknown) => {
      this.calls.push({ path: url.pathname, status });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    };

    if (url.origin !== HOST) return reply(404, { error: { code: 'NOT_FOUND' } });

    // ---- token
    if (url.pathname === '/sessions' && method === 'POST') {
      if (!headers.get('REQUEST-ID') || !headers.get('X-CM-ID') || !headers.get('TIMESTAMP')) return reply(400, { error: { code: 'BAD_HEADERS' } });
      const b = safeJson(text);
      if (b?.clientId !== this.clientId || b?.clientSecret !== this.clientSecret || b?.grantType !== 'client_credentials') {
        return reply(401, { error: { code: 'UNAUTHORIZED' } });
      }
      const token = `tok-${newId()}`;
      this.validTokens.add(token);
      this.tokensIssued++;
      return reply(200, { accessToken: token, expiresIn: this.opts.tokenTtlSeconds, tokenType: 'bearer' });
    }

    // ---- everything else needs the token
    const auth = headers.get('bearer_auth') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!this.validTokens.has(token)) return reply(401, { error: { code: 'NHCX-401', message: 'User Unauthorized' } });

    // ---- registry
    if (url.pathname === '/registry/fetch/certs') {
      const code = normalizeCode(String(safeJson(text)?.participantid ?? ''));
      const pem = sameCode(code, this.payerCode) ? this.payerKeys.certificatePem
        : sameCode(code, this.providerCode) ? this.opts.providerCertificatePem : null;
      if (!pem) return reply(400, { error: { code: 'NHCX-1003' } });
      return reply(200, { participantid: code, encryption_cert: Buffer.from(pem).toString('base64') });
    }
    if (url.pathname === '/registry/participant/search') {
      const code = normalizeCode(String(safeJson(text)?.participant_code ?? ''));
      if (!sameCode(code, this.payerCode)) return reply(200, { participants: [] });
      return reply(200, { participants: [{ participant_code: this.payerCode, participant_name: this.payerName, roles: ['payer'], status: 'Active', endpoint_url: `${HOST}/payer`, encryption_cert: Buffer.from(this.payerKeys.certificatePem).toString('base64') }] });
    }

    // ---- gateway use-case calls
    if (!url.pathname.startsWith('/hcx/v1/')) return reply(404, { error: { code: 'NOT_FOUND' } });
    const hang = this.hangNext.shift();
    if (hang) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, hang);
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); });
      });
    }
    const forced = this.failNext.shift();
    if (forced) return reply(forced, { error: { code: 'NHCX-1008' } });
    const path = url.pathname.slice('/hcx/v1/'.length);
    const body = safeJson(text);
    if (typeof body?.payload !== 'string') return reply(400, { error: { code: 'ERR_INVALID_PAYLOAD' } });
    let h: Record<string, unknown>;
    try {
      h = readProtectedHeader(body.payload);
    } catch {
      return reply(400, { error: { code: 'ERR_INVALID_PAYLOAD' } });
    }
    const err = this.checkEnvelope(path, h);
    if (err) return reply(400, { timestamp: formatAckTimestamp(this.opts.now()), api_call_id: h['x-hcx-api_call_id'] ?? '', correlation_id: h['x-hcx-correlation_id'] ?? '', error: { code: err, message: '' } });

    // the payer opens the letter
    let bundle: J | null = null;
    let decrypted = false;
    try {
      const dec = await decryptPayload(body.payload, this.payerRing);
      bundle = dec.payload;
      decrypted = true;
    } catch {
      decrypted = false;
    }
    this.received.push({ path, headers: h, bundle, decrypted });
    if (!decrypted) {
      await this.protocolError(path, h, 'ERR_INVALID_ENCRYPTION');
    } else {
      await this.payerAct(path, h, bundle);
    }
    return reply(202, {
      timestamp: formatAckTimestamp(this.opts.now()),
      api_call_id: h['x-hcx-api_call_id'],
      correlation_id: h['x-hcx-correlation_id'],
      result: { sender_code: h['x-hcx-sender_code'], recipient_code: h['x-hcx-recipient_code'], entity_type: path.split('/')[0], protocol_status: 'request.queued' },
      error: { code: '', message: '' },
    });
  };

  private checkEnvelope(path: string, h: Record<string, unknown>): string | null {
    for (const k of ['x-hcx-sender_code', 'x-hcx-recipient_code', 'x-hcx-api_call_id', 'x-hcx-correlation_id', 'x-hcx-timestamp', 'x-hcx-status']) {
      if (typeof h[k] !== 'string' || (h[k] as string) === '') return 'NHCX-1005';
    }
    if (h.alg !== 'RSA-OAEP-256' && h.alg !== 'RSA-OAEP') return 'NHCX-1005';
    if (h.enc !== 'A256GCM') return 'NHCX-1005';
    if (!isUuid(h['x-hcx-api_call_id']) || !isUuid(h['x-hcx-correlation_id'])) return 'NHCX-1005';
    if (!sameCode(String(h['x-hcx-sender_code']), this.providerCode)) return 'NHCX-1002';
    if (!sameCode(String(h['x-hcx-recipient_code']), this.payerCode)) return 'NHCX-1003';
    const abha = h['x-hcx-ben-abha-id'];
    if (abha !== undefined && !/^\d{2}-\d{4}-\d{4}-\d{4}$/.test(String(abha))) return 'NHCX-1018';
    const isOn = path.split('/').pop()!.startsWith('on_');
    const status = h['x-hcx-status'] as HcxStatus;
    if (isOn ? !String(status).startsWith('response.') : status !== 'request.initiated') return 'NHCX-1011';
    if (!isOn && path !== 'status') {
      const corr = String(h['x-hcx-correlation_id']);
      if (this.usedCorrelations.has(corr)) return 'NHCX-1006';
      this.usedCorrelations.add(corr);
    }
    return null;
  }

  // ---------------------------------------------------------------- payer behaviour

  private async seal(path: string, bundle: unknown, h: { correlationId: string; workflowId?: string; status: HcxStatus; apiCallId?: string }): Promise<void> {
    this.providerKey ??= importRecipientKey(this.opts.providerCertificatePem, 'RSA-OAEP-256');
    const headers = buildProtocolHeaders({
      senderCode: this.payerCode,
      recipientCode: this.providerCode,
      status: h.status,
      apiCallId: h.apiCallId,
      correlationId: h.correlationId,
      workflowId: h.workflowId,
      timestamp: this.opts.now(),
    });
    const payload = await encryptPayload({ payload: bundle ?? '', recipientKey: await this.providerKey, headers });
    this.outbox.push({ path: `/v1/${path}`, body: { type: 'JWEPayload', payload }, headers: headers as unknown as Record<string, unknown> });
  }

  private async protocolError(path: string, h: Record<string, unknown>, code: string): Promise<void> {
    const onPath = path.endsWith('/submit') ? path.replace('/submit', '/on_submit') : path.endsWith('/check') ? path.replace('/check', '/on_check') : null;
    if (!onPath) return;
    const body = {
      type: 'ProtocolResponse',
      'x-hcx-sender_code': this.payerCode,
      'x-hcx-recipient_code': this.providerCode,
      'x-hcx-api_call_id': newId(),
      'x-hcx-correlation_id': h['x-hcx-correlation_id'],
      'x-hcx-workflow_id': h['x-hcx-workflow_id'],
      'x-hcx-timestamp': formatIstDateTime(this.opts.now()),
      'x-hcx-status': 'response.error',
      'x-hcx-error_details': { code, message: 'Payer could not decrypt the request', trace: '' },
    };
    this.outbox.push({ path: `/v1/${onPath}`, body, headers: body });
  }

  private async payerAct(path: string, h: Record<string, unknown>, bundle: J): Promise<void> {
    const correlationId = String(h['x-hcx-correlation_id']);
    const workflow = h['x-hcx-workflow_id'] !== undefined ? String(h['x-hcx-workflow_id']) : undefined;
    const claim = findResource(bundle, 'Claim');

    switch (path) {
      case 'coverageeligibility/check': {
        await this.seal('coverageeligibility/on_check', this.eligibilityResponse(bundle), { correlationId, status: 'response.complete' });
        return;
      }
      case 'preauth/submit': {
        const isEnhancement = workflow === '13';
        const decision = (isEnhancement ? this.decisions.enhancement : this.decisions.preauth).shift() ?? 'approve';
        if (workflow === '19' || workflow === '131') {
          // query answered on the pre-auth path (PMJAY style) → decide
          this.openQueries.delete(correlationId);
          await this.seal('preauth/on_submit', this.claimResponse(claim, 'approve'), { correlationId, workflowId: '21', status: 'response.complete' });
          return;
        }
        if (decision === 'query') {
          await this.seal('preauth/on_submit', this.claimResponse(claim, 'query'), { correlationId, workflowId: isEnhancement ? '241' : '24', status: 'response.partial' });
          // HCX: the communication request reuses the cycle's correlation id.
          await this.seal('communication/request', this.communicationRequest(claim), { correlationId, workflowId: isEnhancement ? '241' : '24', status: 'request.initiated' });
          this.openQueries.set(correlationId, { claim, workflow: isEnhancement ? '22' : '21' });
          return;
        }
        const wf = decision === 'reject' ? (isEnhancement ? '231' : '23') : isEnhancement ? '22' : '21';
        await this.seal('preauth/on_submit', this.claimResponse(claim, decision), { correlationId, workflowId: wf, status: 'response.complete' });
        return;
      }
      case 'claim/submit': {
        const decision = this.decisions.claim.shift() ?? 'partial';
        await this.seal('claim/on_submit', this.claimResponse(claim, 'ack'), { correlationId, workflowId: '25', status: 'response.partial' });
        if (decision === 'query') {
          await this.seal('claim/on_submit', this.claimResponse(claim, 'query'), { correlationId, workflowId: '27', status: 'response.partial' });
          await this.seal('communication/request', this.communicationRequest(claim), { correlationId, workflowId: '27', status: 'request.initiated' });
          this.openQueries.set(correlationId, { claim, workflow: '26' });
          return;
        }
        const wf = decision === 'reject' ? '291' : '26';
        await this.seal('claim/on_submit', this.claimResponse(claim, decision), { correlationId, workflowId: wf, status: 'response.complete' });
        return;
      }
      case 'communication/on_request': {
        const open = this.openQueries.get(correlationId);
        if (open) {
          this.openQueries.delete(correlationId);
          const path2 = findResource({ entry: [{ resource: open.claim }] }, 'Claim')?.use === 'claim' ? 'claim/on_submit' : 'preauth/on_submit';
          await this.seal(path2, this.claimResponse(open.claim, 'approve'), { correlationId, workflowId: open.workflow, status: 'response.complete' });
        }
        return;
      }
      case 'status': {
        await this.seal('on_status', '', { correlationId, status: 'response.complete' });
        return;
      }
      default:
        return; // paymentnotice/on_request: the ack is recorded in `received`
    }
  }

  /** Payer-initiated payment notice (workflow 30/31/33). net = approved − TDS. */
  async sendPaymentNotice(args: { caseNumber: string; approved: number; tds: number; utr: string; workflowId?: '30' | '31' | '33'; paymentDate?: string }): Promise<string> {
    const correlationId = newId();
    const net = round2(args.approved - args.tds);
    const now = this.opts.now();
    const u = { task: urn(), notice: urn(), recon: urn(), payer: urn(), provider: urn() };
    const cln = [{ type: { coding: [{ system: SYSTEM.identifierType, code: 'CLN', display: 'Claim number' }] }, system: 'https://payer.example', value: args.caseNumber }];
    const bundle: FhirBundle = {
      resourceType: 'Bundle', id: newId(), type: 'collection', timestamp: formatIstDateTime(now),
      entry: [
        { fullUrl: u.task, resource: { resourceType: 'Task', status: 'requested', intent: 'order', code: { coding: [{ system: SYSTEM.taskCodes, code: 'deliver' }] }, description: 'Payment settled', input: [{ type: { coding: [{ code: 'status' }] }, valueReference: { reference: u.notice } }] } },
        { fullUrl: u.notice, resource: { resourceType: 'PaymentNotice', identifier: cln, status: 'active', created: formatIstDateTime(now), payment: { reference: u.recon }, recipient: { reference: u.provider }, amount: { value: net, currency: 'INR' }, paymentStatus: { coding: [{ code: 'paid' }] } } },
        { fullUrl: u.recon, resource: { resourceType: 'PaymentReconciliation', identifier: cln, status: 'active', created: formatIstDateTime(now), disposition: 'Payment settled', paymentDate: args.paymentDate ?? formatIstDateTime(now).slice(0, 10), paymentAmount: { value: net, currency: 'INR' }, paymentIdentifier: { type: { coding: [{ system: SYSTEM.identifierType, code: 'UTR' }] }, value: args.utr }, detail: [
          { type: { coding: [{ code: 'TDS' }] }, amount: { value: args.tds } },
          { type: { coding: [{ code: 'Payment' }] }, amount: { value: net } },
          { type: { coding: [{ code: 'approvedamount' }] }, amount: { value: args.approved } },
        ] } },
        { fullUrl: u.payer, resource: org('pay', this.payerName) },
        { fullUrl: u.provider, resource: org('prov', 'Hospital') },
      ],
    };
    await this.seal('paymentnotice/request', bundle, { correlationId, workflowId: args.workflowId ?? '33', status: 'request.initiated' });
    return correlationId;
  }

  /** Deliver queued payer messages to the hospital's callback, oldest first. */
  async deliverAll(handler: (req: CallbackRequest) => Promise<CallbackOutcome>): Promise<CallbackOutcome[]> {
    const out: CallbackOutcome[] = [];
    while (this.outbox.length) {
      const m = this.outbox.shift()!;
      out.push(await handler({ path: m.path, body: JSON.stringify(m.body) }));
    }
    return out;
  }

  // ---------------------------------------------------------------- payer bundles

  private eligibilityResponse(req: J): FhirBundle {
    const cer = findResource(req, 'CoverageEligibilityRequest');
    const items: J[] = Array.isArray(cer?.item) ? cer.item : [];
    const u = { resp: urn(), payer: urn() };
    return {
      resourceType: 'Bundle', id: newId(), type: 'collection', timestamp: formatIstDateTime(this.opts.now()),
      entry: [
        { fullUrl: u.resp, resource: {
          resourceType: 'CoverageEligibilityResponse', status: 'active', purpose: cer?.purpose ?? ['validation'],
          created: formatIstDateTime(this.opts.now()).slice(0, 10), request: { reference: 'CoverageEligibilityRequest/' + (cer?.id ?? '') },
          outcome: 'complete', disposition: 'Policy is in force.', insurer: { reference: u.payer },
          insurance: [{ inforce: true, benefitPeriod: { start: '2026-04-01', end: '2027-03-31' }, item: items.map((it) => ({
            productOrService: it.productOrService,
            benefit: [{ type: { coding: [{ code: 'benefit' }] }, allowedMoney: { value: this.opts.coverageBalance, currency: 'INR' }, usedMoney: { value: 0, currency: 'INR' } }],
            authorizationRequired: true,
            authorizationSupporting: [
              { coding: [{ system: SYSTEM.documentCode, code: 'POI', display: 'Proof of Identity' }] },
              { coding: [{ system: SYSTEM.documentCode, code: 'CER', display: 'Medical Certificate / Doctor Referral' }] },
            ],
          })) }],
        } },
        { fullUrl: u.payer, resource: org('pay', this.payerName) },
      ],
    };
  }

  private claimResponse(claim: J, decision: PayerDecision | 'ack'): FhirBundle {
    const caseNumber = claim?.identifier?.[0]?.value ?? 'UNKNOWN';
    const lines: Array<{ seq: number; net: number }> = (Array.isArray(claim?.item) ? claim.item : []).map((i: J) => ({ seq: i.sequence, net: Number(i.net?.value ?? 0) }));
    const submitted = round2(lines.reduce((s, l) => s + l.net, 0));
    const largest = lines.reduce((m, l) => (l.net > m.net ? l : m), lines[0] ?? { seq: 1, net: 0 });
    const deduction = decision === 'partial' ? Math.min(this.opts.partialDeduction, largest.net) : 0;
    const cat = (code: string, display?: string) => ({ coding: [{ system: 'https://hl7.org/fhir/R4/valueset-adjudication.html', code, ...(display ? { display } : {}) }] });
    const statusCode = { approve: 'approved', partial: 'approved', query: 'queried', reject: 'rejected', ack: 'submitted' }[decision];
    const outcome = { approve: 'complete', partial: 'complete', query: 'partial', reject: 'error', ack: 'queued' }[decision];
    const approved = decision === 'reject' || decision === 'query' || decision === 'ack' ? 0 : round2(submitted - deduction);
    const items = lines.map((l) => {
      const ded = l.seq === largest.seq ? deduction : 0;
      const eligible = decision === 'reject' ? 0 : round2(l.net - ded);
      const adj: J[] = [
        { category: cat('submitted', 'Submitted Amount'), amount: { value: l.net } },
        { category: cat('eligible', 'Eligible Amount'), amount: { value: eligible } },
      ];
      if (ded > 0) adj.push({ category: cat('deductible', 'Deductible'), amount: { value: ded }, reason: { coding: [{ display: 'Non-payable consumables (IRDAI list I)' }] } });
      if (decision === 'reject') adj.push({ category: cat('reason', 'Reason for Adjudication'), reason: { coding: [{ display: 'Package not indicated for the diagnosis' }] } });
      return { itemSequence: l.seq, adjudication: adj };
    });
    const u = { cr: urn(), payer: urn() };
    const cr: FhirResource = {
      resourceType: 'ClaimResponse',
      identifier: [{ type: { coding: [{ system: SYSTEM.identifierType, code: 'CLN', display: 'Claim number' }] }, system: 'https://payer.example', value: caseNumber }],
      status: 'active', use: claim?.use ?? 'preauthorization', created: formatIstDateTime(this.opts.now()),
      outcome, disposition: { approve: 'Approved', partial: 'Approved with deduction', query: 'Share the pre-operative X-ray', reject: 'Rejected', ack: 'Received' }[decision],
      ...(decision === 'approve' || decision === 'partial' ? { preAuthRef: `PA-${caseNumber}` } : {}),
      item: decision === 'ack' ? [] : items,
      adjudication: [{ category: { coding: [{ code: 'status', display: 'Status' }] }, reason: { coding: [{ code: statusCode }] } }],
      total: [
        { category: cat('submitted', 'Submitted Amount'), amount: { value: submitted } },
        { category: cat('benefit', 'Benefit Amount'), amount: { value: approved } },
      ],
      ...(decision === 'reject' ? { error: [{ code: { coding: [{ code: 'PAYR-1009', display: 'Requested items are not valid or not covered' }] } }] } : {}),
    };
    return { resourceType: 'Bundle', id: newId(), type: 'collection', timestamp: formatIstDateTime(this.opts.now()), entry: [
      { fullUrl: u.cr, resource: cr }, { fullUrl: u.payer, resource: org('pay', this.payerName) },
    ] };
  }

  private communicationRequest(claim: J): FhirBundle {
    const caseNumber = claim?.identifier?.[0]?.value ?? 'UNKNOWN';
    const u = { task: urn(), cr: urn(), payer: urn(), provider: urn() };
    return { resourceType: 'Bundle', id: newId(), type: 'collection', timestamp: formatIstDateTime(this.opts.now()), entry: [
      { fullUrl: u.task, resource: { resourceType: 'Task', status: 'requested', intent: 'order', reasonCode: { coding: [{ system: SYSTEM.reasonCode, code: 'additionalinfo' }] }, code: { coding: [{ system: SYSTEM.financialTaskCode, code: 'poll' }] }, input: [{ type: { coding: [{ code: 'include' }] }, valueReference: { reference: u.cr } }] } },
      { fullUrl: u.cr, resource: { resourceType: 'CommunicationRequest', id: u.cr.slice(9), identifier: [{ value: caseNumber }], status: 'active', category: [{ coding: [{ system: SYSTEM.communicationCategory, code: 'alert' }] }], priority: 'routine', payload: [{ contentString: 'Share the pre-operative X-ray and the clinical notes.' }], reasonCode: [{ coding: [{ system: SYSTEM.reasonCode, code: 'additionalinfo' }] }] } },
      { fullUrl: u.payer, resource: org('pay', this.payerName) },
      { fullUrl: u.provider, resource: org('prov', 'Hospital') },
    ] };
  }
}

function safeJson(text: string): J {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
const urn = () => `urn:uuid:${newId()}`;
const org = (type: 'pay' | 'prov', name: string): FhirResource => ({
  resourceType: 'Organization', type: [{ coding: [{ system: SYSTEM.organizationType, code: type }] }], name,
});
function findResource(bundle: J, type: string): J | undefined {
  return (Array.isArray(bundle?.entry) ? bundle.entry : []).map((e: J) => e?.resource).find((r: J) => r?.resourceType === type);
}
