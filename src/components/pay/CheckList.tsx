'use client';
// Check list — staff screen 2 of 2: only the bills that don't add up.
// Built for the data-entry desk: biggest money first, search, one reason for
// many bills at once, small rounding differences closed in one click, and a
// download to send to the TPA.
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Download, Search, Loader2 } from 'lucide-react';
import { addAdjustment, setDisputed, acceptPaidAmount, type ExceptionRow, type Problem } from '@/lib/recon/api';
import { DISALLOWANCE_CATEGORIES } from '@/lib/engine/settlement';
import { Skeleton, inr, inrShort, shortDate, btn } from '@/components/ui';
import { csvOf, SMALL_DIFF } from '@/lib/recon/exceptions';

const PROBLEM: Record<Problem, { title: string; help: string; tone: string; amountLabel: string }> = {
  short: { title: 'Paid less', amountLabel: 'Short by', tone: 'border-amber-300 bg-amber-50',
    help: 'Find why on the letter or TPA website. Tick the bills, pick the reason, press Save.' },
  overdue: { title: 'Not paid yet', amountLabel: 'Due', tone: 'border-rose-300 bg-rose-50',
    help: 'No money for over 30 days (45 for PMJAY). Call the TPA or check the portal, write what you did, press Save.' },
  over: { title: 'Paid more', amountLabel: 'Extra', tone: 'border-sky-300 bg-sky-50',
    help: 'More money came than the bill on file. If the payment is right, tick and press the green button.' },
};

const big = 'min-h-11 px-4 text-sm';

/** Run calls a few at a time so 100 bills don't hit the server at once. */
async function inBatches<T>(items: T[], f: (x: T) => Promise<unknown>, size = 5) {
  let failed = 0;
  for (let i = 0; i < items.length; i += size) {
    const r = await Promise.allSettled(items.slice(i, i + size).map(f));
    failed += r.filter((x) => x.status === 'rejected').length;
  }
  return failed;
}

