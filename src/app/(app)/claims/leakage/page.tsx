'use client';
// Reports → Deductions.
import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import { sb } from '@/lib/supabase/browser';
import { fetchLeakage } from '@/lib/claims/api';
import type { LeakageRow } from '@/lib/claims/types';
import { disputesByMonth, type DisputeCase } from '@/lib/rcm/summary';
import { NoCentre } from '@/components/ui';
import { DeductionsView } from '@/components/report/DeductionsView';

export default function Deductions() {
  const centreId = useAuthStore((s) => s.activeCentreId);
  const [rows, setRows] = useState<LeakageRow[] | null>(null);
  const [cases, setCases] = useState<DisputeCase[]>([]);
  const [months, setMonths] = useState(6);

  useEffect(() => {
    if (!centreId) return;
    setRows(null);
    Promise.all([
      fetchLeakage(centreId),
      sb().from('clm_claims').select('cut_decision, cut_decided_at, status, claimed_amount, approved_amount, deduction_amount')
        .eq('centre_id', centreId).not('cut_decision', 'is', null).limit(20000),
    ]).then(([l, d]) => { setRows(l); setCases((d.data ?? []) as DisputeCase[]); });
  }, [centreId]);
  const disputes = useMemo(() => disputesByMonth(cases, 6), [cases]);

  if (!centreId) return <NoCentre />;
  if (!rows) return <div className="flex min-h-[60vh] items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-teal-600" /></div>;
  return <DeductionsView rows={rows} months={months} setMonths={setMonths} disputes={disputes} />;
}
