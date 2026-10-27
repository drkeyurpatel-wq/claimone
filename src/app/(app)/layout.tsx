import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth/session';
import { AppShell } from '@/components/AppShell';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  if (session.role === 'bot') redirect('/login'); // the bot account has no screens
  return <AppShell session={session}>{children}</AppShell>;
}
