'use client';
import { Suspense } from 'react';
import { LedgerScreen } from '@/components/ledger/LedgerScreen';

export default function MasterPage() {
  return <Suspense fallback={null}><LedgerScreen /></Suspense>;
}
