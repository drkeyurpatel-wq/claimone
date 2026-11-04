import { describe, expect, it } from 'vitest';
import master from './hbp2022.json';
import { packageAmount, splitCodes, type PackageMaster } from './hbp';

const M = master as unknown as PackageMaster;

describe('HBP 2022 package amounts match the Nov 2026 PMJAY sheet', () => {
  it('PTCA: stent added without the NABH uplift', () => {
    expect(packageAmount('MC011A', M)).toMatchObject({ nonNabh: 86634, nabh: 91714 });
  });
  it('single packages', () => {
    expect(packageAmount('MC030GJA', M)).toMatchObject({ nonNabh: 4025, nabh: 4427.5 });
    expect(packageAmount('MO029B', M)).toMatchObject({ nonNabh: 29700, nabh: 32670 });
    expect(packageAmount('MO090GJA', M)).toMatchObject({ nonNabh: 7130, nabh: 7843 });
    expect(packageAmount('MO084GJA', M)).toMatchObject({ nonNabh: 10000, nabh: 11000 });
    // the sheet had 14,300 / 15,730 the wrong way round
    expect(packageAmount('MO028I', M)).toMatchObject({ nonNabh: 14300, nabh: 15730 });
  });
  it('dual package: the costlier code in full, the other at half', () => {
    const r = packageAmount('SC004A, SC068A', M);
    expect(r).toMatchObject({ nonNabh: 92600, nabh: 101860 });
    expect(r.parts.map((p) => [p.code, p.share])).toEqual([['SC068A', 1], ['SC004A', 0.5]]);
  });
  it('unknown and per-day codes are reported, not priced', () => {
    expect(packageAmount('ZZ999Z', M)).toMatchObject({ unknown: ['ZZ999Z'], nabh: null });
    const d = packageAmount('MG001A', M);
    expect(d.perDay[0].code).toBe('MG001A');
    expect(d.nabh).toBeNull();
  });
  it('splits typed codes', () => {
    expect(splitCodes('sc004a + SC068A')).toEqual(['SC004A', 'SC068A']);
    expect(splitCodes(null)).toEqual([]);
  });
});
