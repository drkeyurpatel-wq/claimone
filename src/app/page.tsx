import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';

// Desk staff start on Upload payments; managers on the claims desk.
export default async function Home() {
  const s = await getSession();
  redirect(s?.role === 'desk' ? '/pay' : '/claims');
}
