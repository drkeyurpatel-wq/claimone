'use client';
// Before 1 Nov → Settled files: discharged before 1 Nov 2026, paid and closed.
import { Suspense } from 'react';
import { LedgerScreen } from '@/components/ledger/LedgerScreen';

export default function OldSettledPage() {
  return <Suspense fallback={null}><LedgerScreen archive old /></Suspense>;
}
