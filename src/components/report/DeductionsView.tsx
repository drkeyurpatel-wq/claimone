// Deductions: what was cut, why, by whom — and what disputing got back.
import type { LeakageRow } from '@/lib/claims/types';
import type { DisputeMonth } from '@/lib/rcm/summary';
import { DISALLOWANCE_CATEGORIES, type DisallowanceCategory } from '@/lib/engine/settlement';
import { inr, inrShort } from '@/components/ui';
import { Panel, ReportPage, Tile, td, th } from './kit';

type Row = { label: string; amount: number; preventable?: boolean };
const monthName = (k: string) => new Date(`${k}-15T12:00:00+05:30`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });

function Bars({ rows }: { rows: Row[] }) {
  const max = Math.max(1, ...rows.map((r) => r.amount));
  if (!rows.length) return <p className="text-base text-slate-500">None recorded.</p>;
  return (
    <div className="space-y-2.5">
      {rows.map((r) => (
        <div key={r.label} className="grid grid-cols-12 items-center gap-3 text-[15px]">
          <span className="col-span-5 truncate text-slate-800" title={r.label}>{r.label}</span>
          <div className="col-span-5 h-4 rounded bg-slate-100">
            <div className={`h-4 rounded ${r.preventable === false ? 'bg-slate-400' : 'bg-rose-500'}`} style={{ width: `${(100 * r.amount) / max}%` }} />
          </div>
          <span className="col-span-2 text-right font-semibold tabular-nums">{inrShort(r.amount)}</span>
        </div>
      ))}
    </div>
  );
}

export function DeductionsView({ rows, months, setMonths, disputes }: { rows: LeakageRow[]; months: number; setMonths: (n: number) => void; disputes: DisputeMonth[] }) {
  const from = new Date(); from.setMonth(from.getMonth() - months + 1); from.setDate(1); from.setHours(0, 0, 0, 0);
  const recent = rows.filter((r) => new Date(r.month) >= from);
  // cuts being fought are not lost (yet): shown apart, left out of every total below
  const fighting = recent.filter((r) => r.kind === 'fighting');
  const lost = recent.filter((r) => r.kind !== 'fighting');
  const sum = (xs: LeakageRow[]) => xs.reduce((s, r) => s + Number(r.amount), 0);
  const group = (key: (r: LeakageRow) => string, byReason = false, top = 10): Row[] => {
    const m = new Map<string, Row>();
    for (const r of lost) {
      const k = key(r); const v = m.get(k) ?? { label: k, amount: 0, preventable: byReason ? r.is_preventable : undefined };
      v.amount += Number(r.amount); m.set(k, v);
    }
    return [...m.values()].sort((a, b) => b.amount - a.amount).slice(0, top);
  };
  const total = sum(lost);
  const preventable = sum(lost.filter((r) => r.is_preventable));
  const rejections = lost.filter((r) => r.kind === 'rejection').reduce((s, r) => s + r.items, 0);
  const recovered = disputes.reduce((s, m) => s + m.recovered, 0);

  return (
    <ReportPage title="Deductions" sub="Money claimed but not paid — approval cuts, short payments and settlement deductions."
      actions={<select aria-label="Period" value={months} onChange={(e) => setMonths(Number(e.target.value))} className="min-h-11 rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700">
        <option value={3}>Last 3 months</option><option value={6}>Last 6 months</option><option value={12}>Last 12 months</option>
      </select>}>
      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Deducted" value={inrShort(total)} tone={total ? 'text-rose-700' : undefined} sub={rejections ? `${rejections} claims rejected` : undefined} />
        <Tile label="Preventable" value={inrShort(preventable)} sub={total ? `${Math.round((100 * preventable) / total)}% of deducted — fixable at the desk` : undefined} />
        <Tile label="Being fought" value={inrShort(sum(fighting))} sub={fighting.length ? `${fighting.reduce((s, r) => s + r.items, 0)} files — left out of Deducted` : undefined} />
        <Tile label="Recovered by disputing (6 months)" value={inrShort(recovered)} tone={recovered ? 'text-emerald-700' : undefined} />
      </div>

      <Panel title="By reason" right={<p className="flex flex-wrap items-center gap-4 text-sm text-slate-600">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-rose-500" /> Preventable</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-slate-400" /> Policy terms</span></p>}>
        <Bars rows={group((r) => DISALLOWANCE_CATEGORIES[r.category as DisallowanceCategory]?.label ?? r.category, true)} />
      </Panel>
      <div className="grid gap-x-6 lg:grid-cols-2">
        <Panel title="By payer"><Bars rows={group((r) => r.payer_name)} /></Panel>
        <Panel title="By treating doctor"><Bars rows={group((r) => r.doctor_name)} /></Panel>
      </div>

      <Panel title="Accepted, disputed and recovered — last 6 months" flush>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse">
            <thead><tr><th className={`${th} pl-5`}>Month decided</th><th className={`${th} text-right`}>Accepted</th><th className={`${th} text-right`}>Disputed</th><th className={`${th} text-right`}>Won</th><th className={`${th} text-right`}>Recovered</th><th className={`${th} pr-5 text-right`}>Still open</th></tr></thead>
            <tbody>
              {disputes.map((m) => (
                <tr key={m.month}><td className={`${td} pl-5`}>{monthName(m.month)}</td>
                  <td className={`${td} text-right`}>{m.accepted ? `${m.accepted} · ${inr(m.acceptedAmt)}` : '—'}</td>
                  <td className={`${td} text-right`}>{m.disputed ? `${m.disputed} · ${inr(m.disputedAmt)}` : '—'}</td>
                  <td className={`${td} text-right`}>{m.won || '—'}</td>
                  <td className={`${td} text-right font-semibold text-emerald-700`}>{m.recovered ? inr(m.recovered) : '—'}</td>
                  <td className={`${td} pr-5 text-right`}>{m.open || '—'}</td></tr>
              ))}
              <tr className="bg-slate-50 font-bold"><td className={`${td} pl-5`}>6 months</td>
                <td className={`${td} text-right`}>{inr(disputes.reduce((s, m) => s + m.acceptedAmt, 0))}</td>
                <td className={`${td} text-right`}>{inr(disputes.reduce((s, m) => s + m.disputedAmt, 0))}</td>
                <td className={`${td} text-right`}>{disputes.reduce((s, m) => s + m.won, 0)}</td>
                <td className={`${td} text-right text-emerald-700`}>{inr(recovered)}</td>
                <td className={`${td} pr-5 text-right`}>{disputes.reduce((s, m) => s + m.open, 0)}</td></tr>
            </tbody>
          </table>
        </div>
      </Panel>
    </ReportPage>
  );
}
