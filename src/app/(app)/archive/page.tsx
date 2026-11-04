'use client';
// Settled and closed files: paid in full, or paid with the cut accepted. A disputed file stays on Master.
import { Suspense } from 'react';
import { LedgerScreen } from '@/components/ledger/LedgerScreen';

export default function ArchivePage() {
  return <Suspense fallback={null}><LedgerScreen archive /></Suspense>;
}
