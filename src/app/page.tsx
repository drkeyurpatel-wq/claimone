import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';

// Desk staff start on Patients (their stage tab); managers on the overview.
export default async function Home() {
  const s = await getSession();
  if (!s) redirect('/login');
  redirect(s.role === 'desk' ? '/patients' : '/overview');
}
