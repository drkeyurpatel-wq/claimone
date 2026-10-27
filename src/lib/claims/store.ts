'use client';
// ClaimOne — shared claims state (H1 Claims' Zustand store + Realtime),
// now feeding ClaimOne's readiness engine on the detail page.

import { create } from 'zustand';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { sb } from '@/lib/supabase/browser';
import * as api from './api';
import type { Claim, ClaimDocument, ClaimQuery, ClaimStatus, ClaimType, DocRuleRow, OpenQuery, Payer, TimelineEvent } from './types';

interface Filters { statuses?: ClaimStatus[]; payer_id?: string; claim_type?: ClaimType; search?: string }

interface ClaimsState {
  centreId: string | null;
  stats: api.ClaimStats | null;
  payers: Payer[];
  claims: Claim[];
  claimsLoading: boolean;
  lastFilters: Filters;

  activeClaim: Claim | null;
  activeTimeline: TimelineEvent[];
  activeQueries: ClaimQuery[];
  activeDocuments: ClaimDocument[];
  activeRules: DocRuleRow[];
  detailLoading: boolean;

  openQueries: OpenQuery[];
  rejected: Claim[];
  queriesLoading: boolean;

  channel: RealtimeChannel | null;
  lastUpdate: number;

  init: (centreId: string) => Promise<void>;
  refreshStats: () => Promise<void>;
  loadClaims: (f?: Filters) => Promise<void>;
  loadClaimDetail: (claimId: string) => Promise<void>;
  loadQueryCentre: () => Promise<void>;
  afterMutation: (claimId?: string) => Promise<void>;
  teardown: () => void;
}

export const useClaimsStore = create<ClaimsState>((set, get) => ({
  centreId: null,
  stats: null,
  payers: [],
  claims: [],
  claimsLoading: false,
  lastFilters: {},
  activeClaim: null,
  activeTimeline: [],
  activeQueries: [],
  activeDocuments: [],
  activeRules: [],
  detailLoading: false,
  openQueries: [],
  rejected: [],
  queriesLoading: false,
  channel: null,
  lastUpdate: 0,

  init: async (centreId) => {
    if (get().centreId === centreId && get().payers.length) return;
    set({ centreId, claims: [], stats: null });
    const [stats, payers] = await Promise.all([api.fetchClaimStats(centreId), api.fetchPayers()]);
    set({ stats, payers });
    subscribe(centreId);
  },

  refreshStats: async () => {
    const { centreId } = get();
    if (centreId) set({ stats: await api.fetchClaimStats(centreId) });
  },

  loadClaims: async (f = {}) => {
    const { centreId } = get();
    if (!centreId) return;
    set({ claimsLoading: true, lastFilters: f });
    const claims = await api.fetchClaims(centreId, f);
    set({ claims, claimsLoading: false });
  },

  loadClaimDetail: async (claimId) => {
    set({ detailLoading: true });
    const claim = await api.fetchClaim(claimId);
    const [timeline, queries, documents, rules] = await Promise.all([
      api.fetchClaimTimeline(claimId),
      api.fetchClaimQueries(claimId),
      api.fetchClaimDocuments(claimId),
      claim ? api.fetchDocRules(claim.payer_id) : Promise.resolve([]),
    ]);
    set({
      activeClaim: claim, activeTimeline: timeline, activeQueries: queries,
      activeDocuments: documents, activeRules: rules, detailLoading: false,
    });
  },

  loadQueryCentre: async () => {
    const { centreId } = get();
    if (!centreId) return;
    set({ queriesLoading: true });
    const [openQueries, rejected] = await Promise.all([api.fetchOpenQueries(centreId), api.fetchRejectedClaims(centreId)]);
    set({ openQueries, rejected, queriesLoading: false });
  },

  afterMutation: async (claimId) => {
    await Promise.all([
      get().refreshStats(),
      claimId && get().activeClaim?.id === claimId ? get().loadClaimDetail(claimId) : Promise.resolve(),
    ]);
  },

  teardown: () => {
    get().channel?.unsubscribe();
    set({ channel: null });
  },
}));

// Realtime: bot updates and colleagues' changes appear within ~2 seconds.
function subscribe(centreId: string) {
  const { channel, refreshStats, loadClaimDetail, loadQueryCentre } = useClaimsStore.getState();
  channel?.unsubscribe();
  const debounce = (fn: () => void) => {
    const now = Date.now();
    if (now - useClaimsStore.getState().lastUpdate < 2000) return;
    useClaimsStore.setState({ lastUpdate: now });
    fn();
  };
  const ch = sb()
    .channel(`claims-${centreId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'clm_claims', filter: `centre_id=eq.${centreId}` }, (payload: { new: unknown; old: unknown }) => {
      debounce(() => {
        refreshStats();
        const id = (payload.new as { id?: string })?.id ?? (payload.old as { id?: string })?.id;
        if (id && useClaimsStore.getState().activeClaim?.id === id) loadClaimDetail(id);
      });
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'clm_queries' }, () => debounce(() => loadQueryCentre()))
    .subscribe();
  useClaimsStore.setState({ channel: ch });
}
