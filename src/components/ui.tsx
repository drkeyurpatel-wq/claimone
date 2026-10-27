'use client';
import { useCallback, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { STATUS_CONFIG, type ClaimStatus } from '@/lib/claims/types';

// ─── Money & dates (Indian format) ───
export const inr = (n: number | null | undefined) =>
  n == null ? '—' : `₹${Math.round(Number(n)).toLocaleString('en-IN')}`;

/** ₹3.9 L / ₹1.25 Cr for headline numbers. */
export const inrShort = (n: number | null | undefined) => {
  if (n == null) return '—';
  const v = Number(n);
  if (Math.abs(v) >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (Math.abs(v) >= 1e5) return `₹${(v / 1e5).toFixed(1)} L`;
  return inr(v);
};

export const shortDate = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';

export const dateTime = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

export const daysSince = (d: string | null | undefined) =>
  d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : null;

// ─── Pieces ───
export function StatusPill({ status }: { status: ClaimStatus }) {
  const s = STATUS_CONFIG[status] ?? STATUS_CONFIG.draft;
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${s.bg} ${s.color}`}>{s.label}</span>;
}

export function StatCard({ label, value, sub, icon: Icon, tone = 'slate', onClick }: {
  label: string; value: string | number; sub?: string; icon: LucideIcon;
  tone?: 'slate' | 'amber' | 'orange' | 'blue' | 'purple' | 'emerald' | 'rose' | 'teal'; onClick?: () => void;
}) {
  const tones: Record<string, string> = {
    slate: 'bg-slate-100 text-slate-700', amber: 'bg-amber-50 text-amber-700', orange: 'bg-orange-50 text-orange-700',
    blue: 'bg-blue-50 text-blue-700', purple: 'bg-purple-50 text-purple-700', emerald: 'bg-emerald-50 text-emerald-700',
    rose: 'bg-rose-50 text-rose-700', teal: 'bg-teal-50 text-teal-700',
  };
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag onClick={onClick} className={`flex items-start gap-3 rounded-xl border border-slate-200 bg-white p-4 text-left ${onClick ? 'transition hover:-translate-y-0.5 hover:shadow-md' : ''}`}>
      <div className={`rounded-lg p-2 ${tones[tone]}`}><Icon className="h-4 w-4" /></div>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</p>
        <p className="tabular mt-0.5 text-xl font-bold text-slate-900">{value}</p>
        {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
      </div>
    </Tag>
  );
}

export function PageHeader({ title, sub, icon: Icon, children }: { title: string; sub?: string; icon: LucideIcon; children?: React.ReactNode }) {
  return (
    <div className="sticky top-0 z-20 border-b border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-4">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-bold text-slate-900"><Icon className="h-5 w-5 text-teal-600" /> {title}</h1>
          {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">{children}</div>
      </div>
    </div>
  );
}

export function Empty({ icon: Icon, title, sub, children }: { icon: LucideIcon; title: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="py-16 text-center">
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100"><Icon className="h-7 w-7 text-slate-300" /></div>
      <p className="text-sm font-medium text-slate-600">{title}</p>
      {sub && <p className="mt-1 text-xs text-slate-400">{sub}</p>}
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}

export function Skeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="animate-pulse space-y-3 p-4">
      {Array.from({ length: rows }).map((_, i) => <div key={i} className="h-4 rounded bg-slate-100" />)}
    </div>
  );
}

export function NoCentre() {
  return <div className="p-10 text-center text-sm text-slate-500">No centre is assigned to your login. Ask an admin to add one.</div>;
}

export function useToast() {
  const [toast, setToast] = useState<{ text: string; tone: 'ok' | 'err' } | null>(null);
  const flash = useCallback((text: string, tone: 'ok' | 'err' = 'ok') => {
    setToast({ text, tone });
    setTimeout(() => setToast(null), tone === 'err' ? 6000 : 2500);
  }, []);
  const node = toast ? (
    <div className={`fixed left-1/2 top-4 z-50 max-w-lg -translate-x-1/2 rounded-xl px-5 py-2.5 text-sm font-medium text-white shadow-lg ${toast.tone === 'ok' ? 'bg-teal-600' : 'bg-rose-600'}`}>
      {toast.text}
    </div>
  ) : null;
  return { flash, toastNode: node };
}

export const btn = {
  primary: 'inline-flex items-center gap-1.5 rounded-lg bg-teal-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50',
  ghost: 'inline-flex items-center gap-1.5 rounded-lg bg-slate-100 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-200 disabled:opacity-50',
  input: 'rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100',
};
