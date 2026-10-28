'use client';
// Check list — staff screen 2 of 2.
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Upload } from 'lucide-react';
import { useAuthStore } from '@/lib/store/auth';
import { fetchExceptions, type ExceptionRow } from '@/lib/recon/api';
import { CheckList } from '@/components/pay/CheckList';
import { NoCentre, useToast } from '@/components/ui';

export default function CheckPage() {
  const centreId = useAuthStore((s) => s.activeCentreId);
  const role = useAuthStore((s) => s.staff?.role);
  const canWrite = role === 'admin' || role === 'manager' || role === 'desk';
  const { flash, toastNode } = useToast();
  const [rows, setRows] = useState<ExceptionRow[] | null>(null);
  const load = useCallback(async () => { if (centreId) setRows(await fetchExceptions(centreId)); }, [centreId]);
  useEffect(() => { load(); }, [load]);

  if (!centreId) return <NoCentre />;
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 md:px-6">
      {toastNode}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Payments to check</h1>
          <p className="mt-1 text-base text-slate-600">Only the bills where the money does not match. Fix them one group at a time.</p>
        </div>
        <Link href="/pay" className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-slate-100 px-4 text-base font-medium text-slate-700 hover:bg-slate-200">
          <Upload className="h-5 w-5" /> Upload payments
        </Link>
      </div>
      <div className="mt-6"><CheckList rows={rows} canWrite={canWrite} onChanged={load} flash={flash} /></div>
    </div>
  );
}
