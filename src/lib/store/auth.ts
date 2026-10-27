'use client';
// Client-side view of the session. Keeps the shape the H1 Claims pages used
// (staff, activeCentreId) so they port with minimal change.
import { create } from 'zustand';
import type { Centre } from '@/lib/auth/session';
import type { Role } from '@/lib/claims/types';

interface AuthState {
  staff: { id: string; full_name: string; role: Role } | null;
  tenantId: string | null;
  centres: Centre[];
  activeCentreId: string | null;
  hydrate: (s: { userId: string; fullName: string; role: Role; tenantId: string; centres: Centre[] }) => void;
  setActiveCentre: (id: string) => void;
}

const KEY = 'claimone.centre';

export const useAuthStore = create<AuthState>((set) => ({
  staff: null,
  tenantId: null,
  centres: [],
  activeCentreId: null,
  hydrate: (s) => {
    let saved: string | null = null;
    try { saved = localStorage.getItem(KEY); } catch { /* private mode */ }
    const active = s.centres.find((c) => c.id === saved)?.id ?? s.centres[0]?.id ?? null;
    set({
      staff: { id: s.userId, full_name: s.fullName, role: s.role },
      tenantId: s.tenantId,
      centres: s.centres,
      activeCentreId: active,
    });
  },
  setActiveCentre: (id) => {
    try { localStorage.setItem(KEY, id); } catch { /* ignore */ }
    set({ activeCentreId: id });
  },
}));
