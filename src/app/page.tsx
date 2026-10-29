import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';

// Everyone starts on the ledger.
export default async function Home() {
  const s = await getSession();
  if (!s) redirect('/login');
  redirect('/master');
}
