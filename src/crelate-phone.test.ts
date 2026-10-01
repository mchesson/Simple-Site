import { describe, expect, it } from 'vitest';
import { crelatePhone } from './crelate';

describe('crelatePhone', () => {
  it('formats US numbers the way Crelate accepts', () => {
    expect(crelatePhone('(919) 795-8948')).toBe('+19197958948');
    expect(crelatePhone('919.795.8948')).toBe('+19197958948');
    expect(crelatePhone('+1 919 795 8948')).toBe('+19197958948');
  });
  it('leaves out numbers Crelate would refuse, so the application still goes through', () => {
    expect(crelatePhone('91999999999')).toBeUndefined();
    expect(crelatePhone('12345')).toBeUndefined();
    expect(crelatePhone('')).toBeUndefined();
    expect(crelatePhone(undefined)).toBeUndefined();
  });
});
