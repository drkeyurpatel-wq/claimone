// Dashboard: the headline numbers, what is stuck, and money collected. Detail lives on Money owed and Deductions.
import Link from 'next/link';
import { ChevronRight, Printer } from 'lucide-react';
import type { Ageing, Pipeline } from '@/lib/rcm/overview';
import { inrShort } from '@/components/ui';
import { BucketBar, BucketLegend, Panel, ReportPage, Tile } from './kit';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface DashboardData {
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
      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
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
