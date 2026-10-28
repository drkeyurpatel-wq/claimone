import { describe, expect, it } from 'vitest';
import { claimTypeFor, routeFor } from './payer';

describe('payer rules', () => {
  it('claim type follows the payer, like the database', () => {
    expect(claimTypeFor({ code: 'pmjay_gujarat', type: 'government' })).toBe('pmjay');
    expect(claimTypeFor({ code: 'esic', type: 'government' })).toBe('state_scheme');
    expect(claimTypeFor({ code: 'pgvcl', type: 'corporate' })).toBe('corporate');
    expect(claimTypeFor({ code: 'medi_assist', type: 'tpa' })).toBe('cashless');
  });
  it('NHCX only when both sides are on it', () => {
    const live = { is_nhcx_live: true, nhcx_code: '1000@hcx', channel: 'portal' as const };
    expect(routeFor(live, true)).toBe('nhcx');
    expect(routeFor(live, false)).toBe('portal');
    expect(routeFor({ ...live, nhcx_code: null }, true)).toBe('portal');
    expect(routeFor({ channel: 'tms' }, true)).toBe('tms');
    expect(routeFor(null, true)).toBe('portal');
  });
});
