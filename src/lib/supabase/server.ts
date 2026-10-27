// Server Supabase client for route handlers and server components.
//
// Deliberately the ANON key: every query runs as the signed-in user, so
// row-level security keeps tenants and centres apart. Swapping in the
// service-role key "to fix a permissions error" would silently remove every
// tenant boundary — fix the policy instead.
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { supabaseEnv } from './env';

type CookieToSet = { name: string; value: string; options: CookieOptions };

export async function createClient() {
  const { url, anonKey } = supabaseEnv();
  const store = await cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list: CookieToSet[]) => {
        try { list.forEach(({ name, value, options }) => store.set(name, value, options)); }
        catch { /* called from a server component — middleware refreshes the session */ }
      },
    },
  });
}
