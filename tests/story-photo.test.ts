// Photos appear only on Insights stories: a story's own image wins, otherwise
// one is picked from its industry's pool, the same one every build.
import { describe, it, expect } from 'vitest';
import { storyPhoto, storyPhotoPools, assignStoryPhotos } from '../src/story-photo';
import { photos } from '../src/data/photo-credits';

describe('storyPhoto', () => {
  it('uses the story’s own photo when it names one from the library', () => {
    expect(storyPhoto({ id: 'x', image: 'process-tanks', industry: 'data-centers' })).toBe('process-tanks');
  });
  it('ignores an image that is not in the library and picks by industry', () => {
    expect(storyPhotoPools['data-centers']).toContain(storyPhoto({ id: 'x', image: 'https://example.com/a.jpg', industry: 'data-centers' }));
  });
  it('picks from the industry pool, the same photo every time', () => {
    for (const industry of ['life-sciences', 'data-centers', 'enterprise-technology']) {
      const a = storyPhoto({ id: 'meta-adds-two-buildings', industry });
      expect(storyPhotoPools[industry]).toContain(a);
      expect(storyPhoto({ id: 'meta-adds-two-buildings', industry })).toBe(a);
    }
  });
  it('gives company news (and unknown industries) the team photos', () => {
    expect(storyPhotoPools.company).toContain(storyPhoto({ id: 'we-moved-offices' }));
    expect(storyPhotoPools.company).toContain(storyPhoto({ id: 'we-moved-offices', industry: 'shipbuilding' }));
  });
  it('spreads different stories across the pool', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `story-${i}`);
    expect(new Set(ids.map((id) => storyPhoto({ id, industry: 'data-centers' }))).size).toBe(storyPhotoPools['data-centers'].length);
  });
  it('only uses photos that are in the library', () => {
    for (const id of Object.values(storyPhotoPools).flat()) expect(Object.hasOwn(photos, id)).toBe(true);
  });
});

describe('assignStoryPhotos', () => {
  const list = [
    { id: 'a', industry: 'data-centers' }, { id: 'b', industry: 'data-centers' }, { id: 'c', industry: 'life-sciences' },
    { id: 'd', industry: 'life-sciences' }, { id: 'e', industry: 'data-centers' }, { id: 'f' }, { id: 'g2', image: 'team-working-session' }, { id: 'g' },
    { id: 'h', image: 'capsule-filling', industry: 'life-sciences' }, { id: 'i', industry: 'life-sciences' },
  ];
  const got = assignStoryPhotos(list);
  it('never repeats the photo of the card next to it, overall or within an industry', () => {
    const photosIn = (ids: string[]) => ids.map((id) => got.get(id));
    const noRepeat = (xs: unknown[]) => xs.every((x, i) => i === 0 || x !== xs[i - 1]);
    expect(noRepeat(photosIn(list.map((s) => s.id)))).toBe(true);
    for (const ind of ['data-centers', 'life-sciences', undefined]) {
      expect(noRepeat(photosIn(list.filter((s) => s.industry === ind).map((s) => s.id)))).toBe(true);
    }
  });
  it('keeps each story in its pool and its own photo when it has one', () => {
    expect(got.get('h')).toBe('capsule-filling');
    for (const s of list) if (!s.image) expect(storyPhotoPools[s.industry ?? 'company']).toContain(got.get(s.id));
  });
  it('is the same every build', () => {
    expect([...assignStoryPhotos(list)]).toEqual([...got]);
  });
});
