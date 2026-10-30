'use client';
// Receivables: what every insurer, scheme, patient and referrer still owes,
// net of receipts, TDS, deductions and write-offs.
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Wallet, Clock, AlertTriangle, Users, Banknote, Search, Upload, GitMerge } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import { fetchReceivables, fetchReceipts, type ReceivableRow, type ReceiptRow } from '@/lib/recon/api';
import { PageHeader, StatCard, Skeleton, Empty, NoCentre, inr, inrShort, shortDate, btn } from '@/components/ui';

const BUCKETS = ['0-30', '31-60', '61-90', '91-180', '180+'] as const;
const bucket = (d: number) => (d <= 30 ? '0-30' : d <= 60 ? '31-60' : d <= 90 ? '61-90' : d <= 180 ? '91-180' : '180+');
const BUCKET_COLOR: Record<string, string> = { '0-30': 'bg-teal-500', '31-60': 'bg-slate-700', '61-90': 'bg-amber-600', '91-180': 'bg-rose-600', '180+': 'bg-rose-900' };
const STATUS: Record<string, { label: string; cls: string }> = {
  open: { label: 'Unpaid', cls: 'bg-amber-50 text-amber-700' },
  part_received: { label: 'Part received', cls: 'bg-orange-50 text-orange-700' },
  settled: { label: 'Settled', cls: 'bg-emerald-50 text-emerald-700' },
  over_received: { label: 'Over-received', cls: 'bg-purple-50 text-purple-700' },
  disputed: { label: 'Disputed', cls: 'bg-rose-50 text-rose-700' },
};
type Tab = 'payers' | 'patients' | 'all' | 'settled';

