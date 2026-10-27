'use client';
// This week's payments. Drop the PMJAY sheet and the TPA / insurer letters
// (Excel, PDF, photo, or email text). The app reads them, matches every
// payment to its bill, and shows only what does not add up.
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { CalendarCheck, Upload, Loader2, CheckCircle2, AlertTriangle, FileText, X, ClipboardPaste } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import { parseCsv } from '@/lib/recon/parse';
import { cellsToRows, parsePaymentSheet, summarise, type Cell, type PaymentLine } from '@/lib/recon/payments';
import { applyPayments, readLetter, fetchExceptions, addAdjustment, setDisputed, acceptPaidAmount,
  type ApplyResult, type ExceptionRow, type Problem } from '@/lib/recon/api';
import { DISALLOWANCE_CATEGORIES } from '@/lib/engine/settlement';
import { PageHeader, NoCentre, Skeleton, inr, inrShort, shortDate, useToast, btn } from '@/components/ui';

type Item = { id: number; name: string; kind: 'PMJAY sheet' | 'Excel' | 'Letter'; state: 'reading' | 'ready' | 'error'; lines: PaymentLine[]; error?: string };

const PROBLEM: Record<Problem, { title: string; help: string; tone: string }> = {
  short: { title: 'Paid less than billed', help: 'Find the reason on the letter or portal. Pick it and save — or mark it disputed to take it up with the payer.', tone: 'border-amber-300 bg-amber-50' },
  overdue: { title: 'Not paid yet — overdue', help: 'No payment for more than 30 days (45 for PMJAY). Chase the TPA / check the TMS portal.', tone: 'border-rose-300 bg-rose-50' },
  over: { title: 'Paid more than billed', help: 'The amount on file was lower than what came in. If the payment is right, accept it.', tone: 'border-sky-300 bg-sky-50' },
};

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

let seq = 0;

