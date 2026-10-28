'use client';
// Temporary email + password login until the common login (H1 Identity) exists.
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ShieldCheck, Loader2 } from 'lucide-react';
import { sb } from '@/lib/supabase/browser';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    const { error } = await sb().auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) { setError('Email or password is wrong.'); return; }
    const next = params.get('next');
    router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : '/');
    router.refresh();
  };

  return (
    <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
      <div className="mb-6 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal-600">
          <ShieldCheck className="h-5 w-5 text-white" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-slate-900">ClaimOne</h1>
          <p className="text-xs text-slate-500">Insurance claims desk</p>
        </div>
      </div>
      <label className="block text-xs font-semibold text-slate-600">Email</label>
      <input type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)}
        className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100" />
      <label className="mt-4 block text-xs font-semibold text-slate-600">Password</label>
      <input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)}
        className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100" />
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      <button disabled={busy} className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-teal-600 py-2.5 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-60">
        {busy && <Loader2 className="h-4 w-4 animate-spin" />} Sign in
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <Suspense><LoginForm /></Suspense>
    </main>
  );
}
