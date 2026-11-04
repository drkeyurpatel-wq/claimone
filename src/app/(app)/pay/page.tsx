'use client';
// Payments → Upload. One box for every money file: TPA / insurer letters (Excel, PDF, photo, email text),
// the PMJAY payment sheet, the PMJAY case sheet and the bank statement. ClaimOne tells which is which,
// saves it, and ties bank money to bills where the evidence is strong. The rest waits on "To check".
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Upload, Loader2, CheckCircle2, FileText, X, ClipboardPaste, ArrowRight, Bot, Plus, Landmark } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import { parseCsv, parseBankStatement, type BankLine } from '@/lib/recon/parse';
import { cellsToRows, parsePaymentSheet, summarise, type Cell, type PaymentLine } from '@/lib/recon/payments';
import { applyPayments, importRows, readLetter, fetchInbox, markInboxUsed, type ApplyResult, type InboxItem } from '@/lib/recon/api';
import { detectKind, type FileKind } from '@/lib/recon/detect';
import { autoMatch } from '@/lib/recon/auto';
import { countToCheck } from '@/lib/recon/tocheck';
import { parsePmjay, type PmjayRow } from '@/lib/rcm/pmjay';
import { importPmjay, type PmjayResult } from '@/lib/rcm/api';
import { NoCentre, inrShort, shortDate } from '@/components/ui';

type Item = {
  id: number; name: string; state: 'reading' | 'ready' | 'error'; kind: FileKind; error?: string; inboxId?: string;
  lines: PaymentLine[]; bank: BankLine[]; cases: PmjayRow[];
};
type Result = { pay: ApplyResult | null; cases: PmjayResult | null; bank: { inserted: number; duplicates: number } | null; auto: { matched: number; left: number } };

const KIND_LABEL: Record<FileKind, string> = { payments: 'Settlement', bank: 'Bank statement', pmjay_cases: 'PMJAY case sheet' };
const ACCOUNT_KEY = 'claimone.bankAccount';

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
const blank = { lines: [] as PaymentLine[], bank: [] as BankLine[], cases: [] as PmjayRow[] };
let seq = 0;

/** What one ready file holds, in a few words. */
function describe(it: Item) {
  if (it.kind === 'bank') return <>{n(it.bank.length)} credits · <b>{inrShort(it.bank.reduce((a, x) => a + x.amount, 0))}</b></>;
  if (it.kind === 'pmjay_cases') return <>{n(it.cases.length)} PMJAY cases · NABH <b>{inrShort(it.cases.reduce((a, x) => a + (x.nabh_amount ?? 0), 0))}</b></>;
  const s = summarise(it.lines);
  return <>{n(s.paid)} payment{s.paid === 1 ? '' : 's'} · <b>{inrShort(s.paidAmount)}</b>{s.unpaid > 0 && <span className="text-slate-500"> · {n(s.unpaid)} not paid yet</span>}</>;
}