export default function Receivables() {
  const router = useRouter();
  const centreId = useAuthStore((s) => s.activeCentreId);
  const [rows, setRows] = useState<ReceivableRow[]>([]);
  const [receipts, setReceipts] = useState<ReceiptRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('payers');
  const [q, setQ] = useState('');
  const [debtor, setDebtor] = useState('');

  useEffect(() => {
    if (!centreId) return;
    setLoading(true);
    Promise.all([fetchReceivables(centreId), fetchReceipts(centreId, { unallocatedOnly: true })])
      .then(([r, rc]) => { setRows(r); setReceipts(rc); setLoading(false); });
  }, [centreId]);

  const isPatient = (r: ReceivableRow) => r.debtor_type === 'patient' || r.debtor_type === 'referrer';
  const open = rows.filter((r) => r.recon_status !== 'settled');
  const owed = (xs: ReceivableRow[]) => xs.reduce((s, r) => s + Math.max(0, r.balance), 0);
  const payerOpen = open.filter((r) => !isPatient(r));
  const patientOpen = open.filter(isPatient);
  const old = payerOpen.filter((r) => r.age_days > 60);
  const short = payerOpen.filter((r) => r.recon_status === 'part_received');
  const unalloc = receipts.reduce((s, r) => s + r.unallocated, 0);

  const ageing = useMemo(() => BUCKETS.map((b) => {
    const xs = payerOpen.filter((r) => bucket(r.age_days) === b);
    return { b, n: xs.length, amt: owed(xs) };
  }), [payerOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  const maxAge = Math.max(1, ...ageing.map((a) => a.amt));

  const debtors = useMemo(() => [...new Set(rows.map((r) => r.debtor_name))].sort(), [rows]);
  const shown = useMemo(() => {
    let xs = tab === 'payers' ? payerOpen : tab === 'patients' ? patientOpen : tab === 'settled' ? rows.filter((r) => r.recon_status === 'settled') : rows;
    if (debtor) xs = xs.filter((r) => r.debtor_name === debtor);
    if (q) {
      const s = q.toLowerCase();
      xs = xs.filter((r) => `${r.patient_name ?? ''} ${r.bill_no ?? ''} ${r.claim_ref ?? ''} ${r.ip_no ?? ''} ${r.care_of ?? ''}`.toLowerCase().includes(s));
    }
    return [...xs].sort((a, b) => b.age_days - a.age_days);
  }, [rows, tab, debtor, q]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!centreId) return <NoCentre />;
  return (
    <div>
      <PageHeader title="Receivables" sub="What each payer and patient still owes, after receipts, TDS, deductions and write-offs" icon={Wallet}>
        <Link href="/receivables/import" className={btn.ghost}><Upload className="h-3.5 w-3.5" /> Import</Link>
        <Link href="/receivables/reconcile" className={btn.primary}><GitMerge className="h-4 w-4" /> Reconcile</Link>
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 px-6 pt-4 md:grid-cols-5">
        <StatCard label="Payers owe" value={inrShort(owed(payerOpen))} sub={`${payerOpen.length} bills`} icon={Wallet} tone="amber" onClick={() => setTab('payers')} />
        <StatCard label="Over 60 days" value={inrShort(owed(old))} sub={`${old.length} bills`} icon={Clock} tone="rose" />
        <StatCard label="Short-paid, open" value={inrShort(owed(short))} sub={`${short.length} bills need a reason`} icon={AlertTriangle} tone="orange" />
        <StatCard label="Patients & referrers" value={inrShort(owed(patientOpen))} sub={`${patientOpen.length} people`} icon={Users} tone="purple" onClick={() => setTab('patients')} />
        <StatCard label="Receipts not matched" value={inrShort(unalloc)} sub={`${receipts.length} bank lines`} icon={Banknote} tone="slate" onClick={() => router.push('/receivables/reconcile')} />
      </div>

      {!loading && payerOpen.length > 0 && (
        <section className="mx-6 mt-4 rounded-2xl border border-slate-200 bg-white p-5">
          <h2 className="mb-3 text-sm font-bold text-slate-900">Payers — days since bill</h2>
          <div className="space-y-2">
            {ageing.map((a) => (
              <div key={a.b} className="grid grid-cols-12 items-center gap-3 text-sm">
                <span className="col-span-3 text-slate-600 md:col-span-2">{a.b} days · {a.n}</span>
                <div className="col-span-6 h-6 rounded bg-slate-100 md:col-span-8"><div className={`h-6 rounded ${BUCKET_COLOR[a.b]}`} style={{ width: `${(100 * a.amt) / maxAge}%` }} /></div>
                <span className="tabular col-span-3 text-right font-semibold md:col-span-2">{inrShort(a.amt)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-2 px-6 pt-4">
        {([['payers', 'Payers'], ['patients', 'Patients & referrers'], ['all', 'All'], ['settled', 'Settled']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={`inline-flex min-h-11 items-center rounded-lg px-3.5 text-sm font-medium ${tab === k ? 'bg-teal-600 text-white' : 'border bg-white text-slate-600'}`}>{l}</button>
        ))}
        <div className="relative"><Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input aria-label="Search bills" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Patient, bill, claim no." className="w-52 min-h-11 rounded-lg border border-slate-200 pl-8 pr-3 text-sm" /></div>
        <select aria-label="Who owes" value={debtor} onChange={(e) => setDebtor(e.target.value)} className="min-h-11 rounded-lg border border-slate-200 px-2 text-sm">
          <option value="">All debtors</option>{debtors.map((d) => <option key={d}>{d}</option>)}
        </select>
      </div>

      <div className="px-6 py-4">
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          {loading ? <Skeleton rows={8} /> : rows.length === 0 ? (
            <Empty icon={Wallet} title="No receivables yet" sub="Approved claims appear here automatically. Import the cashless tracker or patient dues to bring in what is already owed.">
              <Link href="/receivables/import" className={btn.primary}><Upload className="h-4 w-4" /> Import</Link>
            </Empty>
          ) : shown.length === 0 ? <Empty icon={Wallet} title="Nothing matches" /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b bg-slate-50/80 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  <th className="px-4 py-3">Bill</th><th className="px-4 py-3">Patient</th><th className="px-4 py-3">Owed by</th><th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Owed</th><th className="px-4 py-3 text-right">Received</th><th className="px-4 py-3 text-right">TDS + deductions</th>
                  <th className="px-4 py-3 text-right">Balance</th><th className="px-4 py-3 text-right">Days</th>
                </tr></thead>
                <tbody>
                  {shown.slice(0, 500).map((r) => (
                    <tr key={r.id} onClick={() => router.push(`/receivables/${r.id}`)} className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-teal-50/40">
                      <td className="px-4 py-2.5"><p className="font-mono text-xs">{r.bill_no ?? r.claim_ref ?? '—'}</p><p className="text-[11px] text-slate-400">{shortDate(r.bill_date)}</p></td>
                      <td className="px-4 py-2.5"><p className="font-medium">{r.patient_name ?? '—'}</p>{r.care_of && <p className="text-[11px] text-slate-500">{r.care_of}</p>}</td>
                      <td className="px-4 py-2.5 text-xs text-slate-600">{r.debtor_name}</td>
                      <td className="px-4 py-2.5"><span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS[r.recon_status].cls}`}>{STATUS[r.recon_status].label}</span></td>
                      <td className="tabular px-4 py-2.5 text-right">{inr(r.expected_amount)}</td>
                      <td className="tabular px-4 py-2.5 text-right text-emerald-700">{r.allocated ? inr(r.allocated) : '—'}</td>
                      <td className="tabular px-4 py-2.5 text-right text-slate-500">{r.tds + r.deduction + r.write_off ? inr(r.tds + r.deduction + r.write_off) : '—'}</td>
                      <td className={`tabular px-4 py-2.5 text-right font-semibold ${r.balance > 1 ? 'text-slate-900' : r.balance < -1 ? 'text-purple-700' : 'text-slate-400'}`}>{inr(r.balance)}</td>
                      <td className={`tabular px-4 py-2.5 text-right ${r.age_days > 60 && r.balance > 1 ? 'font-bold text-rose-600' : 'text-slate-500'}`}>{r.age_days}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {shown.length > 500 && <p className="p-3 text-xs text-slate-500">Showing 500 of {shown.length}. Filter to narrow down.</p>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
