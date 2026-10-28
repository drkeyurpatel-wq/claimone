'use client';
// Upload the daily eCW export. Every credit admission becomes a case on the
// admission or claims desk; cash patients are left out; a sponsor name the
// system has not seen before is asked once, then the file is saved again.
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Upload, Loader2, CheckCircle2, FileText, X, UserPlus, HelpCircle } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import type { Cell } from '@/lib/recon/payments';
import type { Payer } from '@/lib/claims/types';
import { isEcwSheet, parseEcw, summariseEcw, type CaseRow } from '@/lib/rcm/ecw';
import { fetchAllPayers, importCases, mapSponsor, type ImportResult } from '@/lib/rcm/api';
import { NoCentre } from '@/components/ui';

const n = (x: number) => x.toLocaleString('en-IN');

async function readEcw(f: File): Promise<CaseRow[]> {
  if (/\.xls$/i.test(f.name)) throw new Error('This is an old Excel file (.xls). Open it in Excel, choose Save As → .xlsx, and add it again.');
  if (!/\.(xlsx|xlsm)$/i.test(f.name)) throw new Error('Add the Excel file exported from eCW (.xlsx).');
  const { default: readXlsxFile, readSheetNames } = await import('read-excel-file');
  const names = await readSheetNames(f);
  for (const sheet of names) {
    const cells = (await readXlsxFile(f, { sheet })) as Cell[][];
    if (isEcwSheet(cells)) {
      const { rows } = parseEcw(cells);
      if (rows.length) return rows;
    }
  }
  throw new Error('This does not look like the eCW admissions export — it needs the columns IP No., Patient Name and Sponsor Name.');
}

