// Which stories show, and which /insights filter buttons appear.
import { describe, it, expect } from 'vitest';
import { showStory, storyRules, storyFilters } from '../src/story-filter';

describe('showStory', () => {
  const prod = storyRules({}, false);
  const hide = storyRules({ HIDE_SAMPLE_STORIES: 'true' }, false);
  it('shows sample stories by default', () => {
    expect(showStory({ draft: false, sample: true }, prod)).toBe(true);
  });
  it('hides sample stories on production builds when HIDE_SAMPLE_STORIES=true', () => {
    expect(showStory({ draft: false, sample: true }, hide)).toBe(false);
    expect(showStory({ draft: false, sample: false }, hide)).toBe(true);
    expect(storyRules({ HIDE_SAMPLE_STORIES: ' TRUE ' }, false).hideSamples).toBe(true);
    expect(storyRules({ HIDE_SAMPLE_STORIES: 'false' }, false).hideSamples).toBe(false);
  });
  it('hides drafts on production builds; astro dev shows everything', () => {
    expect(showStory({ draft: true, sample: false }, prod)).toBe(false);
    expect(showStory({ draft: true, sample: true }, storyRules({ HIDE_SAMPLE_STORIES: 'true' }, true))).toBe(true);
  });
});

describe('storyFilters', () => {
  const industries = [{ id: 'life-sciences', name: 'Life Sciences' }, { id: 'data-centers', name: 'Data Centers & AI' }, { id: 'enterprise-technology', name: 'Enterprise Technology' }];
  it('lists only industries with stories, in menu order, then Company News', () => {
    expect(storyFilters(industries, [{ industry: 'enterprise-technology' }, {}, { industry: 'life-sciences' }]).map((f) => f.id))
      .toEqual(['life-sciences', 'enterprise-technology', 'company']);
  });
  it('leaves out Company News when there is none', () => {
    expect(storyFilters(industries, [{ industry: 'data-centers' }]).map((f) => f.id)).toEqual(['data-centers']);
  });
  it('is empty with no stories', () => {
    expect(storyFilters(industries, [])).toEqual([]);
  });
});
