'use client';
import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { LucideIcon } from 'lucide-react';
import { ShieldCheck, BarChart3, LogOut, Wallet, Users, KeyRound, Table2, Settings } from 'lucide-react';
import type { Session } from '@/lib/auth/session';
import { useAuthStore } from '@/lib/store/auth';
import { sb } from '@/lib/supabase/browser';

// Five tabs, no hidden "More" menu. Each tab may have sub-tabs shown along the top of
// the page. Staff see Master, Payments and Records; managers also see Reports and Setup.
type Tab = { href: string; label: string; manager?: boolean };
type Group = { key: string; label: string; icon: LucideIcon; manager?: boolean; tabs: Tab[] };

export const GROUPS: Group[] = [
  { key: 'master', label: 'Master', icon: Table2, tabs: [{ href: '/master', label: 'Master' }] },
  {
    key: 'payments', label: 'Payments', icon: Wallet,
    tabs: [
      { href: '/pay', label: '1. Upload settlements' },
      { href: '/pay/check', label: '2. Review settlements' },
      { href: '/receivables/import', label: '3. Upload bank statement' },
      { href: '/receivables/reconcile', label: '4. Bank matching' },
    ],
  },
  {
    key: 'reports', label: 'Reports', icon: BarChart3, manager: true,
    tabs: [
      { href: '/overview', label: 'Dashboard' },
      { href: '/claims/mis', label: 'MIS' },
      { href: '/summary', label: 'Weekly summary' },
      { href: '/claims/payers', label: 'Payer performance' },
      { href: '/claims/leakage', label: 'Leakage' },
    ],
  },
  {
    key: 'records', label: 'Records', icon: Users,
    tabs: [
      { href: '/patients', label: 'Case files' },
      { href: '/cases/upload', label: 'Import admissions (eCW)' },
      { href: '/cases/pmjay', label: 'Import PMJAY sheet' },
      { href: '/claims', label: 'All claims', manager: true },
      { href: '/receivables', label: 'All bills', manager: true },
    ],
  },
  {
    key: 'setup', label: 'Setup', icon: Settings, manager: true,
    tabs: [
      { href: '/settings', label: 'Payer master' },
      { href: '/claims/rules', label: 'Document rules' },
      { href: '/claims/bot', label: 'Portal bot' },
    ],
  },
];

// Screens opened from a list light up the tab of that list.
function navPath(pathname: string) {
  if (pathname.startsWith('/case/') || pathname.startsWith('/cases/new')) return '/patients';
  if (pathname === '/ledger' || pathname.startsWith('/desk/')) return '/master';
  return pathname;
}

// The most specific tab that matches wins, so /receivables/import does not light up All bills.
function activeTab(pathname: string, tabs: Tab[]) {
  return tabs.filter((t) => pathname === t.href || pathname.startsWith(t.href + '/'))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
}

export function AppShell({ session, children }: { session: Session; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { hydrate, centres, activeCentreId, setActiveCentre, staff } = useAuthStore();

  useEffect(() => { hydrate(session); }, [session, hydrate]);

  const isManager = session.role === 'admin' || session.role === 'manager';
  const groups = GROUPS.filter((g) => isManager || !g.manager)
    .map((g) => ({ ...g, tabs: g.tabs.filter((t) => isManager || !t.manager) }))
    .filter((g) => g.tabs.length > 0);
  const current = activeTab(navPath(pathname), groups.flatMap((g) => g.tabs));
  const group = groups.find((g) => g.tabs.some((t) => t.href === current));
  const signOut = async () => { await sb().auth.signOut(); router.replace('/login'); router.refresh(); };

  const subTabs = group && group.tabs.length > 1 && (
    <nav aria-label={group.label} className="flex gap-1 overflow-x-auto border-b border-slate-200 bg-white px-3 md:px-6 print:hidden">
      {group.tabs.map((t) => (
        <Link key={t.href} href={t.href}
          className={`-mb-px whitespace-nowrap border-b-2 px-3 py-3 text-sm font-semibold ${
            t.href === current ? 'border-teal-600 text-teal-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
          {t.label}
        </Link>
      ))}
    </nav>
  );

  const centrePicker = (cls: string) => centres.length > 1 && (
    <select value={activeCentreId ?? ''} onChange={(e) => setActiveCentre(e.target.value)} aria-label="Hospital" className={cls}>
      {centres.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden print:!hidden h-screen w-56 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-600">
            <ShieldCheck className="h-4 w-4 text-white" />
          </div>
          <span className="text-base font-bold tracking-tight">ClaimOne</span>
        </div>
        {centres.length > 1 && (
          <div className="px-3">{centrePicker('w-full rounded-lg border border-slate-200 bg-slate-50 px-2 py-2 text-sm font-medium text-slate-700')}</div>
        )}
        <nav className="mt-4 flex-1 space-y-1 overflow-y-auto px-3">
          {groups.map((g) => (
            <Link key={g.key} href={g.tabs[0].href}
              className={`flex min-h-12 items-center gap-2.5 rounded-lg px-3 text-base font-medium transition-colors ${
                g.key === group?.key ? 'bg-teal-50 text-teal-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}>
              <g.icon className="h-4 w-4" /> {g.label}
            </Link>
          ))}
        </nav>
        <div className="border-t border-slate-100 px-4 py-4">
          <p className="truncate text-sm font-semibold text-slate-800">{staff?.full_name ?? session.fullName}</p>
          <p className="text-xs capitalize text-slate-500">{session.role}</p>
          <Link href="/account" className="mt-2 flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900">
            <KeyRound className="h-4 w-4" /> Change password
          </Link>
          <button onClick={signOut} className="mt-2 flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900">
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <div className="border-b border-slate-200 bg-white md:hidden print:hidden">
          <div className="flex items-center justify-between gap-2 px-4 py-3">
            <span className="font-bold">ClaimOne</span>
            <div className="flex items-center gap-3">
              {centrePicker('rounded-lg border border-slate-200 px-2 py-1 text-sm')}
              <Link href="/account" aria-label="Change password" className="-m-2 inline-flex h-11 w-11 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"><KeyRound className="h-5 w-5" /></Link>
              <button type="button" onClick={signOut} aria-label="Sign out" className="-m-2 inline-flex h-11 w-11 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"><LogOut className="h-5 w-5" /></button>
            </div>
          </div>
          <nav className="flex gap-1 overflow-x-auto px-3 pb-2">
            {groups.map((g) => (
              <Link key={g.key} href={g.tabs[0].href}
                className={`whitespace-nowrap rounded-lg px-4 py-2.5 text-base font-medium ${g.key === group?.key ? 'bg-teal-50 text-teal-700' : 'text-slate-600'}`}>
                {g.label}
              </Link>
            ))}
          </nav>
        </div>
        {subTabs}
        {children}
      </div>
    </div>
  );
}
