import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[] = [];
let unmet: { doc_label: string; doc_status: string }[] = [];
let claim: Record<string, unknown>;
let canWrite = true;
const inserts: Record<string, unknown>[] = [];
const fake = {
  from: (t: string) => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: t === 'clm_claims' ? claim : { nhcx_participant_code: '1000004446@hcx' }, error: null }) }) }),
    insert: async (row: Record<string, unknown>) => { calls.push(`log:${row.status}`); inserts.push(row); return { error: null }; },
  }),
  rpc: async (fn: string, args: Record<string, unknown>) => {
    if (fn === 'clm_can_write') return { data: canWrite, error: null };
    calls.push(fn === 'clm_transition' ? `move:${args.p_to_status}` : 'docs');
    return fn === 'clm_unmet_mandatory_docs' ? { data: unmet, error: null } : { data: { status: args.p_to_status }, error: null };
  },
};
vi.mock('@/lib/api/route', async (orig) => ({ ...(await orig<typeof import('@/lib/api/route')>()), requireUser: async () => ({ supabase: fake, user: { id: 'u' } }) }));
const send = vi.fn(async () => { calls.push('send'); return { apiCallId: 'a1', correlationId: 'c1', workflowId: '12', httpStatus: 202, attempts: 1 }; });
vi.mock('@/lib/nhcx', async (orig) => ({ ...(await orig<typeof import('@/lib/nhcx')>()), NhcxClient: class { send = send; } }));

const ready = {
  id: '6f9619ff-8b86-4011-b42d-00c04fc964ff', tenant_id: 't', centre_id: 'ctr', status: 'draft', claim_number: 'CLM-SHJ-1', claim_type: 'cashless',
  patient_name: 'P', patient_uhid: 'U1', patient_gender: 'male', patient_age_years: 60, policy_number: 'POL', member_id: 'M', icd_code: 'I63.9',
  primary_diagnosis: 'Stroke', treating_doctor_name: 'Dr A', treating_doctor_hpr_id: '71-8422-5818-7201', admitted_at: '2026-10-27T10:00:00+05:30',
  estimated_amount: 200000, clm_payers: { id: 'p', code: 'tata_aig', name: 'Tata AIG', type: 'insurer', nhcx_code: '1000003538@hcx', is_nhcx_live: true },
};
const post = async (body: unknown) => (await import('./route')).POST(new Request('https://x/api/nhcx/send', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  calls.length = 0; inserts.length = 0; unmet = []; claim = { ...ready }; canWrite = true;
  Object.assign(process.env, { NHCX_PARTICIPANT_CODE: '1000004446@hcx', NHCX_HFR_ID: 'IN24', NHCX_PROVIDER_NAME: 'H1', NHCX_CLIENT_ID: 'c',
    NHCX_CLIENT_SECRET: 's', NHCX_PRIVATE_KEY: 'k', NHCX_CALLBACK_SECRET: 'x'.repeat(40) });
});

describe('send on NHCX', () => {
  it('checks papers, sends, logs, then moves the case', async () => {
    const r = await post({ claimId: ready.id, kind: 'preauth' });
    expect(r.status).toBe(200);
    expect(calls).toEqual(['docs', 'send', 'log:sent', 'move:preauth_pending']);
    expect(inserts[0]).toMatchObject({ direction: 'out', api_call: 'preauth', api_call_id: 'a1', correlation_id: 'c1', summary: { amount: 200000 } });
    expect(JSON.stringify(inserts[0])).not.toContain('Stroke');
  });
  it('missing details: nothing is sent', async () => {
    claim = { ...ready, member_id: null };
    const r = await post({ claimId: ready.id, kind: 'preauth' });
    expect(r.status).toBe(422);
    expect((await r.json()).blockers).toEqual(['Member / card ID']);
    expect(calls).toEqual([]);
  });
  it('unverified papers: nothing is sent', async () => {
    unmet = [{ doc_label: 'Patient photo ID', doc_status: 'missing' }];
    const r = await post({ claimId: ready.id, kind: 'preauth' });
    expect(r.status).toBe(422);
    expect(calls).toEqual(['docs']);
  });
  it('a case at another step is refused', async () => {
    claim = { ...ready, status: 'claim_submitted' };
    expect((await post({ claimId: ready.id, kind: 'preauth' })).status).toBe(409);
  });
  it('a view-only login cannot send anything', async () => {
    canWrite = false;
    expect((await post({ claimId: ready.id, kind: 'preauth' })).status).toBe(403);
    expect(calls).toEqual([]);
  });
  it('without NHCX settings it says to use the website', async () => {
    delete process.env.NHCX_PRIVATE_KEY;
    expect((await post({ claimId: ready.id, kind: 'preauth' })).status).toBe(503);
  });
});
