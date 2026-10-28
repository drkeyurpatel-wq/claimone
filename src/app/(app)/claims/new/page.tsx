// New patients are added on the patient-journey form.
import { redirect } from 'next/navigation';

export default function NewClaimRedirect() {
  redirect('/cases/new');
}
