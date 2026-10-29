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
  portal: { label: 'Payer portal', sent: 'Submitted on payer portal' },
  email: { label: 'Email', sent: 'Submitted by email' },
  tms: { label: 'TMS (PMJAY)', sent: 'Submitted on TMS' },
  direct: { label: 'Direct to corporate', sent: 'Bill sent to corporate' },
};

/** The first choice on a new admission: what kind of payer, before which one. */
export type PayerGroup = 'pmjay' | 'scheme' | 'tpa' | 'insurer' | 'corporate';
export const PAYER_GROUPS: { key: PayerGroup; label: string; hint: string }[] = [
  { key: 'pmjay', label: 'PMJAY / MA', hint: 'Ayushman Bharat & state scheme' },
  { key: 'scheme', label: 'Govt. scheme', hint: 'CGHS · ECHS · ESIC' },
  { key: 'tpa', label: 'TPA', hint: 'Third-party administrator' },
  { key: 'insurer', label: 'Insurance company', hint: 'Direct cashless, incl. PSU' },
  { key: 'corporate', label: 'Corporate', hint: 'Company credit' },
];

export function payerGroup(p: Pick<Payer, 'code' | 'type'>): PayerGroup {
  if (p.code.startsWith('pmjay')) return 'pmjay';
  if (p.type === 'government') return 'scheme';
  if (p.type === 'tpa') return 'tpa';
  if (p.type === 'corporate') return 'corporate';
  return 'insurer'; // private and PSU insurers
}