export default function UploadPayments() {
  const centreId = useAuthStore((s) => s.activeCentreId);
  const role = useAuthStore((s) => s.staff?.role);
  const canWrite = role === 'admin' || role === 'manager' || role === 'desk';
  const [items, setItems] = useState<Item[]>([]);
  const [text, setText] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const [drag, setDrag] = useState(false);
  const [saving, setSaving] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [failMsg, setFailMsg] = useState('');
  const [toCheck, setToCheck] = useState<number | null>(null);
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  const [account, setAccount] = useState('');

  useEffect(() => { try { setAccount(localStorage.getItem(ACCOUNT_KEY) ?? ''); } catch { /* private window */ } }, []);
  const loadInbox = useCallback(async () => { if (centreId) setInbox(await fetchInbox(centreId)); }, [centreId]);
  useEffect(() => { loadInbox(); }, [loadInbox]);
  const countChecks = useCallback(async () => { if (centreId) setToCheck(await countToCheck(centreId).catch(() => null)); }, [centreId]);
  useEffect(() => { countChecks(); }, [countChecks]);

  const update = (id: number, patch: Partial<Item>) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const addFiles = async (files: FileList | File[]) => {
    setResult(null); setFailMsg('');
    for (const f of Array.from(files)) {
      const id = ++seq;
      setItems((xs) => [...xs, { id, name: f.name, state: 'reading', kind: 'payments', ...blank }]);
      try {
        if (/\.(xlsx|xls|csv)$/i.test(f.name)) {
          if (/\.xls$/i.test(f.name)) throw new Error('This is an old Excel file (.xls). Open it in Excel, choose Save As → .xlsx, and add it again.');
          let cells: Cell[][];
          if (/\.csv$/i.test(f.name)) cells = parseCsv(await f.text());
          else {
            const { default: readXlsxFile, readSheetNames } = await import('read-excel-file');
            // a workbook may hold several tabs: use the first one ClaimOne recognises
            const names = await readSheetNames(f);
            const sheets = await Promise.all(names.map((sheet) => readXlsxFile(f, { sheet }) as Promise<Cell[][]>));
            cells = sheets.find((s) => detectKind(cellsToRows(s), s) !== 'payments') ?? sheets[0] ?? [];
          }
          const rows = cellsToRows(cells);
          const kind = detectKind(rows, cells);
          if (kind === 'bank') {
            const r = parseBankStatement(rows);
            if (!r.rows.length) throw new Error('No money received (credits) found in this bank statement.');
            update(id, { state: 'ready', kind, bank: r.rows });
          } else if (kind === 'pmjay_cases') {
            const r = parsePmjay(cells);
            if (!r.rows.length) throw new Error('No cases found in this PMJAY sheet.');
            update(id, { state: 'ready', kind, cases: r.rows });
          } else {
            const r = parsePaymentSheet(rows);
            if (!r.rows.length) throw new Error('No payments found in this file.');
            update(id, { state: 'ready', kind, lines: r.rows });
          }
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
    setItems((xs) => [...xs, { id, name: 'Email text', state: 'reading', kind: 'payments', ...blank }]);
    const t = text; setText(''); setShowPaste(false);
    try {
      const lines = await readLetter({ text: t });
      if (!lines.length) throw new Error('No claim no. or bill no. found in this text.');
      update(id, { state: 'ready', lines });
    } catch (e) { update(id, { state: 'error', error: (e as Error).message }); }
  };

  // a statement the bot downloaded from a TPA website: read it like an uploaded file
  const addFromInbox = (b: InboxItem) => {
    setResult(null); setFailMsg('');
    const id = ++seq;
    const name = `${b.source_label} — ${b.file_name}`;
    try {
      const r = parsePaymentSheet(b.rows, b.source_label.replace(/ website$/, ''));
      if (!r.rows.length) throw new Error('No payments found in this statement.');
      setItems((xs) => [...xs, { id, name, state: 'ready', kind: 'payments', ...blank, lines: r.rows, inboxId: b.id }]);
    } catch (e) {
      setItems((xs) => [...xs, { id, name, state: 'error', kind: 'payments', ...blank, error: (e as Error).message, inboxId: b.id }]);
    }
  };
  const added = new Set(items.map((x) => x.inboxId).filter(Boolean));

  const ready = items.filter((x) => x.state === 'ready');
  const busy = items.some((x) => x.state === 'reading');
  const needsAccount = ready.some((x) => x.kind === 'bank');

  const save = async () => {
    if (!centreId || !ready.length) return;
    if (needsAccount && account.trim().length < 3) { setFailMsg('Type which bank account the statement is for (e.g. Kotak 0945).'); return; }
    setFailMsg('');
    const out: Result = { pay: null, cases: null, bank: null, auto: { matched: 0, left: 0 } };
    try {
      // cases first, so payments in the same batch find them
      for (const it of ready.filter((x) => x.kind === 'pmjay_cases')) {
        setSaving(`Saving ${it.name}…`);
        const r = await importPmjay(centreId, it.name, it.cases, (k) => setSaving(`Saving ${it.name}: ${n(k)} of ${n(it.cases.length)}`));
        out.cases = out.cases ? { created: out.cases.created + r.created, updated: out.cases.updated + r.updated, moved: out.cases.moved + r.moved,
          paid: out.cases.paid + r.paid, skipped: out.cases.skipped + r.skipped, problems: [...out.cases.problems, ...r.problems] } : r;
      }
      for (const it of ready.filter((x) => x.kind === 'payments')) {
        setSaving(`Saving ${it.name}…`);
        const r = await applyPayments(centreId, it.name, it.lines, (k) => setSaving(`Saving ${it.name}: ${n(k)} of ${n(it.lines.length)}`));
        if (!out.pay) out.pay = r;
        else for (const k of Object.keys(r) as (keyof ApplyResult)[]) out.pay[k] += r[k];
        if (it.inboxId) await markInboxUsed(it.inboxId).catch(() => {});
      }
      for (const it of ready.filter((x) => x.kind === 'bank')) {
        setSaving(`Saving ${it.name}…`);
        const r = await importRows({ kind: 'bank_statement', centre_id: centreId, file_name: it.name, bank_account: account.trim(), rows: it.bank });
        out.bank = { inserted: (out.bank?.inserted ?? 0) + r.inserted, duplicates: (out.bank?.duplicates ?? 0) + r.duplicates };
      }
      if (needsAccount) { try { localStorage.setItem(ACCOUNT_KEY, account.trim()); } catch { /* private window */ } }
      setSaving('Matching bank money to bills…');
      out.auto = await autoMatch(centreId);
      setResult(out);
      setItems([]);
    } catch (e) { setFailMsg((e as Error).message); }
    await Promise.all([countChecks(), loadInbox()]);
    setSaving('');
  };

  if (!centreId) return <NoCentre />;
  if (!canWrite) return <div className="p-10 text-center text-base text-slate-600">Your login can only view. Ask your manager to upload payments.</div>;

  const waiting = inbox.filter((b) => !added.has(b.id));
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 md:px-6">
      <h1 className="text-2xl font-bold text-slate-900">Upload</h1>
      <p className="mt-1 text-base text-slate-600">Add every money file here — TPA and insurer letters, the PMJAY sheet, the bank statement — then press <b>Save</b>.</p>

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5">
        <label
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); }}
          className={`flex min-h-40 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-8 text-center transition ${drag ? 'border-teal-500 bg-teal-50' : 'border-slate-300 hover:border-teal-400 hover:bg-slate-50'}`}>
          <Upload className="h-10 w-10 text-teal-600" />
          <span className="text-lg font-semibold text-slate-800">Tap here to choose files</span>
          <span className="text-sm text-slate-500">Excel, CSV, PDF or a WhatsApp photo · several at once is fine</span>
          <input type="file" multiple accept=".xlsx,.xls,.csv,.pdf,image/*" className="hidden"
            onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
        </label>

        {waiting.length > 0 && (
          <div className="mt-4 rounded-xl border border-teal-200 bg-teal-50 p-4">
            <p className="flex items-center gap-2 text-base font-semibold text-teal-900"><Bot className="h-5 w-5" /> Downloaded from TPA websites</p>
            <ul className="mt-2 space-y-2">
              {waiting.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white p-3">
                  <span className="text-base text-slate-800"><b>{b.source_label}</b> · {shortDate(b.created_at)}</span>
                  <button onClick={() => addFromInbox(b)}
                    className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-teal-600 px-4 text-base font-semibold text-white hover:bg-teal-700">
                    <Plus className="h-5 w-5" /> Add
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

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
            {items.map((it) => (
              <li key={it.id} className="flex items-start gap-3 p-4">
                {it.kind === 'bank' ? <Landmark className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" /> : <FileText className="mt-0.5 h-5 w-5 shrink-0 text-slate-400" />}
                <div className="min-w-0 flex-1 text-base">
                  <p className="truncate font-medium text-slate-900">{it.name}</p>
                  {it.state === 'reading' && <p className="flex items-center gap-2 text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Reading…</p>}
                  {it.state === 'error' && <p className="text-rose-700">{it.error}</p>}
                  {it.state === 'ready' && (
                    <p className="text-slate-700"><CheckCircle2 className="mr-1 inline h-4 w-4 text-emerald-600" />
                      <span className="mr-1.5 rounded bg-slate-100 px-1.5 py-0.5 text-xs font-semibold text-slate-700">{KIND_LABEL[it.kind]}</span>{describe(it)}</p>
                  )}
                </div>
                <button aria-label={`Remove ${it.name}`} onClick={() => setItems((xs) => xs.filter((x) => x.id !== it.id))}
                  className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100"><X className="h-5 w-5" /></button>
              </li>
            ))}
          </ul>
        )}

        {needsAccount && (
          <label className="mt-4 block text-base font-medium text-slate-800">Bank account of this statement
            <input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="e.g. Kotak 0945"
              className="mt-1 min-h-12 w-full rounded-lg border border-slate-300 px-3 text-base focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100" />
          </label>
        )}

        <button onClick={save} disabled={!ready.length || busy || !!saving}
          className="mt-4 flex min-h-14 w-full items-center justify-center gap-2 rounded-xl bg-teal-600 text-lg font-bold text-white hover:bg-teal-700 disabled:opacity-40">
          {saving ? <Loader2 className="h-5 w-5 animate-spin" /> : <CheckCircle2 className="h-5 w-5" />}
          {saving ? 'Saving…' : ready.length ? `Save ${n(ready.length)} file${ready.length === 1 ? '' : 's'}` : 'Save'}
        </button>
        {saving && <p className="mt-2 text-center text-base text-slate-600">{saving}</p>}

        {failMsg && <p role="alert" className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-base text-rose-800">{failMsg}</p>}
        {result && (
          <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-base text-emerald-900">
            <p className="flex items-center gap-2 text-lg font-semibold"><CheckCircle2 className="h-5 w-5" /> Saved</p>
            <ul className="mt-1 space-y-0.5">
              {result.pay && <li><b>{n(result.pay.matched)}</b> payments added to bills{result.pay.duplicate > 0 && ` · ${n(result.pay.duplicate)} were already saved`}</li>}
              {result.pay && result.pay.invalid + result.pay.skipped > 0 && <li>{n(result.pay.invalid + result.pay.skipped)} lines had no bill or claim no. and were left out</li>}
              {result.cases && <li><b>{n(result.cases.created)}</b> new PMJAY cases · {n(result.cases.moved)} status steps moved forward · {n(result.cases.paid)} payments recorded</li>}
              {result.cases?.problems.map((p, i) => <li key={i} className="text-amber-900">IP {p.ip}: {p.problem}</li>)}
              {result.bank && <li><b>{n(result.bank.inserted)}</b> bank credits added{result.bank.duplicates > 0 && ` · ${n(result.bank.duplicates)} were already there`}</li>}
              {result.auto.matched > 0 && <li><b>{n(result.auto.matched)}</b> bank credits matched to bills automatically</li>}
              {result.auto.left > 0 && <li className="text-amber-900">{n(result.auto.left)} bank credits could not be tied to a bill — see To check</li>}
            </ul>
          </div>
        )}
      </section>

      <Link href="/pay/check"
        className={`mt-4 flex min-h-14 items-center justify-between rounded-2xl border px-5 text-lg font-semibold ${toCheck ? 'border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100' : 'border-emerald-200 bg-emerald-50 text-emerald-900'}`}>
        <span>{toCheck == null ? 'To check' : toCheck ? `To check — ${n(toCheck)} need a person` : 'To check — all clear'}</span>
        <ArrowRight className="h-5 w-5" />
      </Link>
    </div>
  );
}
