'use client';
// Reports → Deductions.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import { sb } from '@/lib/supabase/browser';
import { fetchDeductionLines } from '@/lib/claims/api';
import type { DeductionLine } from '@/lib/claims/types';
import { disputesByMonth, type DisputeCase } from '@/lib/rcm/summary';
import { NoCentre } from '@/components/ui';
import { isOldDate } from '@/lib/rcm/ledger';
import { DeductionsView } from '@/components/report/DeductionsView';

export default function Deductions() {
  const centreId = useAuthStore((s) => s.activeCentreId);
  const role = useAuthStore((s) => s.staff?.role);
  const canWrite = role === 'admin' || role === 'manager' || role === 'desk';
  const [lines, setLines] = useState<DeductionLine[] | null>(null);
  const [cases, setCases] = useState<DisputeCase[]>([]);
  const [months, setMonths] = useState(6);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!centreId) return;
    try {
      const [l, d] = await Promise.all([
        fetchDeductionLines(),
        sb().from('clm_claims').select('cut_decision, cut_decided_at, status, claimed_amount, approved_amount, deduction_amount, discharge_date')
          .eq('centre_id', centreId).not('cut_decision', 'is', null).limit(20000),
      ]);
      // files discharged on or after 1 Nov only; earlier ones are under Before 1 Nov
      setLines(l.filter((x) => !!x.file_date && !isOldDate(x.file_date)));
      setCases(((d.data ?? []) as (DisputeCase & { discharge_date: string | null })[]).filter((c) => !isOldDate(c.discharge_date))); setError('');
    } catch { setError('Could not load deductions. Please check the connection and refresh.'); }
  }, [centreId]);
  useEffect(() => { setLines(null); load(); }, [load]);
  const disputes = useMemo(() => disputesByMonth(cases, 6), [cases]);

  if (!centreId) return <NoCentre />;
  if (error) return <p role="alert" className="m-6 rounded-xl border border-rose-200 bg-rose-50 p-4 text-base text-rose-800">{error}</p>;
  if (!lines) return <div className="flex min-h-[60vh] items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-teal-600" /></div>;
  return <DeductionsView lines={lines} centreId={centreId} months={months} setMonths={setMonths} disputes={disputes} canWrite={canWrite} onChanged={load} />;
}
