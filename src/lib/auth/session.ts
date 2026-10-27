// The one seam to replace when the common login (H1 Identity, built with
// HRMS) goes live: everything else asks this file who the user is.
import { createClient } from '@/lib/supabase/server';
import type { Role } from '@/lib/claims/types';

export interface Centre { id: string; code: string; name: string }
export interface Session {
  userId: string;
  tenantId: string;
  fullName: string;
  role: Role;
  centres: Centre[];
}

export async function getSession(): Promise<Session | null> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from('clm_user_profiles')
    .select('tenant_id, full_name, role, is_active')
    .eq('user_id', user.id)
    .maybeSingle();
  if (!profile || !profile.is_active) return null;

  // RLS already limits centres to the ones this user may see.
  const { data: centres } = await supabase
    .from('clm_centres').select('id, code, name').eq('is_active', true).order('name');

  return {
    userId: user.id,
    tenantId: profile.tenant_id,
    fullName: profile.full_name,
    role: profile.role as Role,
    centres: centres ?? [],
  };
}

export const canWrite = (r: Role) => r === 'admin' || r === 'manager' || r === 'desk';
export const isManager = (r: Role) => r === 'admin' || r === 'manager';