export default function WeeklyUpload() {
  const centreId = useAuthStore((s) => s.activeCentreId);
  const role = useAuthStore((s) => s.staff?.role);
  const canWrite = role === 'admin' || role === 'manager' || role === 'desk';
  const { flash, toastNode } = useToast();
  const [items, setItems] = useState<Item[]>([]);
  const [text, setText] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const [drag, setDrag] = useState(false);
  const [saving, setSaving] = useState<string>('');
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [problems, setProblems] = useState<ExceptionRow[] | null>(null);

  const loadProblems = useCallback(async () => { if (centreId) setProblems(await fetchExceptions(centreId)); }, [centreId]);
  useEffect(() => { loadProblems(); }, [loadProblems]);

  const update = (id: number, patch: Partial<Item>) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const addFiles = async (files: FileList | File[]) => {
    setResult(null);
    for (const f of Array.from(files)) {
      const id = ++seq;
      const isSheet = /\.(xlsx|xls|csv)$/i.test(f.name);
      setItems((xs) => [...xs, { id, name: f.name, kind: isSheet ? 'Excel' : 'Letter', state: 'reading', lines: [] }]);
      try {
        if (isSheet) {
          let rows: string[][];
          if (/\.csv$/i.test(f.name)) rows = parseCsv(await f.text());
          else {
            if (/\.xls$/i.test(f.name)) throw new Error('Old .xls format — open it and Save As .xlsx, then upload again.');
            const { default: readXlsxFile } = await import('read-excel-file');
            rows = cellsToRows((await readXlsxFile(f)) as Cell[][]);
          }
          const r = parsePaymentSheet(rows);
          const pm = r.rows[0]?.source === 'pmjay';
          if (!r.rows.length) throw new Error('No payments found in this sheet.');
          update(id, { state: 'ready', lines: r.rows, kind: pm ? 'PMJAY sheet' : 'Excel' });
        } else if (/\.pdf$/i.test(f.name) || f.type.startsWith('image/')) {
          const blob = f.type.startsWith('image/') ? await shrinkImage(f) : f;
          const lines = await readLetter({ file: blob, fileName: f.name });
          if (!lines.length) throw new Error('No payment with a claim no. or bill no. was found on this letter.');
          update(id, { state: 'ready', lines });
        } else throw new Error('Upload Excel, PDF or a photo.');
      } catch (e) { update(id, { state: 'error', error: (e as Error).message }); }
    }
  };

  const addText = async () => {
    if (!text.trim()) return;
    const id = ++seq;
    setItems((xs) => [...xs, { id, name: 'Pasted email text', kind: 'Letter', state: 'reading', lines: [] }]);
    setText(''); setShowPaste(false);
    try {
      const lines = await readLetter({ text });
      if (!lines.length) throw new Error('No payment with a claim no. or bill no. was found in the text.');
      update(id, { state: 'ready', lines });
    } catch (e) { update(id, { state: 'error', error: (e as Error).message }); }
  };

  const ready = items.filter((x) => x.state === 'ready');
  const busy = items.some((x) => x.state === 'reading');

  const matchAll = async () => {
    if (!centreId || !ready.length) return;
    const total: ApplyResult = { matched: 0, created: 0, unpaid: 0, duplicate: 0, skipped: 0 };
    try {
      for (const it of ready) {
        setSaving(`${it.name}…`);
        const r = await applyPayments(centreId, it.name, it.lines, (n) => setSaving(`${it.name}: ${n.toLocaleString('en-IN')} of ${it.lines.length.toLocaleString('en-IN')}`));
        for (const k of Object.keys(total) as (keyof ApplyResult)[]) total[k] += r[k];
      }
      setResult(total);
      setItems([]);
      await loadProblems();
    } catch (e) { flash((e as Error).message, 'err'); }
    setSaving('');
  };

  if (!centreId) return <NoCentre />;

  return (
    <div>
      {toastNode}
      <PageHeader title="Weekly payments" sub="Upload what came in this week — the app matches it to bills" icon={CalendarCheck}>
        <Link href="/receivables" className={btn.ghost}>All bills</Link>
      </PageHeader>

      <div className="mx-auto max-w-5xl space-y-5 px-4 py-6 md:px-6">
        {canWrite && (
          <section className="rounded-2xl border border-slate-200 bg-white p-5">
            <p className="text-base font-semibold text-slate-900">1. Add this week&apos;s files</p>
            <p className="mt-1 text-sm text-slate-600">PMJAY settlement sheet, TPA / insurer letters — Excel, PDF, or a photo from WhatsApp. Add as many as you have.</p>

            <label
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
              onDrop={(e) => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); }}
              className={`mt-4 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-8 text-center transition ${drag ? 'border-teal-500 bg-teal-50' : 'border-slate-300 hover:border-teal-400 hover:bg-slate-50'}`}>
              <Upload className="h-8 w-8 text-teal-600" />
              <span className="text-sm font-semibold text-slate-800">Drop files here, or tap to choose</span>
              <span className="text-xs text-slate-500">.xlsx · .csv · .pdf · .jpg · .png</span>
              <input type="file" multiple accept=".xlsx,.xls,.csv,.pdf,image/*" className="hidden"
                onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
            </label>

            <button onClick={() => setShowPaste((v) => !v)} className={`${btn.ghost} mt-3`}><ClipboardPaste className="h-3.5 w-3.5" /> Letter is in the email body? Paste it</button>
            {showPaste && (
              <div className="mt-2 space-y-2">
                <textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} placeholder="Copy the whole email from the TPA and paste it here"
                  className={`${btn.input} w-full`} />
                <button onClick={addText} disabled={!text.trim()} className={btn.primary}>Read this text</button>
              </div>
            )}

            {items.length > 0 && (
              <ul className="mt-4 divide-y divide-slate-100 rounded-xl border border-slate-200">
                {items.map((it) => {
                  const s = summarise(it.lines);
                  return (
                    <li key={it.id} className="flex items-start gap-3 p-3 text-sm">
                      <FileText className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-slate-900">{it.name} <span className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-normal text-slate-600">{it.kind}</span></p>
                        {it.state === 'reading' && <p className="flex items-center gap-1.5 text-slate-500"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading…</p>}
                        {it.state === 'error' && <p className="text-rose-600">{it.error}</p>}
                        {it.state === 'ready' && (
                          <p className="text-slate-600">
                            <b>{s.paid.toLocaleString('en-IN')}</b> payment{s.paid === 1 ? '' : 's'} · <b>{inrShort(s.paidAmount)}</b> received
                            {s.tds > 0 && <> · TDS {inrShort(s.tds)}</>}
                            {s.unpaid > 0 && <> · <span className="text-amber-700">{s.unpaid} not paid yet</span></>}
                          </p>
                        )}
                      </div>
                      <button aria-label="Remove" onClick={() => setItems((xs) => xs.filter((x) => x.id !== it.id))} className="rounded p-1 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button onClick={matchAll} disabled={!ready.length || busy || !!saving} className={`${btn.primary} px-5 py-2.5 text-base`}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                2. Match to bills
              </button>
              {saving && <span className="text-sm text-slate-500">{saving}</span>}
            </div>

            {result && (
              <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
                <p className="flex items-center gap-2 font-semibold"><CheckCircle2 className="h-4 w-4" /> Done. {result.matched.toLocaleString('en-IN')} payments matched to bills.</p>
                <p className="mt-1 text-emerald-800">
                  {result.created > 0 && <>{result.created.toLocaleString('en-IN')} new bills were added (not on file before). </>}
                  {result.duplicate > 0 && <>{result.duplicate.toLocaleString('en-IN')} were already uploaded before (skipped). </>}
                  {result.unpaid > 0 && <>{result.unpaid.toLocaleString('en-IN')} lines show no payment yet. </>}
                  Anything that does not add up is listed below.
                </p>
              </div>
            )}
          </section>
        )}

        <Problems rows={problems} canWrite={canWrite} onChanged={loadProblems} flash={flash} />
      </div>
    </div>
  );
}

function Problems({ rows, canWrite, onChanged, flash }: { rows: ExceptionRow[] | null; canWrite: boolean; onChanged: () => void; flash: (t: string, tone?: 'ok' | 'err') => void }) {
  const [tab, setTab] = useState<Problem>('short');
  const [open, setOpen] = useState<string | null>(null);
  const groups = useMemo(() => {
    const g: Record<Problem, ExceptionRow[]> = { short: [], overdue: [], over: [] };
    for (const r of rows ?? []) g[r.problem]?.push(r);
    return g;
  }, [rows]);

  if (!rows) return <Skeleton rows={4} />;
  if (!rows.length) return (
    <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-center">
      <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-600" />
      <p className="mt-2 text-base font-semibold text-emerald-900">Nothing to check. Every payment matches its bill.</p>
    </section>
  );
  const list = groups[tab];
  const sum = (xs: ExceptionRow[]) => xs.reduce((a, r) => a + Math.abs(r.balance), 0);

  return (
    <section className="rounded-2xl border border-slate-200 bg-white">
      <div className="border-b border-slate-100 p-5">
        <p className="flex items-center gap-2 text-base font-semibold text-slate-900"><AlertTriangle className="h-4 w-4 text-amber-500" /> 3. Check these — only the bills that don&apos;t add up</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {(Object.keys(PROBLEM) as Problem[]).map((p) => (
            <button key={p} onClick={() => setTab(p)}
              className={`rounded-xl border px-3 py-2 text-left text-sm transition ${tab === p ? `${PROBLEM[p].tone} ring-2 ring-offset-1 ring-slate-200` : 'border-slate-200 bg-white hover:bg-slate-50'}`}>
              <span className="font-semibold">{PROBLEM[p].title}</span>
              <span className="ml-2 tabular text-slate-600">{groups[p].length} · {inrShort(sum(groups[p]))}</span>
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-500">{PROBLEM[tab].help}</p>
      </div>
      {list.length === 0 ? <p className="p-6 text-center text-sm text-slate-500">None.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Patient</th>
                <th className="px-3 py-2 text-left font-semibold">Bill / claim</th>
                <th className="px-3 py-2 text-left font-semibold">Payer</th>
                <th className="px-3 py-2 text-right font-semibold">Billed</th>
                <th className="px-3 py-2 text-right font-semibold">Received</th>
                <th className="px-3 py-2 text-right font-semibold">{tab === 'over' ? 'Extra' : tab === 'short' ? 'Short by' : 'Due'}</th>
                <th className="px-3 py-2 text-right font-semibold">Days</th>
                {canWrite && <th className="px-3 py-2" />}
              </tr>
            </thead>
            <tbody>
              {list.slice(0, 500).map((r) => (
                <Row key={r.receivable_id} r={r} canWrite={canWrite} open={open === r.receivable_id}
                  onToggle={() => setOpen(open === r.receivable_id ? null : r.receivable_id)}
                  onDone={(msg) => { flash(msg); setOpen(null); onChanged(); }} onError={(m) => flash(m, 'err')} />
              ))}
            </tbody>
          </table>
          {list.length > 500 && <p className="p-3 text-xs text-slate-500">Showing the oldest 500 of {list.length}.</p>}
        </div>
      )}
    </section>
  );
}

function Row({ r, canWrite, open, onToggle, onDone, onError }: {
  r: ExceptionRow; canWrite: boolean; open: boolean; onToggle: () => void; onDone: (m: string) => void; onError: (m: string) => void;
}) {
  const [cat, setCat] = useState('');
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const received = r.allocated + r.tds + r.deduction;
  const run = async (f: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try { await f(); onDone(msg); } catch (e) { onError((e as Error).message); }
    setBusy(false);
  };
  return (
    <>
      <tr className="border-t border-slate-100 align-top">
        <td className="px-3 py-2"><Link href={`/receivables/${r.receivable_id}`} className="font-medium text-slate-900 hover:underline">{r.patient_name ?? '—'}</Link>
          {r.uhid && <div className="text-[11px] text-slate-500">UHID {r.uhid}</div>}</td>
        <td className="px-3 py-2 text-xs"><div>{r.bill_no ?? '—'}</div><div className="text-slate-500">{r.claim_ref ?? ''}</div><div className="text-slate-400">{shortDate(r.bill_date)}</div></td>
        <td className="px-3 py-2 text-xs">{r.debtor_name}</td>
        <td className="tabular px-3 py-2 text-right">{inr(r.expected_amount)}</td>
        <td className="tabular px-3 py-2 text-right">{received > 0 ? inr(received) : '—'}</td>
        <td className="tabular px-3 py-2 text-right font-semibold">{inr(Math.abs(r.balance))}</td>
        <td className="tabular px-3 py-2 text-right text-slate-500">{r.age_days}</td>
        {canWrite && <td className="px-3 py-2 text-right"><button onClick={onToggle} className={btn.ghost}>{open ? 'Close' : 'Fix'}</button></td>}
      </tr>
      {open && (
        <tr className="bg-slate-50">
          <td colSpan={8} className="px-3 py-3">
            {r.problem === 'short' && (
              <div className="flex flex-wrap items-end gap-2">
                <select value={cat} onChange={(e) => setCat(e.target.value)} className={btn.input} aria-label="Reason">
                  <option value="">Reason for the short payment…</option>
                  {Object.entries(DISALLOWANCE_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </select>
                <input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="What the letter / portal says" className={`${btn.input} min-w-[240px] flex-1`} />
                <button disabled={busy || !cat || !why.trim()} className={btn.primary}
                  onClick={() => run(() => addAdjustment(r.receivable_id, { kind: 'deduction', amount: Math.round(r.balance * 100) / 100, category: cat, reason_text: why.trim() }), 'Reason saved — bill closed.')}>
                  Save reason ({inr(r.balance)})
                </button>
                <button disabled={busy} className={btn.ghost} onClick={() => run(() => setDisputed(r.receivable_id, why.trim() || 'Short payment disputed with payer'), 'Marked disputed.')}>Dispute with payer</button>
              </div>
            )}
            {r.problem === 'overdue' && (
              <div className="flex flex-wrap items-end gap-2">
                <input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Note (e.g. query raised on portal, resubmitted on …)" className={`${btn.input} min-w-[280px] flex-1`} />
                <button disabled={busy || !why.trim()} className={btn.ghost} onClick={() => run(() => setDisputed(r.receivable_id, why.trim()), 'Moved to disputed / follow-up.')}>Move to follow-up</button>
                <Link href={`/receivables/${r.receivable_id}`} className={btn.ghost}>Open bill</Link>
              </div>
            )}
            {r.problem === 'over' && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-slate-600">Payer sent {inr(-r.balance)} more than the {inr(r.expected_amount)} on file.</span>
                <button disabled={busy} className={btn.primary} onClick={() => run(() => acceptPaidAmount(r.receivable_id, r.expected_amount - r.balance), 'Bill amount updated to what was paid.')}>Payment is right — update bill</button>
                <Link href={`/receivables/${r.receivable_id}`} className={btn.ghost}>Open bill</Link>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
