'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { LucideIcon } from 'lucide-react';
import {
  ShieldCheck, LayoutDashboard, Building2, BarChart3, TrendingDown, Bot, ListChecks, LogOut, Wallet, ClipboardCheck, GitMerge, Upload,
  Gauge, FileSpreadsheet, Users, KeyRound, ChevronDown, Table2, MoreHorizontal,
} from 'lucide-react';
import type { Session } from '@/lib/auth/session';
import { useAuthStore } from '@/lib/store/auth';
import { sb } from '@/lib/supabase/browser';

// Everyone works from the ledger. Everything else sits under "More":
// the upload screens and patient files for all, the manager screens for managers.
type NavItem = { href: string; label: string; icon: LucideIcon; exact?: boolean };
const MAIN_NAV: NavItem[] = [{ href: '/master', label: 'Master', icon: Table2 }];
const MORE_WORK: NavItem[] = [
  { href: '/patients', label: 'Case files', icon: Users },
  { href: '/cases/upload', label: 'Import admissions (eCW)', icon: FileSpreadsheet },
  { href: '/pay', label: 'Import settlements', icon: Upload, exact: true },
  { href: '/pay/check', label: 'Settlement review', icon: ClipboardCheck, exact: true },
];
const MORE_MANAGER: NavItem[] = [
  { href: '/overview', label: 'Overview', icon: Gauge },
  { href: '/claims/payers', label: 'Payers', icon: Building2 },
  { href: '/claims/rules', label: 'Document rules', icon: ListChecks },
  { href: '/claims/mis', label: 'MIS', icon: BarChart3 },
  { href: '/claims/leakage', label: 'Leakage', icon: TrendingDown },
  { href: '/claims', label: 'All claims (table)', icon: LayoutDashboard, exact: true },
  { href: '/receivables', label: 'Receivables (table)', icon: Wallet },
  { href: '/receivables/reconcile', label: 'Bank matching', icon: GitMerge },
  { href: '/receivables/import', label: 'Import old data', icon: Upload },
  { href: '/claims/bot', label: 'Portal bot', icon: Bot },
];

// The most specific nav entry that matches wins, so /receivables/import
// does not also light up Receivables.
function activeHref(pathname: string, nav: NavItem[]) {
  return nav.filter((n) => (n.exact ? pathname === n.href : pathname === n.href || pathname.startsWith(n.href + '/')))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
}

export function AppShell({ session, children }: { session: Session; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { hydrate, centres, activeCentreId, setActiveCentre, staff } = useAuthStore();

  useEffect(() => { hydrate(session); }, [session, hydrate]);

  const isManager = session.role === 'admin' || session.role === 'manager';
  const more = isManager ? [...MORE_WORK, ...MORE_MANAGER] : MORE_WORK;
  // a patient's file counts as Patient files; anything not in the menu lights nothing
  const current = activeHref(pathname.startsWith('/case/') ? '/patients' : pathname, [...MAIN_NAV, ...more]);
  const inMore = more.some((n) => n.href === current);
  // desk menu: open by default while on a More screen, but the button always toggles
  const [moreOpen, setMoreOpen] = useState<boolean | null>(null);
  const [phoneMore, setPhoneMore] = useState(false);
  useEffect(() => { setMoreOpen(null); setPhoneMore(false); }, [pathname]);
  const showMore = moreOpen ?? inMore;
  const signOut = async () => { await sb().auth.signOut(); router.replace('/login'); router.refresh(); };
  const item = (n: NavItem, small = false) => {
    const active = n.href === current;
    return (
      <Link key={n.href} href={n.href}
        className={`flex items-center gap-2.5 rounded-lg px-3 font-medium transition-colors ${small ? 'py-1.5 text-sm' : 'min-h-12 text-base'} ${
          active ? 'bg-teal-50 text-teal-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}>
        <n.icon className="h-4 w-4" /> {n.label}
      </Link>
    );
  };

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-600">
            <ShieldCheck className="h-4 w-4 text-white" />
          </div>
          <span className="text-base font-bold tracking-tight">ClaimOne</span>
        </div>
        {centres.length > 1 && (
          <div className="px-3">
            <select value={activeCentreId ?? ''} onChange={(e) => setActiveCentre(e.target.value)} aria-label="Hospital"
              className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2 py-2 text-sm font-medium text-slate-700">
              {centres.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        )}
        <nav className="mt-4 flex-1 space-y-0.5 overflow-y-auto px-3">
          {MAIN_NAV.map((n) => item(n))}
          <div className="pt-3">
            <button type="button" onClick={() => setMoreOpen(!showMore)} aria-expanded={showMore}
              className="flex min-h-11 w-full items-center justify-between rounded-lg px-3 text-sm font-medium text-slate-500 hover:bg-slate-50">
              More <ChevronDown className={`h-4 w-4 transition ${showMore ? 'rotate-180' : ''}`} />
            </button>
            {showMore && <div className="space-y-0.5">{more.map((n) => item(n, true))}</div>}
          </div>
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
        <div className="border-b border-slate-200 bg-white md:hidden">
          <div className="flex items-center justify-between gap-2 px-4 py-3">
            <span className="font-bold">ClaimOne</span>
            <div className="flex items-center gap-3">
              {centres.length > 1 && (
                <select value={activeCentreId ?? ''} onChange={(e) => setActiveCentre(e.target.value)} aria-label="Hospital"
                  className="rounded-lg border border-slate-200 px-2 py-1 text-sm">
                  {centres.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              )}
              <Link href="/account" aria-label="Change password" className="text-slate-500"><KeyRound className="h-5 w-5" /></Link>
              <button onClick={signOut} aria-label="Sign out" className="text-slate-500"><LogOut className="h-5 w-5" /></button>
            </div>
          </div>
          <nav className="flex gap-1 overflow-x-auto px-3 pb-2">
            {MAIN_NAV.map((n) => (
              <Link key={n.href} href={n.href} className={`whitespace-nowrap rounded-lg px-4 py-2.5 text-base font-medium ${n.href === current ? 'bg-teal-50 text-teal-700' : 'text-slate-600'}`}>{n.label}</Link>
            ))}
            <button type="button" onClick={() => setPhoneMore((v) => !v)} aria-expanded={phoneMore}
              className={`inline-flex items-center gap-1 whitespace-nowrap rounded-lg px-4 py-2.5 text-base font-medium ${inMore ? 'bg-teal-50 text-teal-700' : 'text-slate-600'}`}>
              <MoreHorizontal className="h-5 w-5" /> {inMore ? more.find((n) => n.href === current)?.label : 'More'}
            </button>
          </nav>
          {phoneMore && <div className="grid grid-cols-2 gap-1 border-t border-slate-100 px-3 py-2">{more.map((n) => item(n, true))}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}
