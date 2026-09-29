import { describe, it, expect } from 'vitest';
import { resolveLocation, jobPoint, miles } from '../src/geo';

describe('location search', () => {
  it('understands ZIP codes and "City, ST"', () => {
    expect(resolveLocation('27601')).not.toBeNull();
    expect(resolveLocation('Durham, NC')).not.toBeNull();
    expect(resolveLocation('nowhere at all')).toBeNull();
  });
  it('measures distance in miles', () => {
    const raleigh = resolveLocation('27601')!;
    const durham = jobPoint('', 'Durham', 'NC')!;
    const d = miles(raleigh, durham);
    expect(d).toBeGreaterThan(15);
    expect(d).toBeLessThan(35);
  });
});
