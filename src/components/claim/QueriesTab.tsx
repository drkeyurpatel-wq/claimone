'use client';
import { useState } from 'react';
import { CheckCircle2, MessageSquare, Send, Loader2, Plus } from 'lucide-react';
import type { ClaimQuery } from '@/lib/claims/types';
import { PRIORITY_CONFIG } from '@/lib/claims/types';
import { addClaimQuery, respondToQuery } from '@/lib/claims/api';
import { dateTime, btn } from '@/components/ui';

const OPEN = ['open', 'in_progress', 'escalated'];

export function QueriesTab({ claimId, queries, canWrite, onChanged, flash }: {
  claimId: string; queries: ClaimQuery[]; canWrite: boolean;
  onChanged: () => Promise<void>; flash: (m: string, t?: 'ok' | 'err') => void;
}) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ text: '', category: 'documentation', priority: 'medium', role: '', raisedBy: '' });
  const [saving, setSaving] = useState(false);

  const add = async () => {
    setSaving(true);
    try {
      await addClaimQuery({ claim_id: claimId, query_text: form.text.trim(), query_category: form.category,
        priority: form.priority, routed_to_role: form.role || undefined, raised_by: form.raisedBy || undefined });
      setAdding(false); setForm({ text: '', category: 'documentation', priority: 'medium', role: '', raisedBy: '' });
      flash('Query logged — SLA clock started');
      await onChanged();
    } catch (e) { flash((e as Error).message, 'err'); }
    setSaving(false);
  };

  const sel = 'mt-0.5 w-full rounded-lg border border-slate-200 px-2 py-1.5 text-xs';
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-600">Payer queries ({queries.length})</h3>
        {canWrite && <button className={btn.ghost} onClick={() => setAdding(!adding)}><Plus className="h-3.5 w-3.5" /> {adding ? 'Cancel' : 'Log query'}</button>}
      </div>

      {adding && (
        <div className="space-y-3 rounded-xl border border-orange-200 bg-orange-50 p-4">
          <textarea autoFocus rows={3} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })}
            placeholder="Paste or type the payer's query" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div><label className="text-[10px] uppercase text-slate-500">Category</label>
              <select className={sel} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                <option value="documentation">Documentation</option><option value="clinical">Clinical</option>
                <option value="billing">Billing</option><option value="policy">Policy</option><option value="other">Other</option>
              </select></div>
            <div><label className="text-[10px] uppercase text-slate-500">Priority</label>
              <select className={sel} value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
                <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option>
              </select></div>
            <div><label className="text-[10px] uppercase text-slate-500">Needs answer from</label>
              <select className={sel} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                <option value="">Insurance desk</option><option value="doctor">Treating doctor</option>
                <option value="billing">Billing</option><option value="mrd">Medical records</option>
              </select></div>
            <div><label className="text-[10px] uppercase text-slate-500">Raised by (payer staff)</label>
              <input className={sel} value={form.raisedBy} onChange={(e) => setForm({ ...form, raisedBy: e.target.value })} /></div>
          </div>
          <div className="flex justify-end">
            <button disabled={saving || !form.text.trim()} onClick={add} className={`${btn.primary} bg-orange-600 hover:bg-orange-700`}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} Log query
            </button>
          </div>
        </div>
      )}

      {queries.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
          <CheckCircle2 className="mx-auto mb-2 h-9 w-9 text-emerald-300" /><p className="text-sm text-slate-500">No queries on this claim</p>
        </div>
      ) : queries.map((q) => <QueryCard key={q.id} q={q} canWrite={canWrite} onChanged={onChanged} flash={flash} />)}
    </div>
  );
}

function QueryCard({ q, canWrite, onChanged, flash }: { q: ClaimQuery; canWrite: boolean; onChanged: () => Promise<void>; flash: (m: string, t?: 'ok' | 'err') => void }) {
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const isOpen = OPEN.includes(q.status);
  const hoursLeft = Math.round((new Date(q.sla_deadline).getTime() - Date.now()) / 3600000);
  const p = PRIORITY_CONFIG[q.priority];

  const send = async () => {
    setSaving(true);
    try { await respondToQuery(q.id, text.trim()); setReplying(false); setText(''); flash('Reply saved'); await onChanged(); }
    catch (e) { flash((e as Error).message, 'err'); }
    setSaving(false);
  };

  return (
    <div className={`rounded-xl border bg-white p-4 ${isOpen ? (hoursLeft < 0 ? 'border-rose-300' : 'border-orange-200') : 'border-slate-200'}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-[10px]">
            <span className="font-bold text-slate-500">Q{q.query_number}</span>
            <span className={`rounded px-1.5 py-0.5 font-semibold ${p.bg} ${p.color}`}>{p.label}</span>
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">{q.query_category}</span>
            {q.routed_to_role && <span className="text-slate-400">→ {q.routed_to_role}</span>}
            <span className="text-slate-400">raised {dateTime(q.raised_at)}{q.raised_by ? ` by ${q.raised_by}` : ''}</span>
          </div>
          <p className="mt-2 text-sm leading-relaxed text-slate-800">{q.query_text}</p>
          {q.response_text && (
            <div className="mt-2 rounded-lg border border-blue-100 bg-blue-50 p-2.5">
              <p className="text-[10px] font-semibold uppercase text-blue-600">Reply · {dateTime(q.responded_at)}</p>
              <p className="text-sm text-blue-900">{q.response_text}</p>
            </div>
          )}
        </div>
        {isOpen && (
          <div className="shrink-0 text-right">
            <p className={`tabular text-sm font-bold ${hoursLeft < 0 ? 'text-rose-600' : hoursLeft < 12 ? 'text-orange-600' : 'text-slate-600'}`}>
              {hoursLeft < 0 ? `${-hoursLeft}h over` : `${hoursLeft}h left`}
            </p>
            <p className="text-[10px] text-slate-400">to reply</p>
          </div>
        )}
      </div>
      {isOpen && canWrite && !replying && (
        <button onClick={() => setReplying(true)} className="mt-3 inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700">
          <MessageSquare className="h-3 w-3" /> Reply
        </button>
      )}
      {replying && (
        <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
          <textarea autoFocus rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Reply sent to the payer"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
          <div className="flex justify-end gap-2">
            <button onClick={() => setReplying(false)} className="rounded-lg border px-3 py-1.5 text-xs">Cancel</button>
            <button disabled={saving || !text.trim()} onClick={send} className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />} Save reply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
