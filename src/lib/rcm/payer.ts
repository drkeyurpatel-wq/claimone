import type { ClaimType, Payer, PayerChannel } from '@/lib/claims/types';

/** Same rule as clm_claim_type_for() in 0013_rcm.sql. */
export function claimTypeFor(p: Pick<Payer, 'code' | 'type'>): ClaimType {
  if (p.code.startsWith('pmjay')) return 'pmjay';
  if (p.code === 'cghs') return 'cghs';
  if (p.code === 'echs') return 'echs';
  if (p.code === 'esic') return 'state_scheme';
  if (p.type === 'corporate') return 'corporate';
  return 'cashless';
}

export type Route = 'nhcx' | PayerChannel;

/** NHCX when both the payer and this centre are on it; otherwise the payer's usual way. */
export function routeFor(p: { is_nhcx_live?: boolean; nhcx_code?: string | null; channel?: PayerChannel } | null | undefined,
  centreOnNhcx: boolean): Route {
  if (p?.is_nhcx_live && p.nhcx_code && centreOnNhcx) return 'nhcx';
  return p?.channel ?? 'portal';
}

export const ROUTE_WORDS: Record<Route, { label: string; sent: string }> = {
  nhcx: { label: 'NHCX', sent: 'Send on NHCX' },
  portal: { label: 'TPA / insurer website', sent: 'I have sent it on the website' },
  email: { label: 'Email', sent: 'I have sent the email' },
  tms: { label: 'TMS (PMJAY)', sent: 'I have filed it in TMS' },
  direct: { label: 'Given to the company', sent: 'I have sent the bill' },
};
