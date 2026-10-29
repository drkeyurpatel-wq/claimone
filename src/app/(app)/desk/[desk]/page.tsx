// The old desk pages now open the ledger.
import { redirect } from 'next/navigation';

export default async function DeskRedirect({ params }: { params: Promise<{ desk: string }> }) {
  const { desk } = await params;
  redirect(desk === 'claims' ? '/ledger?show=mine' : '/ledger');
}
