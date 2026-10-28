'use client';
// Upload payments — staff screen 1 of 2.
// Add this week's files (PMJAY sheet, TPA letters as Excel / PDF / photo, or the
// email text), press Save. Every payment is matched to its bill; what does not
// add up goes to the Check list.
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Upload, Loader2, CheckCircle2, FileText, X, ClipboardPaste, ArrowRight } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import { parseCsv } from '@/lib/recon/parse';
import { cellsToRows, parsePaymentSheet, summarise, type Cell, type PaymentLine } from '@/lib/recon/payments';
import { applyPayments, readLetter, fetchExceptions, type ApplyResult } from '@/lib/recon/api';
import { NoCentre, inrShort } from '@/components/ui';

type Item = { id: number; name: string; state: 'reading' | 'ready' | 'error'; lines: PaymentLine[]; error?: string };

/** Phone photos are big: shrink to ~2000px JPEG before upload. */
async function shrinkImage(file: File): Promise<Blob> {
  if (file.size < 1_500_000) return file;
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  return await new Promise<Blob>((res) => c.toBlob((b) => res(b ?? file), 'image/jpeg', 0.85));
}

const n = (x: number) => x.toLocaleString('en-IN');
let seq = 0;

export default function UploadPayments() {
  const centreId = useAuthStore((s) => s.activeCentreId);
  const role = useAuthStore((s) => s.staff?.role);
  const canWrite = role === 'admin' || role === 'manager' || role === 'desk';
  const [items, setItems] = useState<Item[]>([]);
  const [text, setText] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const [drag, setDrag] = useState(false);
  const [saving, setSaving] = useState('');
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [failMsg, setFailMsg] = useState('');
  const [toCheck, setToCheck] = useState<number | null>(null);

  const countChecks = useCallback(async () => { if (centreId) setToCheck((await fetchExceptions(centreId)).length); }, [centreId]);
  useEffect(() => { countChecks(); }, [countChecks]);

  const update = (id: number, patch: Partial<Item>) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const addFiles = async (files: FileList | File[]) => {
    setResult(null); setFailMsg('');
    for (const f of Array.from(files)) {
      const id = ++seq;
      setItems((xs) => [...xs, { id, name: f.name, state: 'reading', lines: [] }]);
      try {
        if (/\.(xlsx|xls|csv)$/i.test(f.name)) {
          let rows: string[][];
          if (/\.csv$/i.test(f.name)) rows = parseCsv(await f.text());
          else {
            if (/\.xls$/i.test(f.name)) throw new Error('This is an old Excel file (.xls). Open it in Excel, choose Save As → .xlsx, and add it again.');
            const { default: readXlsxFile } = await import('read-excel-file');
            rows = cellsToRows((await readXlsxFile(f)) as Cell[][]);
          }
          const r = parsePaymentSheet(rows);
          if (!r.rows.length) throw new Error('No payments found in this file.');
          update(id, { state: 'ready', lines: r.rows });
        } else if (/\.pdf$/i.test(f.name) || f.type.startsWith('image/')) {
          const blob = f.type.startsWith('image/') ? await shrinkImage(f) : f;
          const lines = await readLetter({ file: blob, fileName: f.name });
          if (!lines.length) throw new Error('No claim no. or bill no. found on this letter.');
          update(id, { state: 'ready', lines });
        } else throw new Error('Add an Excel file, a PDF, or a photo.');
      } catch (e) { update(id, { state: 'error', error: (e as Error).message }); }
    }
  };

  const addText = async () => {
    if (!text.trim()) return;
    const id = ++seq;
    setItems((xs) => [...xs, { id, name: 'Email text', state: 'reading', lines: [] }]);
    const t = text; setText(''); setShowPaste(false);
    try {
      const lines = await readLetter({ text: t });
      if (!lines.length) throw new Error('No claim no. or bill no. found in this text.');
      update(id, { state: 'ready', lines });
    } catch (e) { update(id, { state: 'error', error: (e as Error).message }); }
  };

  const ready = items.filter((x) => x.state === 'ready');
  const busy = items.some((x) => x.state === 'reading');

  const save = async () => {
    if (!centreId || !ready.length) return;
    setFailMsg('');
    const total: ApplyResult = { matched: 0, created: 0, unpaid: 0, duplicate: 0, skipped: 0, invalid: 0 };
    try {
      for (const it of ready) {
        setSaving(`Saving ${it.name}…`);
        const r = await applyPayments(centreId, it.name, it.lines, (k) => setSaving(`Saving ${it.name}: ${n(k)} of ${n(it.lines.length)}`));
        for (const k of Object.keys(total) as (keyof ApplyResult)[]) total[k] += r[k];
      }
      setResult(total);
      setItems([]);
    } catch (e) { setFailMsg((e as Error).message); }
    await countChecks();
    setSaving('');
  };

  if (!centreId) return <NoCentre />;
  if (!canWrite) return <div className="p-10 text-center text-base text-slate-600">Your login can only view. Ask your manager to upload payments.</div>;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 md:px-6">
      <h1 className="text-2xl font-bold text-slate-900">Upload payments</h1>
      <p className="mt-1 text-base text-slate-600">Add the files that came this week, then press <b>Save</b>.</p>

      {/* Step 1 */}
      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5">
        <p className="flex items-center gap-3 text-lg font-semibold text-slate-900">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-teal-600 text-base text-white">1</span> Add files
        </p>
        <p className="mt-2 text-base text-slate-600">PMJAY sheet · TPA letters · insurer letters. Excel, PDF or a WhatsApp photo are all fine.</p>

        <label
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); }}
          className={`mt-4 flex min-h-40 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-8 text-center transition ${drag ? 'border-teal-500 bg-teal-50' : 'border-slate-300 hover:border-teal-400 hover:bg-slate-50'}`}>
          <Upload className="h-10 w-10 text-teal-600" />
          <span className="text-lg font-semibold text-slate-800">Tap here to choose files</span>
          <span className="text-sm text-slate-500">or drag them here</span>
          <input type="file" multiple accept=".xlsx,.xls,.csv,.pdf,image/*" className="hidden"
            onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
        </label>

        <button onClick={() => setShowPaste((v) => !v)}
          className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-lg px-3 text-base font-medium text-teal-700 hover:bg-teal-50">
          <ClipboardPaste className="h-5 w-5" /> The letter is inside an email? Paste it
        </button>
        {showPaste && (
          <div className="mt-2 space-y-2">
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} aria-label="Email text"
              placeholder="Copy the whole email and paste it here"
              className="w-full rounded-lg border border-slate-300 p-3 text-base focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100" />
            <button onClick={addText} disabled={!text.trim()}
              className="min-h-11 rounded-lg bg-teal-600 px-5 text-base font-semibold text-white hover:bg-teal-700 disabled:opacity-50">Add this email</button>
          </div>
        )}

        {items.length > 0 && (
          <ul className="mt-4 divide-y divide-slate-100 rounded-xl border border-slate-200">
            {items.map((it) => {
              const s = summarise(it.lines);
              return (
                <li key={it.id} className="flex items-start gap-3 p-4">
                  <FileText className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" />
                  <div className="min-w-0 flex-1 text-base">
                    <p className="truncate font-medium text-slate-900">{it.name}</p>
                    {it.state === 'reading' && <p className="flex items-center gap-2 text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Reading…</p>}
                    {it.state === 'error' && <p className="text-rose-700">{it.error}</p>}
                    {it.state === 'ready' && (
                      <p className="text-slate-700"><CheckCircle2 className="mr-1 inline h-4 w-4 text-emerald-600" />
                        {n(s.paid)} payment{s.paid === 1 ? '' : 's'} · <b>{inrShort(s.paidAmount)}</b>
                        {s.unpaid > 0 && <span className="text-slate-500"> · {n(s.unpaid)} not paid yet</span>}
                      </p>
                    )}
                  </div>
                  <button aria-label={`Remove ${it.name}`} onClick={() => setItems((xs) => xs.filter((x) => x.id !== it.id))}
                    className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"><X className="h-5 w-5" /></button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Step 2 */}
      <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-5">
        <p className="flex items-center gap-3 text-lg font-semibold text-slate-900">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-teal-600 text-base text-white">2</span> Save
        </p>
        <button onClick={save} disabled={!ready.length || busy || !!saving}
          className="mt-4 flex min-h-14 w-full items-center justify-center gap-2 rounded-xl bg-teal-600 text-lg font-bold text-white hover:bg-teal-700 disabled:opacity-40">
          {saving ? <Loader2 className="h-5 w-5 animate-spin" /> : <CheckCircle2 className="h-5 w-5" />}
          {saving ? 'Saving…' : ready.length ? `Save ${n(ready.reduce((a, x) => a + summarise(x.lines).paid, 0))} payments` : 'Save'}
        </button>
        {saving && <p className="mt-2 text-center text-base text-slate-600">{saving}</p>}
        {!ready.length && !saving && !result && <p className="mt-2 text-center text-sm text-slate-500">Add files first.</p>}

        {failMsg && <p role="alert" className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-base text-rose-800">{failMsg}</p>}
        {result && (
          <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-base text-emerald-900">
            <p className="flex items-center gap-2 text-lg font-semibold"><CheckCircle2 className="h-5 w-5" /> Saved. {n(result.matched)} payments added to bills.</p>
            {result.duplicate > 0 && <p className="mt-1">{n(result.duplicate)} were already saved before — nothing was counted twice.</p>}
            {result.invalid + result.skipped > 0 && <p className="mt-1">{n(result.invalid + result.skipped)} lines had no bill or claim number and were left out.</p>}
          </div>
        )}
      </section>

      {/* Next */}
      <Link href="/pay/check"
        className="mt-4 flex min-h-14 items-center justify-between rounded-2xl border border-amber-300 bg-amber-50 px-5 text-lg font-semibold text-amber-900 hover:bg-amber-100">
        <span>Check list{toCheck != null && ` — ${n(toCheck)} bills need a look`}</span>
        <ArrowRight className="h-5 w-5" />
      </Link>
    </div>
  );
}
