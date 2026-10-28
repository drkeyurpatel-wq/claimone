// CLAUDE.md: no patient data in logs or error messages. Drive every failure path
// with a bundle full of patient identifiers and check nothing leaks into thrown
// errors, logger output, console, or the acknowledgement bodies we return.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildClaimSubmissionBundle, buildPreauthBundle, parseClaimResponse } from './fhir';
import { buildProtocolHeaders, encryptPayload, formatIstDateTime, importRecipientKey } from './jwe';
import { createHarness } from './testing/harness';
import { claimInput, patient, PAYER_CODE, PHI, preauthInput, PROVIDER_CODE } from './testing/fixtures';

const NEEDLES = [PHI.name, 'Savitaben', 'Zalavadia', PHI.mobile, PHI.abhaHyphenated, PHI.abhaDigits, PHI.abhaAddress, PHI.uhid];

function assertClean(label: string, text: string): void {
  for (const n of NEEDLES) {
    if (text.includes(n)) throw new Error(`${label} leaks a patient identifier`);
  }
}
const describeError = (e: unknown) => {
  const err = e as Error & Record<string, unknown>;
  return [String(err), err?.message, err?.stack, JSON.stringify(err, Object.getOwnPropertyNames(err ?? {}))].join('\n');
};

describe('no patient data in errors, logs or acknowledgements', () => {
  const consoleCalls: string[] = [];
  beforeEach(() => {
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { consoleCalls.push(args.map(String).join(' ')); });
    }
  });
  afterEach(() => vi.restoreAllMocks());

  it('client failure paths', async () => {
    const h = createHarness({ client: { requestTimeoutMs: 20 } });
    const errors: unknown[] = [];
    const bundle = buildPreauthBundle(preauthInput());
    const attempt = async (fn: () => Promise<unknown>) => { try { await fn(); errors.push(new Error('expected failure')); } catch (e) { errors.push(e); } };

    await attempt(() => h.client.send('preauth/submit', bundle, PAYER_CODE, { status: 'response.complete' })); // 4xx
    h.fake.failNext.push(503, 503, 503, 503);
    await attempt(() => h.client.send('preauth/submit', bundle, PAYER_CODE)); // 5xx exhausted
    h.fake.hangNext.push(500, 500, 500, 500);
    await attempt(() => h.client.send('claim/submit', buildClaimSubmissionBundle(claimInput('PA-1')), PAYER_CODE)); // timeouts
    await attempt(() => h.client.send('preauth/submit', bundle, '777@hcx')); // registry refusal
    await attempt(() => h.client.send('preauth/submit', bundle, PAYER_CODE, { beneficiaryAbha: PHI.abhaDigits.slice(0, 9) })); // bad ABHA
    await attempt(() => h.client.send('communication/on_request', bundle, PAYER_CODE)); // missing correlation
    await attempt(async () => buildPreauthBundle(preauthInput({ patient: { ...patient, mobile: `${PHI.mobile}99999` } })));
    await attempt(async () => buildPreauthBundle(preauthInput({ patient: { ...patient, abhaNumber: `${PHI.abhaDigits}1` } })));
    await attempt(async () => buildPreauthBundle(preauthInput({ patient: { ...patient, abhaAddress: `${PHI.name}@@abdm` } })));
    await attempt(async () => buildPreauthBundle(preauthInput({ patient: { ...patient, gender: PHI.name as never } })));

    expect(errors).toHaveLength(10);
    errors.forEach((e, i) => {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).not.toBe('expected failure');
      assertClean(`error #${i}`, describeError(e));
    });
    assertClean('logs', h.logs.join('\n'));
    assertClean('console', consoleCalls.join('\n'));
  });

  it('callback rejection paths and a full successful run', async () => {
    const h = createHarness();
    const cert = h.providerKeys.certificatePem;
    const patientBundle = {
      resourceType: 'Bundle', type: 'collection',
      entry: [{ fullUrl: 'urn:uuid:p', resource: { resourceType: 'Patient', name: [{ text: PHI.name }], telecom: [{ value: PHI.mobile }], identifier: [{ value: PHI.abhaHyphenated }] } }],
    };
    const seal = async (over: Record<string, unknown> = {}, payload: unknown = patientBundle) => {
      const headers = { ...buildProtocolHeaders({ senderCode: PAYER_CODE, recipientCode: PROVIDER_CODE, status: 'response.complete', correlationId: crypto.randomUUID(), timestamp: h.clock.now, beneficiaryAbha: PHI.abhaDigits }), ...over };
      return { payload: await encryptPayload({ payload, recipientKey: await importRecipientKey(cert, 'RSA-OAEP-256'), headers }) };
    };
    const outcomes = [
      await h.handle({ path: '/v1/claim/on_submit', body: await seal() }), // wrong domain payload
      await h.handle({ path: '/v1/claim/on_submit', body: await seal({ 'x-hcx-recipient_code': '1@hcx' }) }),
      await h.handle({ path: '/v1/claim/on_submit', body: await seal({ 'x-hcx-timestamp': formatIstDateTime(new Date(0)) }) }),
      await h.handle({ path: '/v1/claim/on_submit', body: { payload: (await seal()).payload.replace(/\.[^.]{4}/, '.AAAA') } }),
      await h.handle({ path: '/v1/claim/on_submit', body: `{"name":"${PHI.name}"` }),
      await h.handle({ path: `/v1/${PHI.mobile}/on_submit`, body: '{}' }),
    ];
    expect(outcomes.every((o) => !o.accepted)).toBe(true);
    outcomes.forEach((o, i) => assertClean(`ack #${i}`, JSON.stringify(o)));

    // parser error on a PHI-laden bundle
    try { parseClaimResponse(patientBundle); } catch (e) { assertClean('parser error', describeError(e)); }

    // success path: logs carry ids only
    h.fake.decisions.preauth.push('query');
    await h.client.send('preauth/submit', buildPreauthBundle(preauthInput()), PAYER_CODE, { beneficiaryAbha: PHI.abhaDigits });
    const delivered = await h.fake.deliverAll(h.handle);
    expect(delivered.every((d) => d.accepted)).toBe(true);
    delivered.forEach((d, i) => assertClean(`success ack #${i}`, JSON.stringify(d.body)));

    expect(h.logs.length).toBeGreaterThan(5);
    assertClean('logs', h.logs.join('\n'));
    assertClean('console', consoleCalls.join('\n'));
  });
});