export function CheckList({ rows, canWrite, onChanged, flash }: {
  rows: ExceptionRow[] | null; canWrite: boolean; onChanged: () => void; flash: (t: string, tone?: 'ok' | 'err') => void;
}) {
  const [tab, setTab] = useState<Problem>('short');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [cat, setCat] = useState('');
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState('');

  const groups = useMemo(() => {
    const g: Record<Problem, ExceptionRow[]> = { short: [], overdue: [], over: [] };
    for (const r of rows ?? []) g[r.problem]?.push(r);
    for (const k of Object.keys(g) as Problem[]) g[k].sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
    return g;
  }, [rows]);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const all = groups[tab].filter((r) => !(tab === 'short' && r.balance < SMALL_DIFF));
    if (!s) return all;
    return all.filter((r) => [r.patient_name, r.uhid, r.bill_no, r.claim_ref, r.debtor_name].some((v) => v?.toLowerCase().includes(s)));
  }, [groups, tab, q]);
  const small = useMemo(() => groups.short.filter((r) => r.balance < SMALL_DIFF), [groups]);

  if (!rows) return <Skeleton rows={4} />;
  if (!rows.length) return (
    <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-center">
      <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-600" />
      <p className="mt-2 text-lg font-semibold text-emerald-900">All clear. Every payment matches its bill.</p>
    </section>
  );

  const sum = (xs: ExceptionRow[]) => xs.reduce((a, r) => a + Math.abs(r.balance), 0);
  const chosen = list.filter((r) => picked.has(r.receivable_id));
  const switchTab = (p: Problem) => { setTab(p); setPicked(new Set()); setQ(''); };
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const finish = (failed: number, ok: string) => {
    if (failed) flash(`${failed} could not be saved — try them again.`, 'err'); else flash(ok);
    setPicked(new Set()); setCat(''); setWhy(''); setBusy(''); onChanged();
  };

  const saveReason = async () => {
    setBusy('reason');
    const f = await inBatches(chosen, (r) => addAdjustment(r.receivable_id, {
      kind: 'deduction', amount: Math.round(r.balance * 100) / 100, category: cat, reason_text: why.trim() }));
    finish(f, `Reason saved on ${chosen.length - f} bill${chosen.length - f === 1 ? '' : 's'}.`);
  };
  const dispute = async () => {
    setBusy('dispute');
    const note = why.trim() || (tab === 'short' ? 'Short payment disputed with payer' : 'Following up with payer');
    const f = await inBatches(chosen, (r) => setDisputed(r.receivable_id, note));
    finish(f, `${chosen.length - f} moved to follow-up.`);
  };
  const acceptOver = async () => {
    setBusy('over');
    const f = await inBatches(chosen, (r) => acceptPaidAmount(r.receivable_id, r.expected_amount - r.balance));
    finish(f, `${chosen.length - f} bill amounts updated to what was paid.`);
  };
  const closeSmall = async () => {
    setBusy('small');
    const f = await inBatches(small, (r) => addAdjustment(r.receivable_id, {
      kind: 'rounding', amount: Math.round(r.balance * 100) / 100, reason_text: 'Small difference closed' }));
    finish(f, `${small.length - f} small differences closed.`);
  };
  const download = () => {
    const blob = new Blob([csvOf(list, PROBLEM[tab].amountLabel)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${PROBLEM[tab].title.replace(/[^A-Za-z]+/g, '_')}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white">
      <div className="border-b border-slate-100 p-5">
        <div className="grid gap-2 sm:grid-cols-3">
          {(Object.keys(PROBLEM) as Problem[]).map((p) => (
            <button key={p} onClick={() => switchTab(p)} aria-pressed={tab === p}
              className={`rounded-xl border px-4 py-3 text-left transition ${tab === p ? `${PROBLEM[p].tone} ring-2 ring-offset-1 ring-slate-300` : 'border-slate-200 bg-white hover:bg-slate-50'}`}>
              <span className="block text-sm font-semibold text-slate-900">{PROBLEM[p].title}</span>
              <span className="tabular mt-0.5 block text-lg font-bold text-slate-900">{inrShort(sum(groups[p]))}</span>
              <span className="text-xs text-slate-600">{groups[p].length.toLocaleString('en-IN')} bills</span>
            </button>
          ))}
        </div>
        <p className="mt-3 text-base text-slate-700">{PROBLEM[tab].help}</p>

        {tab === 'short' && small.length > 0 && canWrite && (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
            <span><b>{small.length}</b> bills are short by less than ₹{SMALL_DIFF} (total {inr(sum(small))}). These are rounding — close them.</span>
            <button onClick={closeSmall} disabled={!!busy} className={`${btn.ghost} ${big}`}>
              {busy === 'small' && <Loader2 className="h-4 w-4 animate-spin" />} Close all {small.length}
            </button>
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="relative min-w-[220px] flex-1">
            <span className="sr-only">Search</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a patient, UHID or bill no."
              className={`${btn.input} min-h-11 w-full pl-9`} />
          </label>
          <button onClick={download} disabled={!list.length} className={`${btn.ghost} ${big}`}><Download className="h-4 w-4" /> Download list</button>
        </div>
      </div>

      {canWrite && chosen.length > 0 && (
        <div className="sticky top-0 z-10 flex flex-wrap items-end gap-2 border-b border-teal-200 bg-teal-50 p-4">
          <p className="w-full text-sm font-semibold text-teal-900">{chosen.length} ticked · {inr(sum(chosen))}</p>
          {tab === 'short' && (
            <>
              <label className="text-xs font-semibold text-slate-700">Reason
                <select value={cat} onChange={(e) => setCat(e.target.value)} className={`${btn.input} mt-1 block min-h-11`}>
                  <option value="">Choose…</option>
                  {Object.entries(DISALLOWANCE_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
              </label>
              <label className="min-w-[220px] flex-1 text-xs font-semibold text-slate-700">What the letter / portal says
                <input value={why} onChange={(e) => setWhy(e.target.value)} className={`${btn.input} mt-1 block min-h-11 w-full font-normal`} />
              </label>
              <button onClick={saveReason} disabled={!!busy || !cat || !why.trim()} className={`${btn.primary} ${big}`}>
                {busy === 'reason' && <Loader2 className="h-4 w-4 animate-spin" />} Save reason
              </button>
              <button onClick={dispute} disabled={!!busy} className={`${btn.ghost} ${big}`}>Dispute with payer</button>
            </>
          )}
          {tab === 'overdue' && (
            <>
              <label className="min-w-[260px] flex-1 text-xs font-semibold text-slate-700">What you did (e.g. query raised on portal on …)
                <input value={why} onChange={(e) => setWhy(e.target.value)} className={`${btn.input} mt-1 block min-h-11 w-full font-normal`} />
              </label>
              <button onClick={dispute} disabled={!!busy || !why.trim()} className={`${btn.primary} ${big}`}>Move to follow-up</button>
            </>
          )}
          {tab === 'over' && (
            <button onClick={acceptOver} disabled={!!busy} className={`${btn.primary} ${big}`}>
              {busy === 'over' && <Loader2 className="h-4 w-4 animate-spin" />} Payment is right — update {chosen.length} bill{chosen.length === 1 ? '' : 's'}
            </button>
          )}
        </div>
      )}

      {list.length === 0 ? <p className="p-6 text-center text-sm text-slate-500">{q ? 'No bill matches that search.' : 'None.'}</p> : (
        <ul className="divide-y divide-slate-100">
          {canWrite && (
            <li className="flex items-center gap-3 bg-slate-50 px-4 py-2 text-xs font-semibold text-slate-600">
              <input type="checkbox" aria-label="Tick all shown" className="h-5 w-5 accent-teal-600"
                checked={list.slice(0, 300).every((r) => picked.has(r.receivable_id))}
                onChange={(e) => setPicked(e.target.checked ? new Set(list.slice(0, 300).map((r) => r.receivable_id)) : new Set())} />
              Tick all · biggest first
            </li>
          )}
          {list.slice(0, 300).map((r) => {
            const received = r.allocated + r.tds + r.deduction;
            return (
              <li key={r.receivable_id} className={`flex gap-3 px-4 py-3 ${picked.has(r.receivable_id) ? 'bg-teal-50/60' : ''}`}>
                {canWrite && <input type="checkbox" aria-label={`Tick ${r.bill_no ?? r.claim_ref ?? 'bill'}`} className="mt-1 h-5 w-5 shrink-0 accent-teal-600"
                  checked={picked.has(r.receivable_id)} onChange={() => toggle(r.receivable_id)} />}
                <div className="grid min-w-0 flex-1 gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_auto]">
                  <div className="min-w-0">
                    <Link href={`/receivables/${r.receivable_id}`} className="font-medium text-slate-900 hover:underline">{r.patient_name ?? '—'}</Link>
                    <p className="truncate text-xs text-slate-500">{r.debtor_name}{r.uhid ? ` · UHID ${r.uhid}` : ''}</p>
                  </div>
                  <div className="text-xs text-slate-600">
                    <p>{r.bill_no ?? '—'} · {shortDate(r.bill_date)}</p>
                    {r.claim_ref && <p className="text-slate-500">Claim {r.claim_ref}</p>}
                  </div>
                  <div className="tabular text-left text-sm sm:text-right">
                    <p className="text-base font-bold text-slate-900">{inr(Math.abs(r.balance))} <span className="text-xs font-normal text-slate-500">{PROBLEM[tab].amountLabel.toLowerCase()}</span></p>
                    <p className="text-xs text-slate-500">Billed {inr(r.expected_amount)} · got {received > 0 ? inr(received) : '—'} · {r.age_days} days</p>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {list.length > 300 && <p className="border-t border-slate-100 p-3 text-xs text-slate-500">Showing the biggest 300 of {list.length.toLocaleString('en-IN')}. Search to find any bill, or download the full list.</p>}
    </section>
  );
}
