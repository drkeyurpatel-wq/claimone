'use client';
// Payments → To check. Only what needs a person:
// bank money not tied to a bill, bills that are not on Master, and letter payments the bank does not show.
// Short payments of patients on Master are decided on Master (Payment cell), not here.
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Upload, CheckCircle2, Download, Landmark, FileWarning, Clock } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import type { ExceptionRow } from '@/lib/recon/api';
import { openMoney, type Open } from '@/lib/recon/auto';
import { fetchBillsNotOnMaster, fetchNotInBank, NOT_IN_BANK_DAYS, type NotInBank } from '@/lib/recon/tocheck';
import { CheckList } from '@/components/pay/CheckList';
import { UnmatchedMoney } from '@/components/pay/UnmatchedMoney';
import { NoCentre, Skeleton, inr, inrShort, shortDate, useToast } from '@/components/ui';

function Section({ icon: Icon, title, sub, count, amount, children }: {
  icon: typeof Landmark; title: string; sub: string; count: number; amount: number; children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 p-5">
        <div className="flex items-start gap-3">
          <Icon className="mt-1 h-5 w-5 shrink-0 text-amber-600" />
          <div>
            <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
            <p className="text-sm text-slate-600">{sub}</p>
          </div>
        </div>
        <p className="text-right"><span className="block text-lg font-bold tabular-nums text-slate-900">{inrShort(amount)}</span>
          <span className="text-sm text-slate-600">{count.toLocaleString('en-IN')}</span></p>
      </div>
      {children}
    </section>
  );
}

export default function ToCheck() {
  const centreId = useAuthStore((s) => s.activeCentreId);
  const role = useAuthStore((s) => s.staff?.role);
  const canWrite = role === 'admin' || role === 'manager' || role === 'desk';
  const { flash, toastNode } = useToast();
  const [money, setMoney] = useState<Open | null>(null);
  const [bills, setBills] = useState<ExceptionRow[] | null>(null);
  const [bank, setBank] = useState<NotInBank[] | null>(null);

  const load = useCallback(async () => {
    if (!centreId) return;
    const [m, b, k] = await Promise.all([openMoney(centreId), fetchBillsNotOnMaster(centreId), fetchNotInBank(centreId)]);
    setMoney(m); setBills(b); setBank(k);
  }, [centreId]);
  useEffect(() => { load(); }, [load]);

  if (!centreId) return <NoCentre />;
  const loading = !money || !bills || !bank;
  const clear = !loading && !money.receipts.length && !bills.length && !bank.length;

  const downloadBank = () => {
    const rows = [['Date', 'Amount', 'UTR', 'Patient', 'Payer'], ...(bank ?? []).map((r) => [r.value_date, String(Math.round(r.amount)), r.reference ?? '', r.patient ?? '', r.payer ?? ''])];
    const csv = '﻿' + rows.map((r) => r.map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `Not in bank ${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })}.csv`;
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-4 py-8 md:px-6">
      {toastNode}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">To check</h1>
          <p className="mt-1 text-base text-slate-600">Only what ClaimOne could not settle on its own. Short payments of patients on Master are decided on Master.</p>
        </div>
        <Link href="/pay" className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-slate-100 px-4 text-base font-medium text-slate-700 hover:bg-slate-200">
          <Upload className="h-5 w-5" /> Upload
        </Link>
      </div>

      {loading && <Skeleton rows={6} />}
      {clear && (
        <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-center">
          <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-600" />
          <p className="mt-2 text-lg font-semibold text-emerald-900">All clear. Nothing needs a person.</p>
        </section>
      )}

      {!loading && money.receipts.length > 0 && (
        <Section icon={Landmark} title="Money in the bank, not tied to a bill" sub="Confirm the suggested bill, or choose it."
          count={money.receipts.length} amount={money.receipts.reduce((a, r) => a + r.unallocated, 0)}>
          <UnmatchedMoney open={money} canWrite={canWrite} onChanged={load} flash={flash} />
        </Section>
      )}

      {!loading && bills.length > 0 && (
        <Section icon={FileWarning} title="Bills not on Master" sub="Older bills from the payment files with no patient on Master — mostly PMJAY. Pick the reason for a short payment, or mark it for follow-up."
          count={bills.length} amount={bills.reduce((a, r) => a + Math.abs(r.balance), 0)}>
          <div className="p-4"><CheckList rows={bills} canWrite={canWrite} onChanged={load} flash={flash} /></div>
        </Section>
      )}

      {!loading && bank.length > 0 && (
        <Section icon={Clock} title="Paid on the letter, not seen in the bank" sub={`The bank statement covers these dates but shows no credit with this UTR, ${NOT_IN_BANK_DAYS}+ days on. Check with the bank or the payer.`}
          count={bank.length} amount={bank.reduce((a, r) => a + r.amount, 0)}>
          <div className="flex justify-end px-4 pt-3">
            <button onClick={downloadBank} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"><Download className="h-4 w-4" /> Download list</button>
          </div>
          <ul className="divide-y divide-slate-100">
            {bank.slice(0, 300).map((r) => (
              <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3 text-base">
                <span><b>{r.patient ?? '—'}</b> <span className="text-slate-500">· {r.payer ?? ''}</span></span>
                <span className="tabular-nums text-slate-700">{inr(r.amount)} · {shortDate(r.value_date)} · UTR {r.reference ?? '—'}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
