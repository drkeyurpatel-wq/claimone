'use client';
import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

export const field = 'mt-1 min-h-12 w-full rounded-lg border border-slate-300 bg-white px-3 text-base focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100';
export const label = 'block text-base font-medium text-slate-800';

/** A sheet from the bottom on a phone, a dialog on a desk. Esc or the backdrop closes it. */
export function Modal({ title, sub, onClose, children }: { title: string; sub?: string; onClose: () => void; children: React.ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const first = box.current?.querySelector<HTMLElement>('input:not([type=hidden]), select, textarea');
    first?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-slate-900/40 sm:items-center sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} role="dialog" aria-modal="true" aria-label={title}
        className="max-h-[92vh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl sm:max-w-lg sm:rounded-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-xl font-bold text-slate-900">{title}</h2>
            {sub && <p className="mt-0.5 truncate text-sm text-slate-500">{sub}</p>}
          </div>
          <button onClick={onClose} aria-label="Close" className="-mr-2 -mt-1 rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"><X className="h-6 w-6" /></button>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}
