import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';

// Desk staff start on their desk; managers on the overview.
const START = { admission: '/desk/admission', claims: '/desk/claims', payments: '/pay' } as const;
export default async function Home() {
  const s = await getSession();
  if (!s) redirect('/login');
  redirect(s.role === 'desk' ? START[s.workspace ?? 'payments'] : '/overview');
}
