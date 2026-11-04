'use client';
// Under a PMJAY package-code box: the package name and its NABH / non-NABH amount from HBP 2022.
import { useEffect, useMemo, useState } from 'react';
import { loadPackages, packageAmount, type PackageAmount, type PackageMaster } from '@/lib/rcm/hbp';

const rs = (n: number) => `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/** The amount for the typed code(s); null while nothing is typed or the master is loading. */
export function usePackageAmount(codes: string): PackageAmount | null {
  const [master, setMaster] = useState<PackageMaster | null>(null);
  const typed = codes.trim().length > 0;
  useEffect(() => { if (typed && !master) loadPackages().then(setMaster).catch(() => {}); }, [typed, master]);
  return useMemo(() => (master && typed ? packageAmount(codes, master) : null), [master, typed, codes]);
}

/** Fields to save with the case when the code(s) price cleanly. */
export function packageFields(a: PackageAmount | null) {
  return a && a.nabh != null ? { package_name: a.name.slice(0, 300), package_amount: a.nabh, non_nabh_amount: a.nonNabh } : {};
}

export function PackageHint({ amount }: { amount: PackageAmount | null }) {
  if (!amount || !amount.codes.length) return null;
  const { parts, unknown, perDay, implantToCheck, nabh, nonNabh } = amount;
  return (
    <div className="mt-1 space-y-0.5 text-sm font-normal">
      {parts.map((p) => (
        <p key={p.code} className="text-slate-700"><b>{p.code}</b> · {p.name}{p.share < 1 ? ` · ${p.share * 100}% (second package)` : ''}</p>
      ))}
      {nabh != null && nonNabh != null && (
        <p className="font-semibold text-teal-800">NABH {rs(nabh)} · non-NABH {rs(nonNabh)}{parts.some((p) => p.implant) ? ' (incl. implant)' : ''}</p>
      )}
      {perDay.map((p) => <p key={p.code} className="text-amber-800"><b>{p.code}</b> · {p.name} — per-day rate, enter the amount by hand</p>)}
      {implantToCheck.length > 0 && <p className="text-amber-800">Implant for {implantToCheck.join(', ')} has several prices — add it to the amount by hand.</p>}
      {unknown.length > 0 && <p className="text-rose-700">{unknown.join(', ')} not in the HBP 2022 list — check the code.</p>}
    </div>
  );
}
