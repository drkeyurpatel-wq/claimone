'use client';
// Portal bot health: last run per payer and the run history.
import { useEffect, useMemo, useState } from 'react';
import { Bot, RefreshCw } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import { fetchBotRuns, fetchPayers } from '@/lib/claims/api';
import type { BotRun, Payer } from '@/lib/claims/types';
import { PageHeader, Skeleton, Empty, NoCentre, dateTime, btn } from '@/components/ui';

const STATUS: Record<string, string> = {
  running: 'bg-blue-100 text-blue-700', success: 'bg-emerald-100 text-emerald-700', partial: 'bg-amber-100 text-amber-700',
  failed: 'bg-rose-100 text-rose-700', timeout: 'bg-orange-100 text-orange-700', captcha_blocked: 'bg-purple-100 text-purple-700',
  skipped: 'bg-slate-100 text-slate-600',
};
const ACTION: Record<string, string> = { check_status: 'Status check', submit_preauth: 'File pre-auth', submit_claim: 'File claim', download_letter: 'Download letters' };

export default function BotRuns() {
  const centreId = useAuthStore((s) => s.activeCentreId);
  const [runs, setRuns] = useState<BotRun[]>([]);
  const [payers, setPayers] = useState<Payer[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () => { if (!centreId) return; setLoading(true); Promise.all([fetchBotRuns(centreId), fetchPayers()]).then(([r, p]) => { setRuns(r); setPayers(p); setLoading(false); }); };
  useEffect(load, [centreId]); // eslint-disable-line react-hooks/exhaustive-deps

  const name = useMemo(() => Object.fromEntries(payers.map((p) => [p.id, p.name])), [payers]);
  const latest = useMemo(() => {
    const m = new Map<string, BotRun>();
    for (const r of runs) if (r.payer_id && !m.has(r.payer_id)) m.set(r.payer_id, r);
    return [...m.values()];
  }, [runs]);

  if (!centreId) return <NoCentre />;
  return (
    <div>
      <PageHeader title="Portal bot" sub="Runs on the mini PC at the hospital: checks payer portals and downloads letters" icon={Bot}>
        <button className={btn.ghost} onClick={load}><RefreshCw className="h-3.5 w-3.5" /> Refresh</button>
      </PageHeader>
      {loading ? <div className="p-6"><Skeleton /></div> : runs.length === 0 ? (
        <div className="m-6 rounded-2xl border bg-white"><Empty icon={Bot} title="The bot has not run at this centre yet" sub="See bot/README in the repository for setup. Filing is off until each portal config is verified." /></div>
      ) : (
        <div className="space-y-4 px-6 py-4">
          <div className="grid gap-3 md:grid-cols-3">
            {latest.map((r) => (
              <div key={r.payer_id} className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex items-center justify-between"><p className="text-sm font-semibold">{name[r.payer_id!] ?? 'Payer'}</p>
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${STATUS[r.status]}`}>{r.status.replace('_', ' ')}</span></div>
                <p className="mt-1 text-xs text-slate-500">{ACTION[r.action]} · {dateTime(r.started_at)}</p>
                {r.error_message && <p className="mt-1 text-xs text-rose-600">{r.error_message}</p>}
              </div>
            ))}
          </div>
          <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead><tr className="border-b bg-slate-50/80 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                <th className="px-4 py-3">Started</th><th className="px-4 py-3">Payer</th><th className="px-4 py-3">Action</th><th className="px-4 py-3">Result</th>
                <th className="px-4 py-3 text-right">Checked</th><th className="px-4 py-3 text-right">Updated</th><th className="px-4 py-3 text-right">Took</th><th className="px-4 py-3">Note</th>
              </tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-b border-slate-100 last:border-0">
                    <td className="px-4 py-2.5 text-xs">{dateTime(r.started_at)}</td>
                    <td className="px-4 py-2.5 text-xs">{r.payer_id ? name[r.payer_id] : '—'}</td>
                    <td className="px-4 py-2.5 text-xs">{ACTION[r.action]}</td>
                    <td className="px-4 py-2.5"><span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${STATUS[r.status]}`}>{r.status.replace('_', ' ')}</span></td>
                    <td className="tabular px-4 py-2.5 text-right">{r.claims_processed}</td>
                    <td className="tabular px-4 py-2.5 text-right">{r.claims_updated}</td>
                    <td className="tabular px-4 py-2.5 text-right text-xs text-slate-500">{r.duration_ms != null ? `${Math.round(r.duration_ms / 1000)}s` : '—'}</td>
                    <td className="max-w-xs truncate px-4 py-2.5 text-xs text-slate-500" title={r.error_message ?? ''}>{r.error_message ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
