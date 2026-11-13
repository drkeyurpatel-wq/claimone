/**
 * Deductions MIS: the same lines grouped by reason, speciality, procedure, consultant, centre or payer.
 * Pure functions over clm_v_deduction_lines rows — no I/O.
 */
import type { DeductionLine } from '@/lib/claims/types';
import { DISALLOWANCE_CATEGORIES } from '@/lib/engine/settlement';
import { CURRENT_FROM, doctorKey, doctorLabel } from './ledger';

export type GroupKey = 'reason' | 'speciality' | 'procedure' | 'doctor' | 'centre' | 'payer';
export const GROUPS: { key: GroupKey; label: string; column: string }[] = [
  { key: 'reason', label: 'Reason', column: 'Deduction reason' },
  { key: 'speciality', label: 'Speciality', column: 'Speciality' },
  { key: 'procedure', label: 'Procedure', column: 'Procedure' },
  { key: 'doctor', label: 'Consultant', column: 'Consultant' },
  { key: 'centre', label: 'Centre', column: 'Centre' },
  { key: 'payer', label: 'Payer', column: 'Payer' },
];

export const reasonLabel = (k: string) => (DISALLOWANCE_CATEGORIES as Record<string, { label: string }>)[k]?.label ?? k;
const NONE = 'Not recorded';
const clean = (v: string | null | undefined) => (v && v !== '—' ? v : NONE);

/** What a line is filed under for each grouping. */
export function groupOf(r: DeductionLine, by: GroupKey): { id: string; label: string; sub?: string } {
  switch (by) {
    case 'reason': return { id: r.category, label: reasonLabel(r.category) };
    case 'speciality': return { id: clean(r.speciality), label: clean(r.speciality) };
    case 'procedure': {
      const code = clean(r.procedure_code); const name = clean(r.procedure_name);
      return code === NONE ? { id: name, label: name } : { id: code, label: code, sub: name === NONE ? undefined : name };
    }
    case 'doctor': { const k = doctorKey(clean(r.doctor_name) === NONE ? '' : r.doctor_name); return { id: k || NONE, label: k ? doctorLabel(r.doctor_name) : NONE }; }
    case 'centre': return { id: r.centre_id, label: clean(r.centre_name) };
    case 'payer': return { id: r.payer_id ?? r.payer_name, label: r.payer_name };
  }
}

export interface GroupRow { id: string; label: string; sub?: string; cases: number; amount: number; share: number; preventable: number }

/** Lines → one row per group, largest first. `cases` counts lines; `share` is of the total given. */
export function groupLines(lines: DeductionLine[], by: GroupKey): GroupRow[] {
  const m = new Map<string, GroupRow>();
  let total = 0;
  for (const r of lines) {
    const g = groupOf(r, by);
    const v = m.get(g.id) ?? { id: g.id, label: g.label, sub: g.sub, cases: 0, amount: 0, share: 0, preventable: 0 };
    v.cases += 1; v.amount += r.amount; if (r.is_preventable) v.preventable += r.amount;
    if (!v.sub && g.sub) v.sub = g.sub;
    m.set(g.id, v); total += r.amount;
  }
  return [...m.values()].map((v) => ({ ...v, share: total > 0 ? v.amount / total : 0 }))
    .sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label));
}

/** Lines dated on or after the first day of the month `months − 1` months back. */
export function inPeriod(lines: DeductionLine[], months: number, now = new Date()): DeductionLine[] {
  const from = new Date(now.getFullYear(), now.getMonth() - months + 1, 1);
  const k = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-01`;
  return lines.filter((r) => r.on_date >= k);
}

/** Deductions on files from 1 Nov 2026 that still have no reason: the desk's list to complete. */
export function reasonPending(lines: DeductionLine[]): DeductionLine[] {
  return lines.filter((r) => r.category === 'unspecified' && r.kind !== 'fighting' && !!r.file_date && r.file_date >= CURRENT_FROM
    && (!!r.adjustment_id || !!r.claim_id));
}

const esc = (v: unknown) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
// a long digit string (16-digit PMJAY case ID) would lose digits in Excel: keep it as text
const text = (v: string | null) => (v && /^\d{12,}$/.test(v) ? `="${v}"` : v ?? '');

/** Every line, for Excel. */
export function linesCsv(lines: DeductionLine[]): string {
  const head = ['Date', 'Centre', 'Payer', 'Patient', 'Claim no. / PMJAY case ID', 'Consultant', 'Speciality', 'Procedure code', 'Procedure',
    'Reason', 'Remarks', 'Status', 'Preventable', 'Amount'];
  const rows = lines.map((r) => [r.on_date, r.centre_name, r.payer_name, r.patient_name ?? '', text(r.claim_ref), clean(r.doctor_name), clean(r.speciality),
    clean(r.procedure_code), clean(r.procedure_name), reasonLabel(r.category), r.reason_text ?? '', r.kind === 'fighting' ? 'Disputed' : r.kind === 'rejection' ? 'Rejected' : 'Deducted',
    r.is_preventable ? 'Yes' : 'No', Math.round(r.amount * 100) / 100]);
  return [head, ...rows].map((r) => r.map(esc).join(',')).join('\n');
}
