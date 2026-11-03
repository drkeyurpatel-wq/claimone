'use client';
// One "Payments" area: the four screens that bring money in and match it to bills.
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export const PAYMENT_TABS = [
  { href: '/pay', label: '1. Upload settlements' },
  { href: '/pay/check', label: '2. Review settlements' },
  { href: '/receivables/import', label: '3. Upload bank statement' },
  { href: '/receivables/reconcile', label: '4. Bank matching' },
] as const;

export function PaymentTabs({ className = '' }: { className?: string }) {
  const path = usePathname();
  return (
    <nav aria-label="Payments" className={`flex gap-1 overflow-x-auto border-b border-slate-200 print:hidden ${className}`}>
      {PAYMENT_TABS.map((t) => {
        const on = path === t.href;
        return (
          <Link key={t.href} href={t.href}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-semibold ${
              on ? 'border-teal-600 text-teal-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
