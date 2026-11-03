'use client';
// The PMJAY desk uploads its month sheet (the same one it keeps every day).
// New cases are added to Master, existing ones move forward to the sheet's
// case status, and a row with a UTR and final amount books the payment.
import { useState } from 'react';
import Link from 'next/link';
import { Upload, Loader2, CheckCircle2, FileText, X, AlertTriangle } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import type { Cell } from '@/lib/recon/payments';
import { isPmjaySheet, parsePmjay, pmjayWarnings, type PmjayRow } from '@/lib/rcm/pmjay';
import { importPmjay, type PmjayResult } from '@/lib/rcm/api';
import { NoCentre } from '@/components/ui';

const n = (x: number) => x.toLocaleString('en-IN');
const rupees = (x: number) => `₹${x.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

async function readPmjay(f: File): Promise<PmjayRow[]> {
  if (/\.xls$/i.test(f.name)) throw new Error('This is an old Excel file (.xls). Open it in Excel, choose Save As → .xlsx, and add it again.');
  if (!/\.(xlsx|xlsm)$/i.test(f.name)) throw new Error('Add the PMJAY Excel sheet (.xlsx).');
  const { default: readXlsxFile, readSheetNames } = await import('read-excel-file');
  const rows: PmjayRow[] = [];
  for (const sheet of await readSheetNames(f)) {
    const cells = (await readXlsxFile(f, { sheet })) as Cell[][];
    if (isPmjaySheet(cells)) rows.push(...parsePmjay(cells).rows);
  }
  if (!rows.length) throw new Error('This does not look like the PMJAY sheet — it needs the columns IP NO, PATIENT NAME and NABH.');
  return rows;
}

export default function UploadPmjay() {
  const centreId = useAuthStore((s) => s.activeCentreId);
  const role = useAuthStore((s) => s.staff?.role);
  const canWrite = role === 'admin' || role === 'manager' || role === 'desk';
  const [file, setFile] = useState<{ name: string; rows: PmjayRow[] } | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState('');
  const [result, setResult] = useState<PmjayResult | null>(null);

  const add = async (f: File | undefined) => {
    if (!f) return;
    setError(''); setResult(null); setReading(true);
    try { setFile({ name: f.name, rows: await readPmjay(f) }); } catch (e) { setError((e as Error).message); setFile(null); }
    setReading(false);
  };

  const save = async () => {
    if (!centreId || !file) return;
    setError('');
    try {
      setSaving('Saving…');
      setResult(await importPmjay(centreId, file.name, file.rows, (k) => setSaving(`Saving ${n(k)} of ${n(file.rows.length)}`)));
    } catch (e) { setError((e as Error).message); }
    setSaving('');
  };

  if (!centreId) return <NoCentre />;
  if (!canWrite) return <div className="p-10 text-center text-base text-slate-600">Your login can only view.</div>;

  const warn = file ? pmjayWarnings(file.rows) : [];
  const nabh = file ? file.rows.reduce((a, r) => a + (r.nabh_amount ?? 0), 0) : 0;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 md:px-6">
      <h1 className="text-2xl font-bold text-slate-900">Import PMJAY sheet</h1>
      <p className="mt-1 text-base text-slate-600">Add the month&apos;s PMJAY sheet and press <b>Save</b>. Upload it again whenever it changes — nothing is added twice.</p>
      <p className="mt-1 text-sm text-slate-500">The claim is the <b>NABH</b> amount. The NO NABH amount is kept alongside.</p>

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5">
        <label
          onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); add(e.dataTransfer.files[0]); }}
          className="flex min-h-40 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 p-8 text-center transition hover:border-teal-400 hover:bg-slate-50">
          {reading ? <Loader2 className="h-10 w-10 animate-spin text-teal-600" /> : <Upload className="h-10 w-10 text-teal-600" />}
          <span className="text-lg font-semibold text-slate-800">{reading ? 'Reading…' : 'Tap here to choose the PMJAY sheet'}</span>
          <span className="text-sm text-slate-500">Excel (.xlsx)</span>
          <input type="file" accept=".xlsx,.xlsm,.xls" className="hidden" onChange={(e) => { add(e.target.files?.[0]); e.target.value = ''; }} />
        </label>

        {file && (
          <div className="mt-4 flex items-start gap-3 rounded-xl border border-slate-200 p-4">
            <FileText className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" />
            <div className="min-w-0 flex-1 text-base">
              <p className="truncate font-medium text-slate-900">{file.name}</p>
              <p className="text-slate-700"><CheckCircle2 className="mr-1 inline h-4 w-4 text-emerald-600" />
                {n(file.rows.length)} cases · NABH total {rupees(nabh)}</p>
            </div>
            <button aria-label="Remove file" onClick={() => setFile(null)} className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"><X className="h-5 w-5" /></button>
          </div>
        )}

        {warn.length > 0 && (
          <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-base text-amber-900">
            <p className="flex items-center gap-2 font-semibold"><AlertTriangle className="h-5 w-5" /> Check these rows in the sheet</p>
            <ul className="mt-1 space-y-0.5 text-sm">{warn.map((w, i) => <li key={i}>IP {w.ip}: {w.note}</li>)}</ul>
            <p className="mt-1 text-sm">You can still save. Correct the sheet and upload again later.</p>
          </div>
        )}

        <button onClick={save} disabled={!file || !!saving || reading}
          className="mt-4 flex min-h-14 w-full items-center justify-center gap-2 rounded-xl bg-teal-600 text-lg font-bold text-white hover:bg-teal-700 disabled:opacity-40">
          {saving ? <Loader2 className="h-5 w-5 animate-spin" /> : <CheckCircle2 className="h-5 w-5" />} {saving || 'Save'}
        </button>
        {error && <p role="alert" className="mt-3 rounded-lg bg-rose-50 p-3 text-base text-rose-800">{error}</p>}
      </section>

      {result && (
        <section className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-base text-emerald-900">
          <p className="text-lg font-semibold">Saved</p>
          <ul className="mt-2 space-y-1">
            <li><b>{n(result.created)}</b> new PMJAY cases</li>
            <li><b>{n(result.updated)}</b> cases updated (dates, amounts)</li>
            <li><b>{n(result.moved)}</b> status steps moved forward</li>
            <li><b>{n(result.paid)}</b> payments recorded</li>
            {result.skipped > 0 && <li className="text-emerald-800">{n(result.skipped)} rows without IP no. or name left out</li>}
          </ul>
          {result.problems.length > 0 && (
            <ul className="mt-3 space-y-0.5 rounded-lg bg-white p-3 text-sm text-amber-900">
              {result.problems.map((p, i) => <li key={i}>IP {p.ip}: {p.problem}</li>)}
            </ul>
          )}
          <Link href="/master" className="mt-3 inline-flex min-h-11 items-center rounded-lg bg-white px-4 font-semibold text-teal-700 hover:bg-teal-50">Open Master</Link>
        </section>
      )}
    </div>
  );
}
