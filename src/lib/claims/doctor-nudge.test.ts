import { describe, expect, it } from 'vitest';
import { nudgePoints, nudgeText, waLink } from './doctor-nudge';

const base = { patient_name: 'M. Verma', admission_ref: 'IP77', treating_doctor_name: 'Dr. Shah', claim_type: 'cashless' };

describe('doctor nudge', () => {
  it('asks for the operation note and implant details on surgical cases', () => {
    const p = nudgePoints({ ...base, procedure_name: 'Total knee replacement' });
    expect(p.join(' ')).toContain('operation note');
    expect(p.join(' ')).toContain('Implants');
  });
  it('asks for MLC on injuries and leaves it out otherwise', () => {
    expect(nudgePoints({ ...base, primary_diagnosis: 'Fracture shaft femur' }).join(' ')).toContain('MLC');
    expect(nudgePoints({ ...base, primary_diagnosis: 'Dengue fever' }).join(' ')).not.toContain('MLC');
  });
  it('addresses the doctor once and builds a wa.me link', () => {
    expect(nudgeText(base)).toMatch(/^Dr Shah, for M. Verma \(IP IP77\):/);
    expect(waLink('hi', '98765 43210')).toBe('https://wa.me/919876543210?text=hi');
  });
});
