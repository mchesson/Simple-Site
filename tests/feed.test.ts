// Stories from TS Workspace (src/feed.ts): only well-formed stories are kept,
// everything is escaped, an insight always links to its original, and a
// missing or broken feed never breaks the build. TS Workspace is a fake fetch.
import { describe, it, expect } from 'vitest';
import { fetchFeed, storyData, storyHtml, type FeedStory } from '../src/feed';

const insight: FeedStory = {
  slug: 'meta-adds-two-buildings-to-its-louisiana-ai-campus',
  title: 'Meta Adds Two Buildings to Its Louisiana AI Campus',
  date: '2026-10-05',
  industry: 'data-centers',
  type: 'insight',
  summary: 'Meta filed plans for two more buildings at its Richland Parish campus.',
  body: 'AI campuses keep growing in phases.\n\nEach phase brings new commissioning work.',
  source: { name: 'Data Center Dynamics', url: 'https://www.datacenterdynamics.com/en/news/meta' },
  linkedin: 'Two more buildings for an AI campus. #DataCenters',
};
const news: FeedStory = { ...insight, slug: 'food-bank-day', title: 'Our Team at the Food Bank', type: 'company-news', industry: null, source: null };

const fakeFetch = (body: unknown, status = 200) => {
  const seen: URL[] = [];
  const f = (async (u: URL) => { seen.push(new URL(String(u))); return new Response(JSON.stringify(body), { status }); }) as unknown as typeof fetch;
  return { f, seen };
};

describe('reading the feed', () => {
  it('keeps good stories and skips bad ones one by one', async () => {
    const { f, seen } = fakeFetch({ version: 1, stories: [
      insight, news,
      { ...insight, slug: 'Bad Slug!' },
      { ...insight, slug: 'no-source', source: null },
      { ...insight, slug: 'js-source', source: { name: 'x', url: 'javascript:alert(1)' } },
      { ...insight }, // repeated slug
      'nonsense',
    ] });
    const r = await fetchFeed('https://ats.test/api/public/stories', f);
    expect(r?.stories.map((s) => s.slug)).toEqual([insight.slug, 'food-bank-day']);
    expect(r?.skipped).toBe(5);
    expect(seen[0]!.searchParams.get('v')).toMatch(/^\d+$/); // past the edge cache
  });

  it('returns null (keep what we had) when TS Workspace is down or answers nonsense', async () => {
    expect(await fetchFeed('https://ats.test/x', fakeFetch({}, 503).f)).toBeNull();
    expect(await fetchFeed('https://ats.test/x', fakeFetch({ nope: true }).f)).toBeNull();
    expect(await fetchFeed('https://ats.test/x', (async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toBeNull();
    expect(await fetchFeed('not a url', fakeFetch({ stories: [] }).f)).toBeNull();
  });
});

describe('showing a story', () => {
  it('is our text with a clear link to the original, all escaped', () => {
    const html = storyHtml({ ...insight, body: 'First <script>alert(1)</script>\n\nSecond & last' });
    expect(html).toContain('<p>First &lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(html).toContain('<p>Second &amp; last</p>');
    expect(html).toContain('Read the original at <a href="https://www.datacenterdynamics.com/en/news/meta" target="_blank" rel="noopener nofollow">Data Center Dynamics</a>');
    expect(html).not.toContain('<script>');
  });

  it('company news has no source link and no industry', () => {
    expect(storyHtml(news)).not.toContain('Read the original');
    const d = storyData(news);
    expect(d).not.toHaveProperty('industry');
    expect(d).not.toHaveProperty('source');
    expect(storyData(insight)).toMatchObject({ industry: 'data-centers', type: 'insight', source: insight.source });
  });
});
