// Bank money is matched automatically on upload; what is left is in Payments → To check.
import { redirect } from 'next/navigation';

export default function Moved() {
  redirect('/pay/check');
}
