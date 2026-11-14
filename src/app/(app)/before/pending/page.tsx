'use client';
// Before 1 Nov → Pending files: discharged before 1 Nov 2026 and not yet paid and closed.
import { Suspense } from 'react';
import { LedgerScreen } from '@/components/ledger/LedgerScreen';

export default function OldPendingPage() {
  return <Suspense fallback={null}><LedgerScreen old /></Suspense>;
}
