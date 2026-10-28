import { redirect } from 'next/navigation';
// The weekly page became two staff screens: /pay (upload) and /pay/check.
export default function Weekly() { redirect('/pay'); }
