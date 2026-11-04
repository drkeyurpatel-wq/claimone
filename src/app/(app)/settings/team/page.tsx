'use client';
// Setup → Team. Staff sign up themselves with the team code; here a manager approves Administrative
// signups (they then see Reports and Setup) and switches off logins of staff who have left.
import { useCallback, useEffect, useState } from 'react';
import { Loader2, ShieldCheck, UserX, UserCheck, Users } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import { DESK_LABEL, ROLE_LABEL, fetchTeam, isPending, setStaff, type TeamMember } from '@/lib/auth/team';
import { Skeleton, shortDate, useToast } from '@/components/ui';

const mobileOf = (m: string | null) => (m ? `${m.slice(0, 5)} ${m.slice(5)}` : '—');

export default function TeamPage() {
  const staff = useAuthStore((s) => s.staff);
  const isManager = staff?.role === 'admin' || staff?.role === 'manager';
  const { flash, toastNode } = useToast();
  const [team, setTeam] = useState<TeamMember[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try { setTeam(await fetchTeam()); setError(''); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { if (isManager) load(); }, [isManager, load]);

  if (staff && !isManager) return <div className="p-10 text-center text-base text-slate-600">Only a manager can see the team.</div>;

  const change = async (m: TeamMember, c: { role?: 'manager' | 'desk'; active?: boolean }, done: string) => {
    setBusy(m.user_id);
    try { await setStaff(m.user_id, c); flash(done); await load(); } catch (e) { flash((e as Error).message, 'err'); }
    setBusy('');
  };

  const pending = (team ?? []).filter(isPending);
  const rest = (team ?? []).filter((m) => !isPending(m));
  const btn = 'inline-flex min-h-11 items-center gap-2 rounded-lg px-4 text-sm font-semibold disabled:opacity-50';

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 md:px-6">
      {toastNode}
      <h1 className="text-2xl font-bold text-slate-900">Team</h1>
      <p className="mt-1 text-base text-slate-600">Staff create their own login with the team code. Approve Administrative staff here, and switch off anyone who has left.</p>

      {error && <p role="alert" className="mt-4 rounded-lg bg-rose-50 p-3 text-base text-rose-800">{error}</p>}
      {!team && !error && <div className="mt-6"><Skeleton rows={5} /></div>}

      {pending.length > 0 && (
        <section className="mt-6 rounded-2xl border border-amber-300 bg-amber-50 p-5">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-amber-900"><ShieldCheck className="h-5 w-5" /> Waiting for approval · {pending.length}</h2>
          <p className="text-sm text-amber-900">Signed up as Administrative. Approve to open Reports and Setup for them.</p>
          <ul className="mt-3 space-y-2">
            {pending.map((m) => (
              <li key={m.user_id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white p-3">
                <span className="text-base"><b>{m.full_name}</b> <span className="text-slate-500">· {mobileOf(m.mobile)} · joined {shortDate(m.joined)}</span></span>
                <span className="flex gap-2">
                  <button disabled={!!busy} onClick={() => change(m, { role: 'manager' }, `${m.full_name} approved`)} className={`${btn} bg-teal-600 text-white hover:bg-teal-700`}>
                    {busy === m.user_id ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserCheck className="h-4 w-4" />} Approve
                  </button>
                  <button disabled={!!busy} onClick={() => change(m, { active: false }, `${m.full_name} switched off`)} className={`${btn} bg-white text-rose-700 ring-1 ring-rose-200 hover:bg-rose-50`}>
                    <UserX className="h-4 w-4" /> Not our staff
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {team && (
        <section className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <h2 className="flex items-center gap-2 border-b border-slate-100 px-5 py-3 text-base font-semibold text-slate-900"><Users className="h-5 w-5 text-slate-500" /> Everyone · {rest.length}</h2>
          <ul className="divide-y divide-slate-100">
            {rest.map((m) => {
              const me = m.user_id === staff?.id;
              const locked = me || m.role === 'admin' || (m.role === 'manager' && staff?.role !== 'admin');
              return (
                <li key={m.user_id} className={`flex flex-wrap items-center justify-between gap-2 px-5 py-3 ${m.is_active ? '' : 'opacity-60'}`}>
                  <span className="min-w-0 text-base">
                    <b>{m.full_name}</b>{me && <span className="text-slate-500"> (you)</span>}
                    <span className="block text-sm text-slate-500">{mobileOf(m.mobile)} · {ROLE_LABEL[m.role] ?? m.role}{m.workspace ? ` · ${DESK_LABEL[m.workspace] ?? m.workspace}` : ''}{m.is_active ? '' : ' · switched off'}</span>
                  </span>
                  {!locked && (
                    <span className="flex flex-wrap gap-2">
                      {m.is_active && m.role === 'desk' && m.workspace === 'admin' && (
                        <button disabled={!!busy} onClick={() => change(m, { role: 'manager' }, `${m.full_name} approved`)} className={`${btn} bg-teal-50 text-teal-800 hover:bg-teal-100`}>Make manager</button>
                      )}
                      {m.role === 'manager' && (
                        <button disabled={!!busy} onClick={() => change(m, { role: 'desk' }, `${m.full_name} is desk staff now`)} className={`${btn} bg-slate-100 text-slate-700 hover:bg-slate-200`}>Make desk staff</button>
                      )}
                      <button disabled={!!busy} onClick={() => change(m, { active: !m.is_active }, m.is_active ? `${m.full_name} switched off` : `${m.full_name} switched on`)}
                        className={`${btn} ${m.is_active ? 'bg-white text-rose-700 ring-1 ring-rose-200 hover:bg-rose-50' : 'bg-teal-600 text-white hover:bg-teal-700'}`}>
                        {busy === m.user_id ? <Loader2 className="h-4 w-4 animate-spin" /> : m.is_active ? <UserX className="h-4 w-4" /> : <UserCheck className="h-4 w-4" />}
                        {m.is_active ? 'Switch off' : 'Switch on'}
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}
