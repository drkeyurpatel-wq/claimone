import { redirect } from 'next/navigation';

// Old address: the sheet is now called Master.
export default async function LedgerRedirect({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const { show } = await searchParams;
  redirect(show ? `/master?show=${encodeURIComponent(show)}` : '/master');
}
