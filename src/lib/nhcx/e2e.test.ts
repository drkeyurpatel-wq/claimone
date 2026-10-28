// Full cashless case against the in-process fake NHCX: eligibility → pre-auth →
// payer query → communication response → approval → enhancement → claim →
// claim response with deduction → payment notice → payment acknowledgement.

import { describe, expect, it } from 'vitest';
import {
  buildClaimSubmissionBundle, buildCommunicationResponseBundle, buildCoverageEligibilityBundle, buildEnhancementBundle,
  buildPaymentAckBundle, buildPreauthBundle,
} from './fhir';
import { createHarness } from './testing/harness';
import { claimInput, coverage, enhancementInput, patient, PAYER_CODE, PHI, preauthInput, provider } from './testing/fixtures';
import type { CallbackOutcome, InboundMessage, ParsedClaimResponse, ParsedCommunicationRequest, ParsedPaymentNotice } from './types';

function accepted(outs: CallbackOutcome[]): InboundMessage[] {
  return outs.map((o) => {
    if (!o.accepted) throw new Error(`callback rejected: ${o.error.code}`);
    expect(o.httpStatus).toBe(202);
    return o.message;
  });
}

describe('end-to-end cashless case via fake NHCX', () => {
  it('runs the whole cycle and every callback is decrypted, validated and parsed', async () => {
    const h = createHarness();
    const payer = { code: coverage.payerCode, name: coverage.payerName };
    const store = (m: InboundMessage) => h.storedApiCallIds.add(m.apiCallId);

    // 1. eligibility
    const elig = await h.client.send('coverageeligibility/check',
      buildCoverageEligibilityBundle({ provider, patient, coverage, purpose: 'benefits', servicedDate: '2026-10-20', items: [{ code: 'NS-MT-01', display: 'Mechanical thrombectomy' }] }),
      PAYER_CODE, { beneficiaryAbha: PHI.abhaDigits });
    let [m] = accepted(await h.fake.deliverAll(h.handle));
    store(m);
    expect(m).toMatchObject({ kind: 'coverage-eligibility-response', correlationId: elig.correlationId, result: { outcome: 'complete', inforce: true, items: [{ code: 'NS-MT-01', benefits: [{ allowed: 500000 }] }] } });

    // 2. pre-auth → payer queries (ClaimResponse wf24 + CommunicationRequest on the same correlation)
    h.fake.decisions.preauth.push('query');
    const pa = await h.client.send('preauth/submit', buildPreauthBundle(preauthInput()), PAYER_CODE, { workflowId: '12', useCase: 'New', beneficiaryAbha: PHI.abhaDigits });
    const [queried, commReq] = accepted(await h.fake.deliverAll(h.handle));
    [queried, commReq].forEach(store);
    expect(queried).toMatchObject({ kind: 'preauth-response', workflowId: '24', hcxStatus: 'response.partial', correlationId: pa.correlationId, result: { decision: 'queried' } });
    expect(commReq).toMatchObject({ kind: 'communication-request', correlationId: pa.correlationId, result: { reasonCode: 'additionalinfo', caseNumber: 'H1-PA-2026-000412' } });
    const query = commReq.result as ParsedCommunicationRequest;
    expect(query.text).toContain('X-ray');

    // 3. answer the query with an attachment → payer approves (wf21)
    await h.client.send('communication/on_request', buildCommunicationResponseBundle({
      provider, payer, request: query, message: 'Pre-operative CT and clinical notes attached.',
      attachments: [{ code: 'RAD', contentType: 'application/pdf', title: 'CT brain', dataBase64: 'JVBERi0xLjQK' }],
    }), PAYER_CODE, { correlationId: commReq.correlationId });
    const answer = h.fake.received.at(-1)!;
    expect(answer.headers).toMatchObject({ 'x-hcx-status': 'response.complete', 'x-hcx-correlation_id': pa.correlationId });
    expect(answer.bundle.entry.find((e: { resource: { resourceType: string } }) => e.resource.resourceType === 'Communication').resource.basedOn[0].reference)
      .toBe(query.communicationRequestFullUrl);
    [m] = accepted(await h.fake.deliverAll(h.handle));
    store(m);
    expect(m).toMatchObject({ kind: 'preauth-response', workflowId: '21', correlationId: pa.correlationId, result: { decision: 'approved', approvedAmount: 322500 } });
    const preAuthRef = (m.result as ParsedClaimResponse).preAuthRef!;
    expect(preAuthRef).toBe('PA-H1-PA-2026-000412');

    // 4. enhancement (wf13, use_case Enhancement) → approved (wf22)
    const enh = await h.client.send('preauth/submit', buildEnhancementBundle(enhancementInput(preAuthRef)), PAYER_CODE, { workflowId: '13', useCase: 'Enhancement' });
    expect(enh.correlationId).not.toBe(pa.correlationId); // each follow-up is its own cycle
    [m] = accepted(await h.fake.deliverAll(h.handle));
    store(m);
    expect(m).toMatchObject({ kind: 'preauth-response', workflowId: '22', correlationId: enh.correlationId, result: { decision: 'approved', approvedAmount: 347500 } });

    // 5. claim (wf15) → acknowledged (wf25) → approved with deduction (wf26)
    const cl = await h.client.send('claim/submit', buildClaimSubmissionBundle(claimInput(preAuthRef)), PAYER_CODE, { workflowId: '15', useCase: 'New' });
    const [ack, decision] = accepted(await h.fake.deliverAll(h.handle));
    [ack, decision].forEach(store);
    expect(ack).toMatchObject({ kind: 'claim-response', workflowId: '25', result: { decision: 'acknowledged' } });
    expect(decision).toMatchObject({ kind: 'claim-response', workflowId: '26', correlationId: cl.correlationId });
    const cr = decision.result as ParsedClaimResponse;
    expect(cr).toMatchObject({
      use: 'claim', decision: 'partially_approved', claimedAmount: 365950.5, approvedAmount: 363450.5, deductionAmount: 2500,
      deductions: [{ itemSequence: 1, amount: 2500, reason: 'Non-payable consumables (IRDAI list I)' }],
    });
    expect(cr.deductionAmount).toBe(cr.claimedAmount! - cr.approvedAmount!); // deduction = claimed − approved

    // 6. payer settles (wf33) → notice parsed → business ack (wf17, response.complete, same correlation)
    const tds = 36345.05;
    const pnCorr = await h.fake.sendPaymentNotice({ caseNumber: 'H1-PA-2026-000412', approved: cr.approvedAmount!, tds, utr: 'HDFCN52026102812345' });
    [m] = accepted(await h.fake.deliverAll(h.handle));
    store(m);
    expect(m).toMatchObject({ kind: 'payment-notice', workflowId: '33', correlationId: pnCorr });
    const pn = m.result as ParsedPaymentNotice;
    expect(pn).toMatchObject({ utr: 'HDFCN52026102812345', tdsAmount: tds, netAmount: 327105.45, approvedAmount: 363450.5, reconciles: true });
    expect(pn.netAmount).toBeCloseTo(cr.approvedAmount! - tds, 2); // net = approved − TDS

    const ackRes = await h.client.send('paymentnotice/on_request', buildPaymentAckBundle({ provider, payer, caseNumber: pn.caseNumber! }), PAYER_CODE, { correlationId: m.correlationId });
    expect(ackRes.workflowId).toBe('17');
    const sentAck = h.fake.received.at(-1)!;
    expect(sentAck).toMatchObject({ path: 'paymentnotice/on_request', decrypted: true, headers: { 'x-hcx-status': 'response.complete', 'x-hcx-correlation_id': pnCorr } });

    // nothing left undelivered, nothing refused
    expect(h.fake.outbox).toHaveLength(0);
    expect(h.fake.calls.filter((c) => c.status >= 400)).toEqual([]);
    expect(h.fake.received.every((r) => r.decrypted)).toBe(true);
  });

  it('rejection and PMJAY-style query answer on the pre-auth path (wf19)', async () => {
    const h = createHarness();
    h.fake.decisions.preauth.push('reject');
    await h.client.send('preauth/submit', buildPreauthBundle(preauthInput()), PAYER_CODE);
    let [m] = accepted(await h.fake.deliverAll(h.handle));
    expect(m).toMatchObject({ workflowId: '23', result: { decision: 'rejected', approvedAmount: 0, errors: [{ code: 'PAYR-1009' }] } });

    h.fake.decisions.preauth.push('query');
    await h.client.send('preauth/submit', buildPreauthBundle(preauthInput({ caseNumber: 'H1-PA-2026-000413' })), PAYER_CODE);
    await h.fake.deliverAll(h.handle);
    const ans = await h.client.send('preauth/submit', buildPreauthBundle(preauthInput({ caseNumber: 'H1-PA-2026-000413', queryAnswerRemarks: 'Documents attached' })), PAYER_CODE, { workflowId: '19', useCase: 'Resubmit' });
    expect(h.fake.received.at(-1)!.headers['x-hcx-status']).toBe('request.initiated'); // NHCX-1011 otherwise
    [m] = accepted(await h.fake.deliverAll(h.handle));
    expect(m).toMatchObject({ workflowId: '21', correlationId: ans.correlationId, result: { decision: 'approved' } });
  });

  it('a payer that cannot decrypt answers with a ProtocolResponse error the handler surfaces', async () => {
    const h = createHarness();
    // Poison the cached payer key with someone else's: the payer cannot open the letter.
    const wrong = createHarness().providerKeys.certificatePem;
    const client = h.client as unknown as { certCache: Map<string, { key: CryptoKey; expiresAt: number }> };
    const { importRecipientKey } = await import('./jwe');
    client.certCache.set(PAYER_CODE, { key: await importRecipientKey(wrong, 'RSA-OAEP-256'), expiresAt: Date.now() * 2 });
    const sent = await h.client.send('preauth/submit', buildPreauthBundle(preauthInput()), PAYER_CODE);
    const [m] = accepted(await h.fake.deliverAll(h.handle));
    expect(m).toMatchObject({ kind: 'protocol-error', correlationId: sent.correlationId, hcxStatus: 'response.error', errorDetails: { code: 'ERR_INVALID_ENCRYPTION' } });
  });
});