export default function UploadCases() {
  const centreId = useAuthStore((s) => s.activeCentreId);
  const role = useAuthStore((s) => s.staff?.role);
  const canWrite = role === 'admin' || role === 'manager' || role === 'desk';
  const [file, setFile] = useState<{ name: string; rows: CaseRow[] } | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [payers, setPayers] = useState<Payer[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({}); // sponsor → payer id | 'cash'

  useEffect(() => { fetchAllPayers().then(setPayers); }, []);

  const add = async (f: File | undefined) => {
    if (!f) return;
    setError(''); setResult(null); setReading(true);
    try { setFile({ name: f.name, rows: await readEcw(f) }); } catch (e) { setError((e as Error).message); setFile(null); }
    setReading(false);
  };

  const save = async () => {
    if (!centreId || !file) return;
    setError('');
    try {
      setSaving('Saving…');
      const r = await importCases(centreId, file.name, file.rows, (k) => setSaving(`Saving ${n(k)} of ${n(file.rows.length)}`));
      setResult(r);
      setAnswers({});
    } catch (e) { setError((e as Error).message); }
    setSaving('');
  };

  // teach the new sponsor names, then save the same file again
  const answerAndSave = async () => {
    if (!result) return;
    setError('');
    try {
      setSaving('Saving the answers…');
      for (const s of result.unknown_sponsors) {
        const a = answers[s];
        if (!a) continue;
        await mapSponsor(s, a === 'cash' ? null : a, a !== 'cash');
      }
    } catch (e) { setError((e as Error).message); setSaving(''); return; }
    await save();
  };

  if (!centreId) return <NoCentre />;
  if (!canWrite) return <div className="p-10 text-center text-base text-slate-600">Your login can only view.</div>;

  const s = file ? summariseEcw(file.rows) : null;
  const unknown = result?.unknown_sponsors ?? [];

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 md:px-6">
      <h1 className="text-2xl font-bold text-slate-900">Upload today’s admissions</h1>
      <p className="mt-1 text-base text-slate-600">Export the IPD / day-care list from eCW, add the file here and press <b>Save</b>. Do this every morning.</p>

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5">
        <label
          onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); add(e.dataTransfer.files[0]); }}
          className="flex min-h-40 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-300 p-8 text-center transition hover:border-teal-400 hover:bg-slate-50">
          {reading ? <Loader2 className="h-10 w-10 animate-spin text-teal-600" /> : <Upload className="h-10 w-10 text-teal-600" />}
          <span className="text-lg font-semibold text-slate-800">{reading ? 'Reading…' : 'Tap here to choose the eCW file'}</span>
          <span className="text-sm text-slate-500">Excel (.xlsx)</span>
          <input type="file" accept=".xlsx,.xlsm,.xls" className="hidden" onChange={(e) => { add(e.target.files?.[0]); e.target.value = ''; }} />
        </label>

        {file && s && (
          <div className="mt-4 flex items-start gap-3 rounded-xl border border-slate-200 p-4">
            <FileText className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" />
            <div className="min-w-0 flex-1 text-base">
              <p className="truncate font-medium text-slate-900">{file.name}</p>
              <p className="text-slate-700"><CheckCircle2 className="mr-1 inline h-4 w-4 text-emerald-600" />
                {n(s.admissions)} patients · {n(s.inHouse)} in hospital · {n(s.discharged)} discharged</p>
              <p className="mt-1 text-sm text-slate-500">{s.bySponsor.slice(0, 6).map((x) => `${x.sponsor} ${n(x.count)}`).join(' · ')}{s.bySponsor.length > 6 ? ' …' : ''}</p>
            </div>
            <button aria-label="Remove file" onClick={() => setFile(null)} className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"><X className="h-5 w-5" /></button>
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
            <li><b>{n(result.created)}</b> new insurance / scheme patients</li>
            <li><b>{n(result.updated)}</b> patients updated (discharge, bill)</li>
            <li><b>{n(result.bills)}</b> bills added to money owed</li>
            <li className="text-emerald-800">{n(result.cash)} cash patients left out</li>
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href="/desk/admission" className="inline-flex min-h-11 items-center rounded-lg bg-white px-4 font-semibold text-teal-700 hover:bg-teal-50">Open admission desk</Link>
            <Link href="/desk/claims" className="inline-flex min-h-11 items-center rounded-lg bg-white px-4 font-semibold text-teal-700 hover:bg-teal-50">Open claims desk</Link>
          </div>
        </section>
      )}

      {unknown.length > 0 && (
        <section className="mt-4 rounded-2xl border border-amber-300 bg-amber-50 p-5">
          <p className="flex items-center gap-2 text-lg font-semibold text-amber-900"><HelpCircle className="h-5 w-5" /> New sponsor names — who pays?</p>
          <p className="mt-1 text-base text-amber-900">Patients with these sponsors were not saved. Choose once; next time they come in on their own.</p>
          <ul className="mt-3 space-y-3">
            {unknown.map((sp) => (
              <li key={sp} className="rounded-xl bg-white p-3">
                <p className="text-base font-semibold text-slate-900">{sp}</p>
                <select value={answers[sp] ?? ''} onChange={(e) => setAnswers((a) => ({ ...a, [sp]: e.target.value }))} aria-label={`Who pays for ${sp}`}
                  className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 px-3 text-base">
                  <option value="">Choose…</option>
                  <option value="cash">Cash / patient pays — leave out</option>
                  {payers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </li>
            ))}
          </ul>
          <button onClick={answerAndSave} disabled={!!saving || !unknown.some((u) => answers[u]) || !file}
            className="mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-amber-600 text-base font-bold text-white hover:bg-amber-700 disabled:opacity-40">
            Save answers and save the file again
          </button>
        </section>
      )}

      <Link href="/cases/new" className="mt-6 inline-flex min-h-12 items-center gap-2 rounded-xl px-3 text-base font-medium text-teal-700 hover:bg-teal-50">
        <UserPlus className="h-5 w-5" /> Patient not in the eCW file? Add by hand
      </Link>
    </div>
  );
}
