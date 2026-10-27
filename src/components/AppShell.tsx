'use client';
import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  ShieldCheck, LayoutDashboard, FilePlus2, Shield, MessageSquare, IndianRupee,
  Building2, BarChart3, TrendingDown, Bot, ListChecks, LogOut, Wallet, GitMerge, Upload,
} from 'lucide-react';
import type { Session } from '@/lib/auth/session';
import { useAuthStore } from '@/lib/store/auth';
import { sb } from '@/lib/supabase/browser';

const NAV = [
  { href: '/claims', label: 'Claims', icon: LayoutDashboard, exact: true },
  { href: '/claims/new', label: 'New claim', icon: FilePlus2 },
  { href: '/claims/preauth', label: 'Pre-auth queue', icon: Shield },
  { href: '/claims/queries', label: 'Queries', icon: MessageSquare },
  { href: '/claims/settlements', label: 'Settlements', icon: IndianRupee },
  { href: '/claims/leakage', label: 'Leakage', icon: TrendingDown },
  { href: '/claims/mis', label: 'MIS', icon: BarChart3 },
  { href: '/claims/payers', label: 'Payers', icon: Building2 },
  { href: '/claims/rules', label: 'Document rules', icon: ListChecks },
  { href: '/claims/bot', label: 'Portal bot', icon: Bot },
  { href: '/receivables', label: 'Receivables', icon: Wallet },
  { href: '/receivables/reconcile', label: 'Reconcile', icon: GitMerge },
  { href: '/receivables/import', label: 'Import', icon: Upload },
];

// The most specific nav entry that matches wins, so /receivables/import
// does not also light up Receivables.
function activeHref(pathname: string) {
  return NAV.filter((n) => (n.exact ? pathname === n.href : pathname === n.href || pathname.startsWith(n.href + '/')))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
}

export function AppShell({ session, children }: { session: Session; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { hydrate, centres, activeCentreId, setActiveCentre, staff } = useAuthStore();

  useEffect(() => { hydrate(session); }, [session, hydrate]);

  const current = activeHref(pathname);
  const signOut = async () => { await sb().auth.signOut(); router.replace('/login'); router.refresh(); };

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-600">
            <ShieldCheck className="h-4 w-4 text-white" />
          </div>
          <span className="text-base font-bold tracking-tight">ClaimOne</span>
        </div>
        <div className="px-3">
          <select value={activeCentreId ?? ''} onChange={(e) => setActiveCentre(e.target.value)}
            className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs font-medium text-slate-700">
            {centres.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <nav className="mt-4 flex-1 space-y-0.5 overflow-y-auto px-3">
          {NAV.map((n) => {
            const active = n.href === current;
            return (
              <Link key={n.href} href={n.href}
                className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  active ? 'bg-teal-50 text-teal-700' : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'}`}>
                <n.icon className="h-4 w-4" /> {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-slate-100 px-4 py-4">
          <p className="truncate text-sm font-semibold text-slate-800">{staff?.full_name ?? session.fullName}</p>
          <p className="text-xs capitalize text-slate-500">{session.role}</p>
          <button onClick={signOut} className="mt-2 flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-800">
            <LogOut className="h-3.5 w-3.5" /> Sign out
          </button>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <div className="border-b border-slate-200 bg-white md:hidden">
          <div className="flex items-center justify-between px-4 py-3">
            <span className="font-bold">ClaimOne</span>
            <select value={activeCentreId ?? ''} onChange={(e) => setActiveCentre(e.target.value)}
              className="rounded-lg border border-slate-200 px-2 py-1 text-xs">
              {centres.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <nav className="flex gap-1 overflow-x-auto px-3 pb-2">
            {NAV.map((n) => {
              const active = n.href === current;
              return <Link key={n.href} href={n.href} className={`whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs font-medium ${active ? 'bg-teal-50 text-teal-700' : 'text-slate-600'}`}>{n.label}</Link>;
            })}
          </nav>
        </div>
        {children}
      </div>
    </div>
  );
}
