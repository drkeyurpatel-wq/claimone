'use client';
// Browser Supabase client (anon key + the signed-in user's session; RLS applies).
import { createBrowserClient } from '@supabase/ssr';
import { supabaseEnv } from './env';

let instance: ReturnType<typeof createBrowserClient> | null = null;

export function sb() {
  if (!instance) {
    const { url, anonKey } = supabaseEnv();
    instance = createBrowserClient(url, anonKey);
  }
  return instance;
}
