// Bank statements are uploaded in Payments → Upload, with every other money file.
import { redirect } from 'next/navigation';

export default function Moved() {
  redirect('/pay');
}
