'use client';
// Import: bank statement, the cashless team's tracker tab, a payer's
// settlement advice, or the patient-dues list. Read and checked in the
// browser, previewed, then saved.
import { useState } from 'react';
import Link from 'next/link';
import { Upload, FileSpreadsheet, Loader2, CheckCircle2, ArrowLeft } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import { parseCsv, parseBankStatement, parseCashlessTracker, parseAdvice, parsePatientDues } from '@/lib/recon/parse';
import { importRows } from '@/lib/recon/api';
import { PageHeader, NoCentre, inr, shortDate, btn } from '@/components/ui';

type Kind = 'bank_statement' | 'cashless_tracker' | 'settlement_advice' | 'patient_dues';
const KINDS: { k: Kind; title: string; how: string }[] = [
  { k: 'bank_statement', title: 'Bank statement', how: 'Download the statement from net banking as CSV (Excel → Save as CSV). Credits become receipts; debits are ignored. Re-importing an overlapping period is safe.' },
  { k: 'cashless_tracker', title: 'Cashless tracker (one month tab)', how: 'In the TPA PTS DETAILS sheet: File → Download → CSV for one month tab. Each bill becomes a receivable for its approved amount; the UTR the team typed helps matching.' },
  { k: 'settlement_advice', title: 'Payer settlement advice', how: 'The Excel/CSV the TPA or insurer emails with each payment: claim no., UTR, TDS, deduction and net paid per claim.' },
  { k: 'patient_dues', title: 'Patient dues', how: 'The list of receipts issued without cash collected (IP no., patient, doctor, amount, discharge date, care of).' },
];

type Preview = { kind: Kind; rows: Record<string, unknown>[]; skipped: { line: number; reason: string }[]; file: string };

