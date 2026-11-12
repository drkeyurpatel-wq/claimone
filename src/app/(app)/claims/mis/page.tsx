'use client';
// Reports → Money owed.
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import { loadOwed } from '@/lib/rcm/reports';
import { fetchPayerScorecard } from '@/lib/claims/api';
import type { Ageing } from '@/lib/rcm/overview';
import type { PayerScorecard } from '@/lib/claims/types';
import { NoCentre } from '@/components/ui';
import { MoneyOwedView } from '@/components/report/MoneyOwedView';

export default function MoneyOwed() {
  const centreId = useAuthStore((s) => s.activeCentreId);
  const [d, setD] = useState<{ age: Ageing; score: Record<string, PayerScorecard> } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!centreId) return;
    setD(null); setError('');
    Promise.all([loadOwed(centreId), fetchPayerScorecard()])
      .then(([age, s]) => setD({ age, score: Object.fromEntries(s.map((x) => [x.payer_id, x])) }))
      .catch((e) => setError((e as Error).message));
  }, [centreId]);

  if (!centreId) return <NoCentre />;
  if (error) return <p role="alert" className="m-8 rounded-lg bg-rose-50 p-4 text-base text-rose-800">{error}</p>;
  if (!d) return <div className="flex min-h-[60vh] items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-teal-600" /></div>;
  return <MoneyOwedView age={d.age} score={d.score} />;
}
