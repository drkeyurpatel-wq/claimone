'use client';
// Staff sign in with mobile number + 6-digit PIN, and create their own login with the team code.
// Admins can still type an email address and password in the same box.
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ShieldCheck, Loader2 } from 'lucide-react';
import { sb } from '@/lib/supabase/browser';

const digits = (s: string) => s.replace(/\D/g, '');
const loginEmail = (id: string) => (id.includes('@') ? id.trim() : `${digits(id).slice(-10)}@claimone.local`);

const DESKS = [
  { key: 'admission', label: 'Admission & pre-auth' },
  { key: 'claims', label: 'Claims & bills' },
  { key: 'payments', label: 'Payments' },
] as const;

const input =
  'mt-1 w-full rounded-lg border border-slate-200 px-3 py-2.5 text-base focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100';
const label = 'mt-4 block text-sm font-semibold text-slate-600';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [mode, setMode] = useState<'in' | 'new'>(params.get('new') ? 'new' : 'in');
  const [id, setId] = useState('');
  const [pin, setPin] = useState('');
  const [name, setName] = useState('');
  const [pin2, setPin2] = useState('');
  const [desk, setDesk] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const go = () => {
    const next = params.get('next');
    router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : '/');
    router.refresh();
  };

  const signIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    const { error } = await sb().auth.signInWithPassword({ email: loginEmail(id), password: pin });
    setBusy(false);
    if (error) { setError('Mobile number or PIN is wrong.'); return; }
    go();
  };

  const register = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (digits(id).length !== 10) return setError('Enter your 10-digit mobile number.');
    if (!/^\d{6}$/.test(pin)) return setError('PIN must be 6 digits.');
    if (pin !== pin2) return setError('The two PINs do not match.');
    if (!desk) return setError('Choose your desk.');
    setBusy(true);
    const { error } = await sb().rpc('clm_self_register', {
      p_name: name, p_mobile: digits(id), p_pin: pin, p_desk: desk, p_code: code,
    });
    if (error) { setBusy(false); setError(error.message || 'Could not create your login.'); return; }
    const res = await sb().auth.signInWithPassword({ email: loginEmail(id), password: pin });
    setBusy(false);
    if (res.error) { setMode('in'); setError('Login created. Sign in with your mobile and PIN.'); return; }
    go();
  };

  const pinInput = (value: string, set: (v: string) => void, auto: string) => (
    <input type="password" inputMode="numeric" autoComplete={auto} maxLength={6} required value={value}
      onChange={(e) => set(digits(e.target.value).slice(0, 6))} className={`${input} tracking-[0.4em]`} />
  );

  return (
    <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-7 shadow-sm">
      <div className="mb-5 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal-600">
          <ShieldCheck className="h-5 w-5 text-white" />
        </div>
        <div>
          <h1 className="text-lg font-bold text-slate-900">ClaimOne</h1>
          <p className="text-xs text-slate-500">Health1 insurance claims desk</p>
        </div>
      </div>

      <div className="mb-2 grid grid-cols-2 rounded-lg bg-slate-100 p-1 text-sm font-semibold">
        {(['in', 'new'] as const).map((m) => (
          <button key={m} type="button" onClick={() => { setMode(m); setError(''); }}
            className={`rounded-md py-2 ${mode === m ? 'bg-white text-teal-700 shadow-sm' : 'text-slate-500'}`}>
            {m === 'in' ? 'Sign in' : 'New user'}
          </button>
        ))}
      </div>

      {mode === 'in' ? (
        <form onSubmit={signIn}>
          <label className={label}>Mobile number</label>
          <input type="text" inputMode="tel" required autoComplete="username" value={id}
            onChange={(e) => setId(e.target.value)} className={input} />
          {id.includes('@') ? (
            <>
              <label className={label}>Password</label>
              <input type="password" required autoComplete="current-password" value={pin}
                onChange={(e) => setPin(e.target.value)} className={input} />
            </>
          ) : (
            <>
              <label className={label}>PIN</label>
              {pinInput(pin, setPin, 'current-password')}
            </>
          )}
          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
          <button disabled={busy} className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-teal-600 py-3 text-base font-semibold text-white hover:bg-teal-700 disabled:opacity-60">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Sign in
          </button>
          <p className="mt-4 text-center text-sm text-slate-500">
            First time? <button type="button" onClick={() => { setMode('new'); setError(''); }} className="font-semibold text-teal-700">Create your login</button>
          </p>
        </form>
      ) : (
        <form onSubmit={register}>
          <label className={label}>Your full name</label>
          <input type="text" required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} className={input} />
          <label className={label}>Mobile number</label>
          <input type="text" inputMode="tel" required autoComplete="username" value={id}
            onChange={(e) => setId(digits(e.target.value).slice(0, 10))} className={input} />
          <label className={label}>Choose a 6-digit PIN</label>
          {pinInput(pin, setPin, 'new-password')}
          <label className={label}>Type the PIN again</label>
          {pinInput(pin2, setPin2, 'new-password')}
          <label className={label}>Your desk</label>
          <div className="mt-1 grid gap-2">
            {DESKS.map((d) => (
              <button key={d.key} type="button" onClick={() => setDesk(d.key)}
                className={`rounded-lg border px-3 py-2.5 text-left text-sm font-semibold ${desk === d.key ? 'border-teal-600 bg-teal-50 text-teal-800' : 'border-slate-200 text-slate-700'}`}>
                {d.label}
              </button>
            ))}
          </div>
          <label className={label}>Team code</label>
          <input type="text" required autoCapitalize="characters" value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())} className={`${input} tracking-widest`} />
          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
          <button disabled={busy} className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-teal-600 py-3 text-base font-semibold text-white hover:bg-teal-700 disabled:opacity-60">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Create login
          </button>
        </form>
      )}
    </div>
  );
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-8">
      <Suspense><LoginForm /></Suspense>
    </main>
  );
}
