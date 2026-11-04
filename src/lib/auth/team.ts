'use client';
// Setup → Team: who has a login, approve Administrative signups, switch off staff who leave.
import { sb } from '@/lib/supabase/browser';

export interface TeamMember {
  user_id: string; full_name: string; mobile: string | null; role: string; workspace: string | null; is_active: boolean; joined: string;
}

export async function fetchTeam(): Promise<TeamMember[]> {
  const { data, error } = await sb().rpc('clm_team');
  if (error) throw new Error(error.message);
  return (data ?? []) as TeamMember[];
}

export async function setStaff(userId: string, change: { role?: 'manager' | 'desk'; active?: boolean }) {
  const { error } = await sb().rpc('clm_set_staff', { p_user: userId, p_role: change.role ?? null, p_active: change.active ?? null });
  if (error) throw new Error(error.message);
}

/** Waiting for approval: signed up as Administrative, still desk staff. */
export const isPending = (m: TeamMember) => m.is_active && m.workspace === 'admin' && m.role === 'desk';

export const DESK_LABEL: Record<string, string> = { admission: 'Admission & pre-auth', claims: 'Claims & bills', payments: 'Payments', admin: 'Administrative' };
export const ROLE_LABEL: Record<string, string> = { admin: 'Admin', manager: 'Manager', desk: 'Desk', viewer: 'View only' };
