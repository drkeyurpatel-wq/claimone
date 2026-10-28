'use client';
// ClaimOne's readiness meter + document checklist, fed by the merged rules.
// One row per paper: tick it once it is attached on the insurer website.
// Uploading a copy is optional; an uploaded copy can be verified or rejected.
import { useMemo, useState } from 'react';
import { CheckCircle2, CircleDashed, FileX2, AlertTriangle, Upload, Eye, Check, X, Loader2, FileText } from 'lucide-react';
import type { Claim, ClaimDocument, DocRuleRow } from '@/lib/claims/types';
import { validateClaim, docStatusByCode, toRules, stageAmount, type Stage } from '@/lib/engine/validation';
import { uploadClaimDocument, reviewDocument, documentUrl, tickDocument } from '@/lib/claims/api';

const STAGE_LABEL: Record<Stage, string> = { preauth: 'Pre-auth', final: 'Final claim', reimbursement: 'Reimbursement' };

export function ReadinessPanel({ claim, rules, documents, defaultStage, canWrite, onChanged, flash }: {
  claim: Claim; rules: DocRuleRow[]; documents: ClaimDocument[]; defaultStage: Stage | null;
  canWrite: boolean; onChanged: () => Promise<void>; flash: (m: string, t?: 'ok' | 'err') => void;
}) {
  const stages: Stage[] = claim.claim_type === 'reimbursement' ? ['reimbursement'] : ['preauth', 'final'];
  const [stage, setStage] = useState<Stage>(defaultStage ?? stages[stages.length - 1]);
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<{ id: string; note: string } | null>(null);

  const result = useMemo(() => validateClaim({
    tenantId: claim.tenant_id, payerId: claim.payer_id, claimType: claim.claim_type, stage,
    amount: stageAmount(stage, claim), documents: docStatusByCode(documents),
  }, toRules(rules)), [claim, rules, documents, stage]);

  const byCode = (code: string) => documents.filter((d) => d.doc_code === code);
  const knownCodes = new Set(rules.map((r) => r.doc_code));
  const others = documents.filter((d) => !d.doc_code || !knownCodes.has(d.doc_code));

  const upload = async (file: File | undefined, code: string | null, label: string) => {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) { flash('Files must be under 20 MB.', 'err'); return; }
    setBusy(`up-${code ?? 'other'}`);
    try {
      await uploadClaimDocument({ tenant_id: claim.tenant_id, claim_id: claim.id, file, document_name: label,
        document_category: code ? 'clinical' : 'other', doc_code: code });
      flash('Uploaded — now verify it');
      await onChanged();
    } catch (e) { flash((e as Error).message, 'err'); }
    setBusy(null);
  };

  const review = async (doc: ClaimDocument, status: 'valid' | 'invalid', note?: string) => {
    setBusy(doc.id);
    try { await reviewDocument(claim.id, doc.id, status, note); flash(status === 'valid' ? 'Verified' : 'Marked as rejected'); await onChanged(); }
    catch (e) { flash((e as Error).message, 'err'); }
    setBusy(null); setRejecting(null);
  };

  const tick = async (code: string, label: string, on: boolean) => {
    setBusy(`tick-${code}`);
    try { await tickDocument(claim.id, code, label, on); await onChanged(); }
    catch (e) { flash((e as Error).message, 'err'); }
    setBusy(null);
  };

  const open = async (doc: ClaimDocument) => {
    try { window.open(await documentUrl(claim.id, doc.id), '_blank', 'noopener'); }
    catch (e) { flash((e as Error).message, 'err'); }
  };

  // A render helper (not a component) so the reject-reason input keeps focus.
  const docLine = (d: ClaimDocument) => d.attested ? (
    <div key={d.id} className="flex items-center gap-2 pl-10 text-xs text-slate-500">
      <Check className="h-3.5 w-3.5 text-emerald-600" /> {d.status === 'valid' ? 'Ticked — sent to the insurer' : 'Unticked'}
      {d.verified_at && <span>· {new Date(d.verified_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</span>}
    </div>
  ) : (
    <div key={d.id} className="flex flex-wrap items-center gap-2 pl-10 text-xs">
      <FileText className="h-3.5 w-3.5 text-slate-400" />
      <button onClick={() => open(d)} className="font-medium text-teal-700 hover:underline">{d.document_name}</button>
      <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${d.status === 'valid' ? 'bg-emerald-100 text-emerald-700' : d.status === 'invalid' ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-700'}`}>
        {d.status === 'valid' ? 'verified' : d.status === 'invalid' ? 'rejected' : 'not reviewed'}
      </span>
      {d.status === 'invalid' && d.review_note && <span className="text-rose-600">— {d.review_note}</span>}
      {canWrite && d.status === 'uploaded' && (
        <>
          <button disabled={busy === d.id} onClick={() => review(d, 'valid')} className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2 py-0.5 font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">
            {busy === d.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Verify
          </button>
          <button onClick={() => setRejecting({ id: d.id, note: '' })} className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-0.5 font-semibold text-slate-700 hover:bg-slate-200">
            <X className="h-3 w-3" /> Reject
          </button>
        </>
      )}
      <button onClick={() => open(d)} className="text-slate-400 hover:text-slate-700" aria-label="Open document"><Eye className="h-3.5 w-3.5" /></button>
      {rejecting?.id === d.id && (
        <div className="flex w-full items-center gap-2 pt-1">
          <input autoFocus value={rejecting.note} onChange={(e) => setRejecting({ id: d.id, note: e.target.value })}
            placeholder="Why is it rejected? (e.g. unsigned, wrong patient)" className="flex-1 rounded border border-slate-200 px-2 py-1" />
          <button disabled={!rejecting.note.trim()} onClick={() => review(d, 'invalid', rejecting.note)} className="rounded bg-rose-600 px-2 py-1 font-semibold text-white disabled:opacity-50">Reject</button>
          <button onClick={() => setRejecting(null)} className="text-slate-500">Cancel</button>
        </div>
      )}
    </div>
  );

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-600">Submission readiness</h3>
        {stages.length > 1 && (
          <div className="flex rounded-lg bg-slate-100 p-0.5">
            {stages.map((s) => (
              <button key={s} onClick={() => setStage(s)} className={`rounded-md px-2.5 py-1 text-[11px] font-semibold ${stage === s ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}>
                {STAGE_LABEL[s]}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs text-slate-500">{result.checks.length} documents apply to this {STAGE_LABEL[stage].toLowerCase()}</span>
        <span className={`text-sm font-extrabold ${result.canSubmit ? 'text-emerald-600' : 'text-rose-600'}`}>{result.readinessPct}%</span>
      </div>
      <div className="mb-4 h-1.5 overflow-hidden rounded-full bg-slate-100">
        <div className={`h-full rounded-full transition-all duration-500 ${result.canSubmit ? 'bg-emerald-500' : 'bg-rose-500'}`} style={{ width: `${result.readinessPct}%` }} />
      </div>

      <ul className="space-y-2">
        {result.checks.map((c) => {
          const files = byCode(c.docCode);
          const Icon = c.passed ? CheckCircle2 : c.status === 'uploaded' ? CircleDashed : FileX2;
          const tone = c.passed ? 'border-slate-200' : !c.isMandatory ? 'border-slate-200 bg-slate-50' : c.status === 'uploaded' ? 'border-amber-200 bg-amber-50/60' : 'border-rose-200 bg-rose-50/60';
          return (
            <li key={c.docCode} className={`space-y-1.5 rounded-lg border px-3 py-2.5 ${tone}`}>
              <div className="flex items-center gap-3">
                {canWrite ? (() => {
                  const ticked = files.some((f) => f.attested && f.status === 'valid');
                  const byFile = c.passed && !ticked;   // passed through a verified copy: nothing to untick
                  return (
                    <button role="checkbox" aria-checked={c.passed} aria-label={`${c.docLabel} sent`} disabled={byFile || busy === `tick-${c.docCode}`}
                      onClick={() => tick(c.docCode, c.docLabel, !ticked)}
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md border-2 transition ${c.passed ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-slate-300 bg-white hover:border-teal-500'} disabled:opacity-70`}>
                      {busy === `tick-${c.docCode}` ? <Loader2 className="h-4 w-4 animate-spin text-slate-400" /> : c.passed ? <Check className="h-4 w-4" /> : null}
                    </button>
                  );
                })() : <Icon className={`h-4 w-4 shrink-0 ${c.passed ? 'text-emerald-600' : c.status === 'uploaded' ? 'text-amber-600' : c.isMandatory ? 'text-rose-600' : 'text-slate-400'}`} />}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-800">{c.docLabel}{!c.isMandatory && <span className="ml-1.5 text-[10px] font-normal text-slate-400">optional</span>}</p>
                  <p className="text-[11px] text-slate-500">{c.appliedBecause}</p>
                </div>
                {canWrite && (
                  <label className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-white px-2 py-1 text-[11px] font-semibold text-teal-700 ring-1 ring-slate-200 hover:bg-teal-50">
                    {busy === `up-${c.docCode}` ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />} Upload copy
                    <input type="file" className="hidden" accept=".pdf,.jpg,.jpeg,.png,.webp,.heic"
                      onChange={(e) => { upload(e.target.files?.[0], c.docCode, c.docLabel); e.target.value = ''; }} />
                  </label>
                )}
              </div>
              {files.map(docLine)}
            </li>
          );
        })}
      </ul>

      {!result.canSubmit && (
        <div className="mt-4 flex gap-2.5 rounded-lg border border-rose-200 bg-rose-50 p-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
          <p className="text-[13px] leading-relaxed text-rose-900">
            {STAGE_LABEL[stage]} cannot be sent yet: {result.blockers.length} paper{result.blockers.length > 1 ? 's are' : ' is'} not ticked.
            Tick each paper once it is attached on the insurer website. Uploading a copy here is optional.
          </p>
        </div>
      )}

      <div className="mt-5 border-t border-slate-100 pt-4">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Other files ({others.length})</h4>
          {canWrite && (
            <label className="inline-flex cursor-pointer items-center gap-1 text-[11px] font-semibold text-teal-700 hover:underline">
              <Upload className="h-3 w-3" /> Upload other
              <input type="file" className="hidden" accept=".pdf,.jpg,.jpeg,.png,.webp,.heic"
                onChange={(e) => { const f = e.target.files?.[0]; upload(f, null, f?.name.replace(/\.[^/.]+$/, '') ?? 'Document'); e.target.value = ''; }} />
            </label>
          )}
        </div>
        <div className="space-y-1">{others.map(docLine)}</div>
      </div>
    </div>
  );
}
