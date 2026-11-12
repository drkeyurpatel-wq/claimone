// One look for every report screen: page frame, tile, panel, bar and table cells.
import type { ReactNode } from 'react';
import { BUCKETS } from '@/lib/rcm/overview';

export const BUCKET_TONE = ['bg-emerald-500', 'bg-lime-500', 'bg-amber-400', 'bg-orange-500', 'bg-rose-600'];
export const th = 'border-b border-slate-200 px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-slate-500';
export const td = 'border-b border-slate-100 px-3 py-2.5 text-[15px] tabular-nums text-slate-800';

export function ReportPage({ title, sub, actions, children }: { title: string; sub?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-7xl px-4 py-6 md:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
          {sub && <p className="mt-1 text-base text-slate-600">{sub}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2 print:hidden">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-sm text-slate-500">{label}</p>
      <p className={`mt-0.5 text-2xl font-bold tabular-nums ${tone ?? 'text-slate-900'}`}>{value}</p>
      {sub && <p className="text-sm text-slate-500">{sub}</p>}
    </div>
  );
}

export function Panel({ title, right, children, flush }: { title: string; right?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className={`mt-6 rounded-2xl border border-slate-200 bg-white ${flush ? 'overflow-hidden' : ''}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-5">
        <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
        {right}
      </div>
      <div className={flush ? 'mt-3' : 'px-5 pb-5 pt-3'}>{children}</div>
    </section>
  );
}

export function Bar({ value, max, tone = 'bg-teal-500' }: { value: number; max: number; tone?: string }) {
  return <div className="h-2.5 w-full rounded-full bg-slate-100"><div className={`h-2.5 rounded-full ${tone}`} style={{ width: `${max > 0 ? Math.max(2, (value / max) * 100) : 0}%` }} /></div>;
}

export function BucketLegend() {
  return (
    <div className="flex flex-wrap gap-3 text-sm text-slate-600">
      {BUCKETS.map((b, i) => <span key={b} className="flex items-center gap-1.5"><span className={`h-2.5 w-2.5 rounded-sm ${BUCKET_TONE[i]}`} />{b} days</span>)}
    </div>
  );
}

/** One stacked bar: the amount in each age bucket. */
export function BucketBar({ buckets, total, label, format }: { buckets: Record<string, number>; total: number; label: string; format: (n: number) => string }) {
  return (
    <div className="flex h-4 w-full overflow-hidden rounded-full bg-slate-100" role="img"
      aria-label={`${label}: ${BUCKETS.map((b) => `${b} days ${format(buckets[b])}`).join(', ')}`}>
      {BUCKETS.map((b, i) => buckets[b] > 0 && (
        <div key={b} className={BUCKET_TONE[i]} style={{ width: `${(buckets[b] / total) * 100}%` }} title={`${b} days: ${format(buckets[b])}`} />
      ))}
    </div>
  );
}