export default function ImportPage() {
  const centreId = useAuthStore((s) => s.activeCentreId);
  const role = useAuthStore((s) => s.staff?.role);
  const [kind, setKind] = useState<Kind>('bank_statement');
  const [account, setAccount] = useState('');
  const [payer, setPayer] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<string>('');

  if (!centreId) return <NoCentre />;
  if (role && !['admin', 'manager', 'desk'].includes(role)) return <div className="p-10 text-center text-sm text-slate-500">Your login is read-only.</div>;

  const read = async (file: File | undefined) => {
    setError(''); setPreview(null); setDone('');
    if (!file) return;
    if (!/\.csv$/i.test(file.name)) { setError('Save the file as CSV first (Excel or Google Sheets: Download → CSV).'); return; }
    try {
      const rows = parseCsv(await file.text());
      const res = kind === 'bank_statement' ? parseBankStatement(rows) : kind === 'cashless_tracker' ? parseCashlessTracker(rows)
        : kind === 'settlement_advice' ? parseAdvice(rows) : parsePatientDues(rows);
      if (!res.rows.length) { setError('No usable rows found. Check that this is the right kind of file.'); return; }
      setPreview({ kind, rows: res.rows as unknown as Record<string, unknown>[], skipped: res.skipped, file: file.name });
    } catch (e) { setError((e as Error).message); }
  };

  const save = async () => {
    if (!preview) return;
    if (preview.kind === 'bank_statement' && !account.trim()) { setError('Name the bank account (e.g. Kotak 0945694616).'); return; }
    setSaving(true); setError('');
    try {
      const r = await importRows({ kind: preview.kind, centre_id: centreId, file_name: preview.file, rows: preview.rows,
        ...(preview.kind === 'bank_statement' ? { bank_account: account.trim() } : {}),
        ...(preview.kind === 'settlement_advice' && payer.trim() ? { payer_name: payer.trim() } : {}) });
      setDone(`Saved ${r.inserted} row${r.inserted === 1 ? '' : 's'}${r.duplicates ? `; ${r.duplicates} already there were skipped` : ''}.`);
      setPreview(null);
    } catch (e) { setError((e as Error).message); }
    setSaving(false);
  };

  const total = preview ? preview.rows.reduce((s, r) => s + Number(r.amount ?? r.approved ?? r.net_amount ?? 0), 0) : 0;
  const cols: Record<Kind, [string, string][]> = {
    bank_statement: [['value_date', 'Date'], ['amount', 'Amount'], ['reference', 'Reference'], ['narration', 'Narration']],
    cashless_tracker: [['bill_no', 'Bill'], ['bill_date', 'Bill date'], ['patient_name', 'Patient'], ['insurer', 'Insurer'], ['approved', 'Approved'], ['recorded_utr', 'UTR recorded']],
    settlement_advice: [['claim_ref', 'Claim'], ['utr', 'UTR'], ['tds_amount', 'TDS'], ['deduction_amount', 'Deduction'], ['net_amount', 'Net paid']],
    patient_dues: [['ip_no', 'IP no.'], ['patient_name', 'Patient'], ['amount', 'Amount'], ['bill_date', 'Discharged'], ['care_of', 'Care of']],
  };
  const fmt = (k: string, v: unknown) => (v == null || v === '' ? '—' : /amount|approved|tds|deduction|net/.test(k) ? inr(Number(v)) : /date/.test(k) ? shortDate(String(v)) : String(v));

  return (
    <div>
      <PageHeader title="Import" sub="Bring in what the teams already keep, as CSV" icon={Upload}>
        <Link href="/receivables" className={btn.ghost}><ArrowLeft className="h-3.5 w-3.5" /> Receivables</Link>
      </PageHeader>
      <div className="mx-auto max-w-5xl space-y-4 px-4 py-6 md:px-6">
        <div className="grid gap-3 md:grid-cols-2">
          {KINDS.map((x) => (
            <button key={x.k} onClick={() => { setKind(x.k); setPreview(null); setError(''); setDone(''); }}
              className={`rounded-xl border p-4 text-left transition ${kind === x.k ? 'border-teal-500 bg-teal-50/50 ring-2 ring-teal-100' : 'border-slate-200 bg-white hover:border-slate-300'}`}>
              <p className="flex items-center gap-2 text-sm font-semibold text-slate-900"><FileSpreadsheet className="h-4 w-4 text-teal-600" /> {x.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-slate-600">{x.how}</p>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4">
          {kind === 'bank_statement' && (
            <div><label htmlFor="acct" className="text-[11px] font-semibold text-slate-600">Bank account</label>
              <input id="acct" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="Kotak 0945694616" className={`${btn.input} mt-1 w-56 block`} /></div>
          )}
          {kind === 'settlement_advice' && (
            <div><label htmlFor="payer" className="text-[11px] font-semibold text-slate-600">Paid by (insurer or TPA)</label>
              <input id="payer" value={payer} onChange={(e) => setPayer(e.target.value)} placeholder="e.g. MD India / Oriental" className={`${btn.input} mt-1 w-56 block`} /></div>
          )}
          <label className={`${btn.primary} cursor-pointer`}>
            <Upload className="h-4 w-4" /> Choose CSV
            <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => { read(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
          {error && <p className="w-full text-sm text-rose-600">{error}</p>}
          {done && <p className="flex w-full items-center gap-1.5 text-sm text-emerald-700"><CheckCircle2 className="h-4 w-4" /> {done} <Link href="/receivables/reconcile" className="ml-2 font-semibold underline">Reconcile now</Link></p>}
        </div>

        {preview && (
          <div className="rounded-xl border border-slate-200 bg-white">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 p-4">
              <p className="text-sm"><b>{preview.rows.length}</b> rows from {preview.file} · total <b className="tabular">{inr(total)}</b>
                {preview.skipped.length > 0 && <span className="ml-2 text-amber-700">{preview.skipped.length} lines skipped</span>}</p>
              <button onClick={save} disabled={saving} className={btn.primary}>{saving && <Loader2 className="h-4 w-4 animate-spin" />} Save {preview.rows.length} rows</button>
            </div>
            <div className="max-h-[420px] overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-slate-50"><tr>{cols[preview.kind].map(([, l]) => <th key={l} className="px-3 py-2 text-left font-semibold text-slate-500">{l}</th>)}</tr></thead>
                <tbody>
                  {preview.rows.slice(0, 200).map((r, i) => (
                    <tr key={i} className="border-t border-slate-100">{cols[preview.kind].map(([k]) => <td key={k} className="max-w-xs truncate px-3 py-1.5">{fmt(k, r[k])}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.skipped.length > 0 && (
              <p className="border-t border-slate-100 p-3 text-xs text-slate-500">
                Skipped: {preview.skipped.slice(0, 8).map((s) => `line ${s.line} (${s.reason})`).join(', ')}{preview.skipped.length > 8 ? ' …' : ''}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
