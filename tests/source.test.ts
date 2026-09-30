// "How they found us": the wording the team sees in emails and Crelate notes.
import { describe, it, expect } from 'vitest';
import { describeSource } from '../src/source';

const t = (x: object) => ({ ref: '', utm: {}, ad: '', landing: '/', at: '2026-09-28', ...x });

describe('describeSource', () => {
  it('names well-known sites and keeps the landing page', () => {
    const lines = describeSource({ first: t({ ref: 'www.linkedin.com', landing: '/industries/life-sciences' }), visit: t({ ref: 'www.linkedin.com', landing: '/industries/life-sciences' }), pages: 3, industry: 'life-sciences' });
    expect(lines).toEqual([
      'How they found us: LinkedIn (first visit 2026-09-28, landed on /industries/life-sciences)',
      'Pages viewed this visit: 3',
      'Industry of interest: life-sciences',
    ]);
  });
  it('prefers campaign tags, and shows a later visit separately', () => {
    const lines = describeSource({
      first: t({ utm: { source: 'linkedin', medium: 'social', campaign: 'pharma-q4' }, landing: '/' }),
      visit: t({ ref: 'www.google.com', landing: '/careers', at: '2026-09-30' }),
      pages: 1,
    });
    expect(lines[0]).toBe('How they found us: LinkedIn (social), campaign "pharma-q4" (first visit 2026-09-28, landed on /)');
    expect(lines[1]).toBe('This visit: Google search (landed on /careers, 1 page viewed)');
  });
  it('says Direct when there is no referrer, and names ad clicks', () => {
    expect(describeSource({ first: t({}) })[0]).toMatch(/^How they found us: Direct/);
    expect(describeSource({ first: t({ ad: 'Google Ads' }) })[0]).toMatch(/^How they found us: Google Ads/);
  });
  it('ignores junk and never trusts the browser blindly', () => {
    expect(describeSource('not json')).toEqual([]);
    expect(describeSource(null)).toEqual([]);
    const lines = describeSource({ first: t({ ref: 'x'.repeat(5000), landing: 'javascript:alert(1)', at: 'yesterday' }), industry: '<b>x</b>' });
    expect(lines[0].length).toBeLessThan(260);
    expect(lines.join(' ')).not.toContain('javascript:');
    expect(lines.join(' ')).not.toContain('<b>');
  });
});
