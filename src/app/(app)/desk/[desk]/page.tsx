// The old desk pages now live on Patients, one tab per stage of the file.
import { redirect } from 'next/navigation';

export default async function DeskRedirect({ params }: { params: Promise<{ desk: string }> }) {
  const { desk } = await params;
  redirect(desk === 'claims' ? '/patients?stage=discharge' : '/patients?stage=preauth');
}
