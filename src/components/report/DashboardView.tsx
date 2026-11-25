// Dashboard: the headline numbers, what is stuck, and money collected. Detail lives on Money owed and Deductions.
import Link from 'next/link';
import { ChevronRight, Printer } from 'lucide-react';
import type { Ageing, Headline, MonthMix, Pipeline } from '@/lib/rcm/overview';
import { inrShort } from '@/components/ui';
import { BucketBar, BucketLegend, Panel, ReportPage, Tile } from './kit';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface DashboardData {
  dhis: { claims: number; amount: number };
  head: Headline; mix: MonthMix & { label: string; settled: number };
  age: Ageing; pipe: Pipeline;
  ded: { total: number; fighting: number };
  coll: { month: string; amount: number }[];
  tat: { preauthHours: number | null; preauthCount: number; claimDays: number | null; claimCount: number };
}

const more = 'inline-flex min-h-11 items-center gap-1 text-sm font-semibold text-teal-700 hover:text-teal-900';

export function DashboardView({ d }: { d: DashboardData }) {
  const maxColl = Math.max(...d.coll.map((c) => c.amount), 0);
  const stuck: [string, string, string, boolean][] = [
    ['Pre-auth & in hospital', `${d.pipe.admission.todo} to do · ${d.pipe.admission.waiting} waiting`, `${d.pipe.admission.late} late`, d.pipe.admission.late > 0],
    ['Discharge & claims', `${d.pipe.claims.todo} to do · ${d.pipe.claims.waiting} waiting`, `${d.pipe.claims.late} late`, d.pipe.claims.late > 0],
    ['Approved, waiting for money', `${d.pipe.payment.count} cases`, `${d.pipe.payment.late} late`, d.pipe.payment.late > 0],
  ];
  const href = ['/patients?stage=preauth', '/patients?stage=discharge', '/patients?stage=payment'];
  return (
    <ReportPage title="Dashboard" sub="All credit business at this centre — insurance, PMJAY, government schemes, companies and patient dues."
      actions={<Link href="/summary" className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50"><Printer className="h-4 w-4" /> Print weekly summary</Link>}>
      <div className="mt-5 grid gap-3 md:grid-cols-[1fr_1fr_1fr_1.4fr]">
        <Link href="/master" className="rounded-xl border border-slate-200 bg-white p-4 hover:border-teal-400"><p className="text-sm font-medium text-slate-600">Active files</p><p className="mt-1 text-3xl font-bold tabular-nums text-slate-900">{d.head.active.toLocaleString('en-IN')}</p></Link>
        <Link href="/master" className="rounded-xl border border-slate-200 bg-white p-4 hover:border-teal-400"><p className="text-sm font-medium text-slate-600">Approved, money awaited</p><p className="mt-1 text-3xl font-bold tabular-nums text-teal-700">{d.head.approved.toLocaleString('en-IN')}</p></Link>
        <Link href="/master?show=high" className="rounded-xl border border-slate-200 bg-white p-4 hover:border-rose-400"><p className="text-sm font-medium text-slate-600">Need attention</p><p className={`mt-1 text-3xl font-bold tabular-nums ${d.head.attention ? 'text-rose-700' : 'text-slate-900'}`}>{d.head.attention.toLocaleString('en-IN')}</p></Link>
        <Donut mix={d.mix} />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Money owed" value={inrShort(d.age.total)} sub={`${d.age.count.toLocaleString('en-IN')} bills`} />
        <Tile label="Older than 90 days" value={inrShort(d.age.over90)} sub={d.age.total ? `${Math.round((d.age.over90 / d.age.total) * 100)}% of owed` : undefined} tone={d.age.over90 ? 'text-rose-700' : undefined} />
        <Tile label="Collected this month" value={inrShort(d.coll[d.coll.length - 1]?.amount ?? 0)} />
        <Tile label="Lost to deductions" value={inrShort(d.ded.total)} sub={d.ded.fighting > 0 ? `${inrShort(d.ded.fighting)} more being fought` : undefined} />
      </div>

      <Panel title="Files that need attention">
        <div className="grid gap-3 md:grid-cols-3">
          {stuck.map(([label, line, late, isLate], i) => (
            <Link key={label} href={href[i]} className="flex items-center gap-3 rounded-xl border border-slate-200 p-4 hover:border-teal-400">
              <div className="flex-1">
                <p className="text-base font-semibold text-slate-900">{label}</p>
                <p className="text-sm text-slate-600">{line} · <span className={isLate ? 'font-semibold text-rose-700' : ''}>{late}</span></p>
              </div>
              <ChevronRight className="h-5 w-5 text-slate-300" />
            </Link>
          ))}
        </div>
      </Panel>

      <Panel title="Payments this month">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Tile label="Settled" value={d.mix.settled.toLocaleString('en-IN')} sub="files discharged this month" tone="text-teal-700" />
          <Tile label="On track" value={(d.pipe.payment.count - d.pipe.payment.late).toLocaleString('en-IN')} sub="approved, within payment time" />
          {d.dhis.claims > 0 && <Tile label="PMJAY NHCX incentive" value={inrShort(d.dhis.amount)} sub={`${d.dhis.claims} claims via NHCX this month`} tone="text-teal-700" />}
          <Link href="/master?show=cuts" className="block"><Tile label="Needs review" value={(d.pipe.payment.late).toLocaleString('en-IN')} sub="payment late — chase or check the cut" tone={d.pipe.payment.late ? 'text-rose-700' : undefined} /></Link>
        </div>
      </Panel>

      <Panel title="Money owed, by age" right={<Link href="/claims/mis" className={more}>By payer <ChevronRight className="h-4 w-4" /></Link>}>
        <BucketLegend />
        <div className="mt-4 space-y-4">
          {d.age.byCategory.map((c) => (
            <div key={c.category}>
              <div className="flex justify-between text-[15px]"><span className="font-medium text-slate-800">{c.category}</span><span className="font-semibold tabular-nums text-slate-900">{inrShort(c.total)}</span></div>
              <div className="mt-1"><BucketBar buckets={c.buckets} total={c.total} label={c.category} format={inrShort} /></div>
            </div>
          ))}
          {!d.age.byCategory.length && <p className="text-base text-slate-500">Nothing owed.</p>}
        </div>
      </Panel>

      <Panel title="Money collected, by month">
        <div className="flex h-48 items-end gap-3">
          {d.coll.map((c) => (
            <div key={c.month} className="flex flex-1 flex-col items-center gap-1">
              <span className="text-sm font-semibold tabular-nums text-slate-700">{c.amount ? inrShort(c.amount) : ''}</span>
              <div className="w-full rounded-t-md bg-teal-500" style={{ height: `${maxColl ? Math.max(2, (c.amount / maxColl) * 130) : 2}px` }} />
              <span className="text-sm text-slate-500">{MONTHS[Number(c.month.slice(5)) - 1]}</span>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="How fast payers answer">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Tile label="Pre-auth answer" value={d.tat.preauthHours == null ? '—' : `${d.tat.preauthHours} h`} sub={`median of ${d.tat.preauthCount}`}
            tone={d.tat.preauthHours != null && d.tat.preauthHours > 1 ? 'text-amber-700' : undefined} />
          <Tile label="Claim decision" value={d.tat.claimDays == null ? '—' : `${d.tat.claimDays} days`} sub={`median of ${d.tat.claimCount}`} />
        </div>
        <p className="mt-3 text-sm text-slate-500">Insurer target: pre-auth answered within 1 hour, discharge within 3 hours (IRDAI).</p>
      </Panel>
    </ReportPage>
  );
}

const SLICES: { k: 'approved' | 'review' | 'flagged'; label: string; color: string }[] = [
  { k: 'approved', label: 'Approved', color: '#0d9488' },
  { k: 'review', label: 'In review', color: '#94a3b8' },
  { k: 'flagged', label: 'Query / rejected', color: '#e11d48' },
];

/** Files discharged this month, by where they stand. Plain SVG — renders with no script and prints. */
function Donut({ mix }: { mix: MonthMix & { label: string; settled?: number } }) {
  const R = 40, C = 2 * Math.PI * R;
  let off = 0;
  return (
    <div className="flex items-center gap-4 rounded-xl border border-slate-200 bg-white p-4">
      <svg viewBox="0 0 100 100" className="h-28 w-28 shrink-0 -rotate-90" role="img" aria-label={`Claims ${mix.label}`}>
        <circle cx="50" cy="50" r={R} fill="none" stroke="#f1f5f9" strokeWidth="16" />
        {mix.total > 0 && SLICES.map((s) => {
          const len = (mix[s.k] / mix.total) * C;
          const el = <circle key={s.k} cx="50" cy="50" r={R} fill="none" stroke={s.color} strokeWidth="16" strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-off} />;
          off += len; return el;
        })}
      </svg>
      <div className="min-w-0">
        <p className="text-sm font-medium text-slate-600">Claims · {mix.label}</p>
        <ul className="mt-1 space-y-0.5 text-[15px]">
          {SLICES.map((s) => (
            <li key={s.k} className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />
              {s.label} <span className="font-semibold tabular-nums">{mix.total ? Math.round((mix[s.k] / mix.total) * 100) : 0}%</span></li>
          ))}
        </ul>
        <p className="mt-1 text-xs text-slate-500">{mix.total.toLocaleString('en-IN')} files discharged</p>
      </div>
    </div>
  );
}
