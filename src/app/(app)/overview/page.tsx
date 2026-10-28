'use client';
// Manager overview: money owed and how old, where cases are stuck,
// deductions and why, payer turnaround, and collections.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, ChevronRight } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import { sb } from '@/lib/supabase/browser';
import { allRows } from '@/lib/supabase/pages';
import { fetchAllPayers, fetchOpenCases } from '@/lib/rcm/api';
import {
  ageing, collections, deductions, pipeline, turnaround, BUCKETS,
  type Ageing, type OpenBill, type PayerInfo, type LeakLite, type ReceiptLite, type TransitionLite,
} from '@/lib/rcm/overview';
import { NoCentre, inrShort } from '@/components/ui';

interface Data {
  age: Ageing; pipe: ReturnType<typeof pipeline>; ded: ReturnType<typeof deductions>;
  coll: ReturnType<typeof collections>; tat: ReturnType<typeof turnaround>;
}

const since = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

async function load(centreId: string): Promise<Data> {
  const [bills, payers, adj, rcpt, trans, cases] = await Promise.all([
    allRows<Record<string, unknown>>((f, t) => sb().from('clm_v_receivable_balance')
      .select('debtor_type, payer_id, debtor_name, doctor_name, balance, age_days, billed_amount, expected_amount, deduction, recon_status, status')
      .eq('centre_id', centreId).order('id').range(f, t)),
    fetchAllPayers(),
    allRows<Record<string, unknown>>((f, t) => sb().from('clm_v_leakage').select('kind, category, doctor_name, amount, month')
      .eq('centre_id', centreId).gte('month', since(365).slice(0, 10)).order('month').order('payer_id').order('doctor_name').order('category').range(f, t)),
    allRows<Record<string, unknown>>((f, t) => sb().from('clm_receipts').select('value_date, amount, source, bank_receipt_id')
      .eq('centre_id', centreId).gte('value_date', since(200).slice(0, 10)).order('id').range(f, t)),
    allRows<Record<string, unknown>>((f, t) => sb().from('clm_state_transitions').select('claim_id, from_status, to_status, created_at, clm_claims!inner(centre_id)')
      .eq('clm_claims.centre_id', centreId).gte('created_at', since(180)).order('id').range(f, t)),
    fetchOpenCases(centreId),
  ]);
  if (bills.error) throw new Error('Could not load money owed');
  const N = (x: unknown) => Number(x ?? 0);
  const pm = new Map<string, PayerInfo>(payers.map((p) => [p.id, { id: p.id, code: p.code, name: p.name }]));
  const B = ((bills.data ?? []) as Record<string, unknown>[]).map((b) => ({ ...b, balance: N(b.balance), age_days: N(b.age_days), billed_amount: b.billed_amount == null ? null : N(b.billed_amount),
    expected_amount: N(b.expected_amount), deduction: N(b.deduction) })) as OpenBill[];
  return {
    age: ageing(B, pm),
    pipe: pipeline(cases.map((x) => x.step)),
    ded: deductions(((adj.data ?? []) as unknown as LeakLite[]).map((a) => ({ ...a, amount: N(a.amount) }))),
    coll: collections(((rcpt.data ?? []) as unknown as ReceiptLite[]).map((r) => ({ ...r, amount: N(r.amount) }))),
    tat: turnaround((trans.data ?? []) as unknown as TransitionLite[]),
  };
}

function Bar({ value, max, tone = 'bg-teal-500' }: { value: number; max: number; tone?: string }) {
  return <div className="h-2.5 w-full rounded-full bg-slate-100"><div className={`h-2.5 rounded-full ${tone}`} style={{ width: `${max > 0 ? Math.max(2, (value / max) * 100) : 0}%` }} /></div>;
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-sm text-slate-500">{label}</p>
      <p className={`text-2xl font-bold ${tone ?? 'text-slate-900'}`}>{value}</p>
      {sub && <p className="text-sm text-slate-500">{sub}</p>}
    </div>
  );
}

