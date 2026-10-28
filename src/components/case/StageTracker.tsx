'use client';
// The file's journey as a row of stages. Big: tappable tabs on the case
// screen. Small: dots in the patient list.
import { useEffect, useRef } from 'react';
import { Check } from 'lucide-react';
import { STAGES, type StageKey } from '@/lib/rcm/journey';

type State = 'done' | 'current' | 'todo' | 'skipped';

export function StageDots({ states, late }: { states: Record<StageKey, State>; late?: boolean }) {
  return (
    <span className="flex items-center gap-1" aria-hidden>
      {STAGES.map((s) => {
        const st = states[s.key];
        return <span key={s.key} className={`h-2 w-5 rounded-full ${st === 'done' ? 'bg-teal-500' : st === 'current' ? (late ? 'bg-rose-500' : 'bg-amber-400') : st === 'skipped' ? 'bg-slate-100' : 'bg-slate-200'}`} />;
      })}
    </span>
  );
}

export function StageTracker({ states, selected, onSelect, late }: {
  states: Record<StageKey, State>; selected: StageKey; onSelect: (k: StageKey) => void; late?: boolean;
}) {
  const current = useRef<HTMLLIElement>(null);
  // on a phone the row scrolls: bring the file's current stage into view
  useEffect(() => { current.current?.scrollIntoView({ block: 'nearest', inline: 'center' }); }, []);
  return (
    <nav aria-label="File journey" className="overflow-x-auto">
      <ol className="flex min-w-max gap-1 md:grid md:min-w-0 md:grid-cols-6">
        {STAGES.map((s, i) => {
          const st = states[s.key];
          const isSel = s.key === selected;
          const circle = st === 'done' ? 'bg-teal-600 text-white' : st === 'current' ? (late ? 'bg-rose-600 text-white' : 'bg-amber-500 text-white')
            : st === 'skipped' ? 'bg-slate-100 text-slate-300' : 'bg-white text-slate-400 ring-1 ring-slate-300';
          return (
            <li key={s.key} ref={st === 'current' ? current : undefined}>
              <button onClick={() => onSelect(s.key)} aria-current={st === 'current' ? 'step' : undefined}
                className={`flex min-h-14 w-full items-center gap-2 rounded-xl px-3 text-left transition ${isSel ? 'bg-white shadow-sm ring-2 ring-teal-500' : 'hover:bg-white'}`}>
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-bold ${circle}`}>
                  {st === 'done' ? <Check className="h-4 w-4" /> : i + 1}
                </span>
                <span className={`text-sm font-semibold leading-tight ${st === 'todo' || st === 'skipped' ? 'text-slate-400' : 'text-slate-800'}`}>
                  {s.label}{st === 'skipped' && <span className="block text-xs font-normal">not needed</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
