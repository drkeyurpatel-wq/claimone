/**
 * PMJAY package master (HBP 2022, Gujarat tender PS 11, 17-12-2025) → the amount for a case's package code(s).
 *
 * Checked against the Nov 2026 Shilaj PMJAY sheet:
 *   non-NABH = package rate (Tier 3) + implant cost
 *   NABH     = package rate × 1.10 + implant cost (the 10% NABH uplift is not paid on the implant)
 *   two codes (dual package): the costlier at 100%, the next at 50% (a third at 25%)
 * e.g. MC011A PTCA: 50,800 + 35,834 stent = 86,634 non-NABH · 55,880 + 35,834 = 91,714 NABH.
 * Per-day packages (ward / HDU / ICU) have no single rate and are reported as such.
 */
export interface Pkg {
  /** specialty */ s: string;
  /** package name */ n: string;
  /** procedure name */ p: string;
  /** package rate (Tier 3) */ r?: number;
  /** rate written as text (per-day packages) */ rt?: string;
  /** implant cost, when the master gives one figure */ i?: number;
  /** implant as written */ it?: string;
  /** day care */ dc?: 1;
}
export type PackageMaster = Record<string, Pkg>;

export const NABH_UPLIFT = 0.1;
const SHARES = [1, 0.5, 0.25];

let cache: Promise<PackageMaster> | null = null;
/** The master is ~370 KB: load it only where a code is typed or a sheet is checked. */
export function loadPackages(): Promise<PackageMaster> {
  cache ??= import('./hbp2022.json').then((m) => (m.default ?? m) as unknown as PackageMaster);
  return cache;
}

export const splitCodes = (codes: string | null | undefined) =>
  (codes ?? '').toUpperCase().split(/[\s,;+/&]+/).map((x) => x.replace(/[^A-Z0-9]/g, '')).filter(Boolean);

export interface PackageAmount {
  codes: string[];
  /** found in the master, costliest first, with the share paid */
  parts: { code: string; name: string; rate: number; share: number; implant: number }[];
  /** codes not in the master */
  unknown: string[];
  /** codes in the master without a single rate (per-day packages), with the rate text */
  perDay: { code: string; name: string; text: string }[];
  /** implant named in the master but its cost not a single figure: check by hand */
  implantToCheck: string[];
  nonNabh: number | null;
  nabh: number | null;
  name: string;
}

const round = (x: number) => Math.round(x * 100) / 100;

export function packageAmount(codesText: string | null | undefined, master: PackageMaster, uplift = NABH_UPLIFT): PackageAmount {
  const codes = [...new Set(splitCodes(codesText))];
  const unknown: string[] = [], perDay: PackageAmount['perDay'] = [], implantToCheck: string[] = [];
  const found: { code: string; name: string; rate: number; implant: number }[] = [];
  for (const code of codes) {
    const p = master[code];
    if (!p) { unknown.push(code); continue; }
    if (p.r == null) { perDay.push({ code, name: p.n, text: p.rt ?? 'No fixed rate' }); continue; }
    if (p.it && p.i == null) implantToCheck.push(code);
    found.push({ code, name: p.n, rate: p.r, implant: p.i ?? 0 });
  }
  found.sort((a, b) => b.rate - a.rate);
  const parts = found.map((f, k) => ({ ...f, share: SHARES[k] ?? SHARES[SHARES.length - 1] }));
  const base = parts.reduce((a, x) => a + x.rate * x.share, 0);
  const implant = parts.reduce((a, x) => a + x.implant, 0);
  const priced = parts.length > 0 && !unknown.length && !perDay.length;
  return {
    codes, parts, unknown, perDay, implantToCheck,
    nonNabh: priced ? round(base + implant) : null,
    nabh: priced ? round(base * (1 + uplift) + implant) : null,
    name: [...parts.map((x) => x.name), ...perDay.map((x) => x.name)].join(' + '),
  };
}
