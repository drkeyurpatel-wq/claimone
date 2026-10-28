'use client';
// Change your own password. The current password is checked first, so an
// unattended logged-in screen cannot be used to take over the login.
import { useState } from 'react';
import { Loader2, KeyRound, CheckCircle2 } from 'lucide-react';
import { sb } from '@/lib/supabase/browser';
import { useAuthStore } from '@/lib/store/auth';

const field = 'mt-1 min-h-12 w-full rounded-lg border border-slate-300 px-3 text-base focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100';

export default function Account() {
  const name = useAuthStore((s) => s.staff?.full_name);
  const [cur, setCur] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg(null);
    if (pw.length < 10) { setMsg({ ok: false, text: 'Use at least 10 characters.' }); return; }
    if (pw !== pw2) { setMsg({ ok: false, text: 'The two new passwords are not the same.' }); return; }
    if (pw === cur) { setMsg({ ok: false, text: 'The new password must be different.' }); return; }
    setBusy(true);
    const { data: { user } } = await sb().auth.getUser();
    const email = user?.email;
    const check = email ? await sb().auth.signInWithPassword({ email, password: cur }) : { error: new Error('x') };
    if (check.error) { setBusy(false); setMsg({ ok: false, text: 'Current password is wrong.' }); return; }
    const { error } = await sb().auth.updateUser({ password: pw });
    setBusy(false);
    if (error) { setMsg({ ok: false, text: /weak|pwned|leaked/i.test(error.message) ? 'That password is too common. Choose another.' : 'Could not change the password. Try again.' }); return; }
    setCur(''); setPw(''); setPw2('');
    setMsg({ ok: true, text: 'Password changed. Use the new one next time you sign in.' });
  };

  return (
    <div className="mx-auto max-w-md px-4 py-8 md:px-6">
      <h1 className="flex items-center gap-2 text-2xl font-bold text-slate-900"><KeyRound className="h-6 w-6 text-teal-600" /> Change password</h1>
      {name && <p className="mt-1 text-base text-slate-600">{name}</p>}
      <form onSubmit={save} className="mt-6 space-y-4 rounded-2xl border border-slate-200 bg-white p-5">
        <label className="block text-base font-medium text-slate-800">Current password
          <input type="password" autoComplete="current-password" required value={cur} onChange={(e) => setCur(e.target.value)} className={field} /></label>
        <label className="block text-base font-medium text-slate-800">New password
          <input type="password" autoComplete="new-password" required value={pw} onChange={(e) => setPw(e.target.value)} className={field} /></label>
        <label className="block text-base font-medium text-slate-800">New password again
          <input type="password" autoComplete="new-password" required value={pw2} onChange={(e) => setPw2(e.target.value)} className={field} /></label>
        {msg && <p role="status" className={`flex items-center gap-2 rounded-lg p-3 text-base ${msg.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-rose-50 text-rose-800'}`}>
          {msg.ok && <CheckCircle2 className="h-5 w-5" />} {msg.text}</p>}
        <button disabled={busy} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-teal-600 text-base font-bold text-white hover:bg-teal-700 disabled:opacity-50">
          {busy && <Loader2 className="h-5 w-5 animate-spin" />} Change password
        </button>
      </form>
    </div>
  );
}
