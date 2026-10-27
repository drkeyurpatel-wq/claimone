'use client';
// Document rules: what each submission needs. Platform defaults come with
// the app; managers add hospital or payer rules on top (the most specific wins).
import { useEffect, useMemo, useState } from 'react';
import { ListChecks, Plus, Loader2 } from 'lucide-react';
import { sb } from '@/lib/supabase/browser';
import { useAuthStore } from '@/lib/store/auth';
import { fetchDocRules, fetchPayers } from '@/lib/claims/api';
import { CLAIM_TYPE_LABELS, type DocRuleRow, type Payer } from '@/lib/claims/types';
import { PageHeader, Skeleton, inr, useToast, btn } from '@/components/ui';

const STAGES = [['preauth', 'Pre-auth'], ['final', 'Final claim'], ['reimbursement', 'Reimbursement']] as const;
const BLANK = { stage: 'final', payer_id: '', claim_type: '', doc_code: '', doc_label: '', is_mandatory: true, min_amount: '' };

export default function Rules() {
  const { tenantId, staff } = useAuthStore();
  const isManager = staff?.role === 'admin' || staff?.role === 'manager';
  const [rules, setRules] = useState<DocRuleRow[]>([]);
  const [payers, setPayers] = useState<Payer[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<typeof BLANK | null>(null);
  const [saving, setSaving] = useState(false);
  const { flash, toastNode } = useToast();

  const load = () => Promise.all([fetchDocRules(), fetchPayers()]).then(([r, p]) => { setRules(r); setPayers(p); setLoading(false); });
  useEffect(() => { load(); }, []);

  const payerName = useMemo(() => Object.fromEntries(payers.map((p) => [p.id, p.name])), [payers]);
  const scope = (r: DocRuleRow) => [
    r.tenant_id ? 'Our hospital' : 'Default',
    r.payer_id ? payerName[r.payer_id] ?? 'payer' : null,
    r.claim_type ? CLAIM_TYPE_LABELS[r.claim_type] : null,
  ].filter(Boolean).join(' · ');

  const save = async () => {
    if (!form || !tenantId) return;
    setSaving(true);
    const code = form.doc_code.trim() || form.doc_label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const { error } = await sb().from('clm_doc_rules').insert({
      tenant_id: tenantId, stage: form.stage, payer_id: form.payer_id || null, claim_type: form.claim_type || null,
      doc_code: code, doc_label: form.doc_label.trim(), is_mandatory: form.is_mandatory,
      min_amount: form.min_amount ? Number(form.min_amount) : null, sort_order: 100,
    });
    setSaving(false);
    if (error) { flash(error.message, 'err'); return; }
    flash('Rule added'); setForm(null); load();
  };

  const toggle = async (r: DocRuleRow, active: boolean) => {
    const { error } = await sb().from('clm_doc_rules').update({ is_active: active }).eq('id', r.id);
    if (error) flash(error.message, 'err'); else load();
  };

  const existingCodes = useMemo(() => [...new Map(rules.map((r) => [r.doc_code, r.doc_label])).entries()], [rules]);
  const inp = 'mt-1 w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm';

  return (
    <div>
      {toastNode}
      <PageHeader title="Document rules" sub="What must be verified before each submission. A hospital or payer rule overrides the default for the same document." icon={ListChecks}>
        {isManager && <button className={btn.primary} onClick={() => setForm(form ? null : { ...BLANK })}><Plus className="h-4 w-4" /> Add rule</button>}
      </PageHeader>

      {form && (
        <div className="mx-6 mt-4 grid gap-3 rounded-2xl border border-teal-200 bg-teal-50/50 p-4 md:grid-cols-3">
          <div><label className="text-[11px] font-semibold text-slate-600">Stage</label>
            <select className={inp} value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value })}>{STAGES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
          <div><label className="text-[11px] font-semibold text-slate-600">Only for payer</label>
            <select className={inp} value={form.payer_id} onChange={(e) => setForm({ ...form, payer_id: e.target.value })}><option value="">Every payer</option>{payers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
          <div><label className="text-[11px] font-semibold text-slate-600">Only for claim type</label>
            <select className={inp} value={form.claim_type} onChange={(e) => setForm({ ...form, claim_type: e.target.value })}><option value="">Every type</option>{Object.entries(CLAIM_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
          <div className="md:col-span-2"><label className="text-[11px] font-semibold text-slate-600">Document</label>
            <input className={inp} list="codes" value={form.doc_label} placeholder="e.g. Signed consent form"
              onChange={(e) => { const hit = existingCodes.find(([, l]) => l === e.target.value); setForm({ ...form, doc_label: e.target.value, doc_code: hit ? hit[0] : '' }); }} />
            <datalist id="codes">{existingCodes.map(([c, l]) => <option key={c} value={l} />)}</datalist>
            <p className="mt-1 text-[11px] text-slate-500">{form.doc_code ? `Overrides the existing "${form.doc_code}" rule for this scope.` : 'New document type.'}</p></div>
          <div><label className="text-[11px] font-semibold text-slate-600">Only above amount (₹)</label>
            <input className={inp} inputMode="decimal" value={form.min_amount} onChange={(e) => setForm({ ...form, min_amount: e.target.value })} /></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.is_mandatory} onChange={(e) => setForm({ ...form, is_mandatory: e.target.checked })} /> Blocks submission until verified</label>
          <div className="flex justify-end gap-2 md:col-span-2">
            <button className={btn.ghost} onClick={() => setForm(null)}>Cancel</button>
            <button className={btn.primary} disabled={saving || !form.doc_label.trim()} onClick={save}>{saving && <Loader2 className="h-4 w-4 animate-spin" />} Save rule</button>
          </div>
        </div>
      )}

      <div className="grid gap-4 px-6 py-4 lg:grid-cols-3">
        {loading ? <Skeleton /> : STAGES.map(([stage, label]) => (
          <section key={stage} className="rounded-2xl border border-slate-200 bg-white p-4">
            <h2 className="mb-3 text-sm font-bold text-slate-900">{label}</h2>
            <ul className="space-y-1.5">
              {rules.filter((r) => r.stage === stage).map((r) => (
                <li key={r.id} className="rounded-lg border border-slate-100 px-3 py-2">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm text-slate-800">{r.doc_label}</p>
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${r.is_mandatory ? 'bg-rose-50 text-rose-700' : 'bg-slate-100 text-slate-500'}`}>{r.is_mandatory ? 'required' : 'optional'}</span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-slate-500">{scope(r)}{r.min_amount != null ? ` · from ${inr(r.min_amount)}` : ''}</p>
                  {isManager && r.tenant_id && <button onClick={() => toggle(r, false)} className="mt-1 text-[11px] text-slate-400 hover:text-rose-600">Remove</button>}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      {!loading && <p className="px-6 pb-6 text-xs text-slate-500">
        Starter defaults ({rules.filter((r) => !r.tenant_id).length} rules) need a check by the billing head, especially the PMJAY additions. Claim types: {Object.values(CLAIM_TYPE_LABELS).join(', ')}.
      </p>}
    </div>
  );
}
