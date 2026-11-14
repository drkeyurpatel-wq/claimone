// Money owed: one payer × age grid, with how each payer pays in the same row.
import { BUCKETS, type Ageing } from '@/lib/rcm/overview';
import type { PayerScorecard } from '@/lib/claims/types';
import { inr, inrShort } from '@/components/ui';
import { BucketBar, BucketLegend, Panel, ReportPage, Tile, td, th } from './kit';

const pct = (n: number | null | undefined) => (n == null ? '—' : `${n}%`);

export function MoneyOwedView({ age, score }: { age: Ageing; score: Record<string, PayerScorecard> }) {
  const all = Object.fromEntries(BUCKETS.map((b) => [b, age.byPayer.reduce((s, p) => s + p.buckets[b], 0)])) as Record<string, number>;
  return (
    <ReportPage title="Money owed" sub="Files discharged on or after 1 Nov 2026: open bills with a balance, by payer and age. Age is days since the bill date. Earlier files are under Before 1 Nov.">
      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-5">
        {BUCKETS.map((b, i) => (
          <Tile key={b} label={`${b} days`} value={inrShort(all[b])} sub={age.total ? `${Math.round((all[b] / age.total) * 100)}% of owed` : undefined}
            tone={i >= 3 && all[b] > 0 ? 'text-rose-700' : undefined} />
        ))}
      </div>

      <Panel title={`By payer — ${inrShort(age.total)} on ${age.count.toLocaleString('en-IN')} bills`} right={<BucketLegend />} flush>
        {age.byPayer.length === 0 ? <p className="px-5 pb-5 text-base text-slate-500">Nothing owed.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1040px] border-collapse">
              <thead><tr>
                <th className={`${th} pl-5`}>Payer</th>
                {BUCKETS.map((b) => <th key={b} className={`${th} text-right`}>{b}</th>)}
                <th className={`${th} text-right`}>Total</th>
                <th className={`${th} text-right`}>Bills</th>
                <th className={`${th} whitespace-nowrap text-right`}>Days to pay</th>
                <th className={`${th} text-right`}>Rejected</th>
                <th className={`${th} pr-5 text-right`}>Deducted</th>
              </tr></thead>
              <tbody>
                {age.byPayer.map((p) => {
                  const s = p.id ? score[p.id] : undefined;
                  return (
                    <tr key={p.name}>
                      <td className={`${td} w-56 max-w-[14rem] pl-5`}>
                        <span className="block truncate font-medium text-slate-900" title={p.name}>{p.name}</span>
                        <span className="mt-1 block"><BucketBar buckets={p.buckets} total={p.total} label={p.name} format={inrShort} /></span>
                      </td>
                      {BUCKETS.map((b, i) => <td key={b} className={`${td} text-right ${i >= 3 && p.buckets[b] > 0 ? 'font-semibold text-rose-700' : ''}`}>{p.buckets[b] ? inr(p.buckets[b]) : '—'}</td>)}
                      <td className={`${td} text-right font-bold text-slate-900`}>{inr(p.total)}</td>
                      <td className={`${td} text-right`}>{p.count}</td>
                      <td className={`${td} text-right`}>{s?.avg_settlement_days ?? '—'}</td>
                      <td className={`${td} text-right ${(s?.rejection_rate_pct ?? 0) > 10 ? 'font-semibold text-rose-700' : ''}`}>{pct(s?.rejection_rate_pct)}</td>
                      <td className={`${td} pr-5 text-right ${(s?.deduction_pct ?? 0) > 10 ? 'font-semibold text-rose-700' : ''}`}>{pct(s?.deduction_pct)}</td>
                    </tr>
                  );
                })}
                <tr className="bg-slate-50 font-bold">
                  <td className={`${td} pl-5`}>Total</td>
                  {BUCKETS.map((b) => <td key={b} className={`${td} text-right`}>{inr(all[b])}</td>)}
                  <td className={`${td} text-right`}>{inr(age.total)}</td>
                  <td className={`${td} text-right`}>{age.count}</td>
                  <td className={td} /><td className={td} /><td className={`${td} pr-5`} />
                </tr>
              </tbody>
            </table>
          </div>
        )}
        <p className="px-5 py-3 text-sm text-slate-500">Days to pay, Rejected and Deducted are for all claims with that payer to date.</p>
      </Panel>
    </ReportPage>
  );
}