const BUCKET_TONE = ['bg-emerald-500', 'bg-lime-500', 'bg-amber-400', 'bg-orange-500', 'bg-rose-600'];

export default function Overview() {
  const centreId = useAuthStore((s) => s.activeCentreId);
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!centreId) return;
    setD(null);
    load(centreId).then(setD).catch((e) => setError((e as Error).message));
  }, [centreId]);

  if (!centreId) return <NoCentre />;
  if (error) return <p className="m-8 rounded-lg bg-rose-50 p-4 text-base text-rose-800">{error}</p>;
  if (!d) return <div className="flex min-h-[60vh] items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-teal-600" /></div>;

  const maxPayer = d.age.byPayer[0]?.total ?? 0;
  const maxColl = Math.max(...d.coll.map((c) => c.amount), 0);
  const maxDed = d.ded.byReason[0]?.amount ?? 0;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 md:px-6">
      <h1 className="text-2xl font-bold text-slate-900">Overview</h1>
      <p className="mt-1 text-base text-slate-600">All credit business at this centre — insurance, PMJAY, government schemes, companies and patient dues.</p>

      <div className="mt-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Money owed" value={inrShort(d.age.total)} sub={`${d.age.count.toLocaleString('en-IN')} bills`} />
        <Tile label="Older than 90 days" value={inrShort(d.age.over90)} sub={d.age.total ? `${Math.round((d.age.over90 / d.age.total) * 100)}% of owed` : undefined} tone={d.age.over90 ? 'text-rose-700' : undefined} />
        <Tile label="Lost to deductions (1 yr)" value={inrShort(d.ded.total)} />
        <Tile label="Collected this month" value={inrShort(d.coll[d.coll.length - 1]?.amount ?? 0)} />
      </div>

      {/* Desks */}
      <div className="mt-6 grid gap-3 md:grid-cols-3">
        {([['admission', 'Pre-auth & in hospital', '/patients?stage=preauth'], ['claims', 'Discharge & claims', '/patients?stage=discharge']] as const).map(([k, label, href]) => (
          <Link key={k} href={href} className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 hover:border-teal-400">
            <div className="flex-1">
              <p className="font-semibold text-slate-900">{label}</p>
              <p className="text-sm text-slate-600">{d.pipe[k].todo} to do · <span className={d.pipe[k].late ? 'font-semibold text-rose-700' : ''}>{d.pipe[k].late} late</span> · {d.pipe[k].waiting} waiting</p>
            </div>
            <ChevronRight className="h-5 w-5 text-slate-300" />
          </Link>
        ))}
        <Link href="/patients?stage=payment" className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 hover:border-teal-400">
          <div className="flex-1">
            <p className="font-semibold text-slate-900">Approved, waiting for money</p>
            <p className="text-sm text-slate-600">{d.pipe.payment.count} cases · <span className={d.pipe.payment.late ? 'font-semibold text-rose-700' : ''}>{d.pipe.payment.late} late</span></p>
          </div>
          <ChevronRight className="h-5 w-5 text-slate-300" />
        </Link>
      </div>

      {/* Ageing by category */}
      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5">
        <h2 className="text-lg font-semibold text-slate-900">How old is the money owed</h2>
        <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-600">
          {BUCKETS.map((b, i) => <span key={b} className="flex items-center gap-1"><span className={`h-2.5 w-2.5 rounded-sm ${BUCKET_TONE[i]}`} />{b} days</span>)}
        </div>
        <div className="mt-4 space-y-4">
          {d.age.byCategory.map((c) => (
            <div key={c.category}>
              <div className="flex justify-between text-sm"><span className="font-medium text-slate-800">{c.category}</span><span className="font-semibold text-slate-900">{inrShort(c.total)}</span></div>
              <div className="mt-1 flex h-4 w-full overflow-hidden rounded-full bg-slate-100" role="img"
                aria-label={`${c.category}: ${BUCKETS.map((b) => `${b} days ${inrShort(c.buckets[b])}`).join(', ')}`}>
                {BUCKETS.map((b, i) => c.buckets[b] > 0 && (
                  <div key={b} className={BUCKET_TONE[i]} style={{ width: `${(c.buckets[b] / c.total) * 100}%` }} title={`${b} days: ${inrShort(c.buckets[b])}`} />
                ))}
              </div>
            </div>
          ))}
          {!d.age.byCategory.length && <p className="text-base text-slate-500">Nothing owed.</p>}
        </div>
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* By payer */}
        <section className="rounded-2xl border border-slate-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-slate-900">Who owes most</h2>
          <ul className="mt-3 space-y-3">
            {d.age.byPayer.slice(0, 10).map((p) => (
              <li key={p.name}>
                <div className="flex justify-between gap-2 text-sm"><span className="truncate text-slate-800">{p.name}</span>
                  <span className="shrink-0 font-semibold text-slate-900">{inrShort(p.total)}{p.over90 > 0 && <span className="ml-2 font-normal text-rose-700">{inrShort(p.over90)} &gt;90d</span>}</span></div>
                <Bar value={p.total} max={maxPayer} />
              </li>
            ))}
          </ul>
        </section>

        {/* Collections */}
        <section className="rounded-2xl border border-slate-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-slate-900">Money collected</h2>
          <div className="mt-4 flex h-44 items-end gap-3">
            {d.coll.map((c) => (
              <div key={c.month} className="flex flex-1 flex-col items-center gap-1">
                <span className="text-xs font-medium text-slate-700">{c.amount ? inrShort(c.amount) : ''}</span>
                <div className="w-full rounded-t-md bg-teal-500" style={{ height: `${maxColl ? Math.max(2, (c.amount / maxColl) * 120) : 2}px` }} />
                <span className="text-xs text-slate-500">{MONTHS[Number(c.month.slice(5)) - 1]}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Deductions */}
        <section className="rounded-2xl border border-slate-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-slate-900">Why money was cut</h2>
          <ul className="mt-3 space-y-3">
            {d.ded.byReason.map((r) => (
              <li key={r.reason}><div className="flex justify-between text-sm"><span className="text-slate-800">{r.reason}</span><span className="font-semibold">{inrShort(r.amount)}</span></div>
                <Bar value={r.amount} max={maxDed} tone="bg-rose-400" /></li>
            ))}
            {!d.ded.byReason.length && <li className="text-base text-slate-500">No deductions recorded.</li>}
          </ul>
          {d.ded.byDoctor.length > 0 && <>
            <h3 className="mt-5 text-sm font-semibold text-slate-700">By doctor</h3>
            <ul className="mt-2 divide-y divide-slate-100 text-sm">
              {d.ded.byDoctor.map((x) => <li key={x.doctor} className="flex justify-between py-1.5"><span className="text-slate-700">{x.doctor}</span><span className="font-medium">{inrShort(x.amount)}</span></li>)}
            </ul>
          </>}
        </section>

        {/* Turnaround */}
        <section className="rounded-2xl border border-slate-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-slate-900">How fast payers answer (last 6 months)</h2>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Tile label="Pre-auth answer" value={d.tat.preauthHours == null ? '—' : `${d.tat.preauthHours} h`} sub={`median of ${d.tat.preauthCount}`}
              tone={d.tat.preauthHours != null && d.tat.preauthHours > 1 ? 'text-amber-700' : undefined} />
            <Tile label="Claim decision" value={d.tat.claimDays == null ? '—' : `${d.tat.claimDays} days`} sub={`median of ${d.tat.claimCount}`} />
          </div>
          <p className="mt-3 text-sm text-slate-500">Insurer target: pre-auth answered within 1 hour, discharge within 3 hours (IRDAI).</p>
        </section>
      </div>
    </div>
  );
}
