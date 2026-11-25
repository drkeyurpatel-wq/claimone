/**
 * WhatsApp assistant: reads what a staff member typed and writes the answer.
 * Pure — the webhook route does the reading and writing.
 *
 *   status <IP no / claim no / name>  → where the file stands and what is due
 *   due                                → the files that are high priority now
 *   month                              → active / approved / need attention
 *   close <IP no / claim no>           → asks to confirm, then "yes" closes a settled file
 */
import type { Step } from '@/lib/rcm/worklist';
import { dueText, STATUS_WORDS } from '@/lib/rcm/worklist';
import type { ClaimStatus } from '@/lib/claims/types';

export type Command =
  | { kind: 'status'; ref: string } | { kind: 'close'; ref: string }
  | { kind: 'due' } | { kind: 'month' } | { kind: 'yes' } | { kind: 'no' } | { kind: 'help' };

export function parseCommand(raw: string): Command | null {
  const t = raw.trim().replace(/\s+/g, ' ');
  if (/^(yes|y|ha+n?|haa|confirm|ok(ay)?)$/i.test(t)) return { kind: 'yes' };
  if (/^(no|n|na+|cancel|nahi)$/i.test(t)) return { kind: 'no' };
  if (/^(help|hi|hello|menu|\?)$/i.test(t)) return { kind: 'help' };
  if (/^(due|pending|urgent|high|today)\b/i.test(t)) return { kind: 'due' };
  if (/^(month|summary|how are we doing)/i.test(t)) return { kind: 'month' };
  let m = t.match(/^(?:status|where|check|find)\s*(?:of|is)?\s+(.+)$/i);
  if (m) return { kind: 'status', ref: m[1].trim() };
  m = t.match(/^close\s+(.+)$/i);
  if (m) return { kind: 'close', ref: m[1].trim() };
  // a bare reference (IP no., claim no.) is a status question
  if (/^[A-Z0-9/-]{4,}$/i.test(t) && /\d/.test(t)) return { kind: 'status', ref: t };
  return null;
}

export const HELP = [
  'ClaimOne assistant. Send:',
  '• *status* IP no. / claim no. / patient name',
  '• *due* — files to act on now',
  '• *month* — this month at a glance',
  '• *close* IP no. — close a settled file',
  'Send photos or PDFs of papers with the IP no. in the caption — they go straight onto the file.',
].join('\n');

export const PATIENT_HELP = 'Thank you. Please send photos or PDFs of your papers with your IP number (from the admission slip) in the caption. They will reach the hospital insurance desk directly.';

const rs = (n?: number | null) => (n == null ? '' : `₹${Math.round(Number(n)).toLocaleString('en-IN')}`);

export interface FileLite {
  patient_name: string; claim_number: string; admission_ref: string | null; tpa_claim_number: string | null;
  status: ClaimStatus; approved_amount: number | null; settled_amount: number | null; payer: string | null;
}

export function statusLine(c: FileLite, s: Step, now = new Date()): string {
  const due = dueText(s, now);
  const ref = c.admission_ref ?? c.claim_number;
  const money = c.approved_amount ? ` · approved ${rs(c.approved_amount)}` : '';
  return `*${c.patient_name}* (${ref}${c.payer ? `, ${c.payer}` : ''})\n${STATUS_WORDS[c.status]}${money}\nNext: ${s.label}${due ? ` — ${due}` : ''}`;
}

export function closeQuestion(c: FileLite): string {
  return `*${c.patient_name}* (${c.admission_ref ?? c.claim_number}) is settled${c.settled_amount ? ` — ${rs(c.settled_amount)} received` : ''}. Close the file? Reply *yes* or *no*.`;
}

/** A settled file with nothing left to decide may be closed from WhatsApp; anything else is done on ClaimOne. */
export function closeRefusal(status: ClaimStatus): string | null {
  if (status === 'settled') return null;
  if (status === 'closed') return 'This file is already closed.';
  return `This file is "${STATUS_WORDS[status]}" — only a settled file can be closed here. Open it on ClaimOne.`;
}

/** Strip a WhatsApp number to the 10-digit mobile staff sign in with. */
export const mobile10 = (from: string) => from.replace(/\D/g, '').slice(-10);
