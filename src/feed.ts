// Approved stories from TS Workspace (Website Insights and Company News),
// merged with the Markdown stories everywhere stories appear. Read once per
// build by the `feedStories` collection (src/content.config.ts); TS Workspace
// triggers a rebuild (Vercel deploy hook) when something is approved, edited
// or taken down, so it shows within a few minutes. Format: the ATS repo's
// docs/website-intake.md, "Stories feed" (GET /api/public/stories).
//
// Setting (Vercel, TS Website): ATS_STORIES_URL
//   https://tsworkspace.com/api/public/stories
// Without it, or if TS Workspace is down or answers nonsense, the site builds
// with the Markdown stories only (and the last good feed when there was one):
// never an error.
//
// Feed text is plain text from TS Workspace; storyHtml escapes all of it, so
// nothing in the feed can add markup, scripts or links other than the
// "Read the original" link to the source (http/https only).
import { z } from 'zod';

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(90);
const httpUrl = z.string().max(2000).refine((u) => {
  try { return ['http:', 'https:'].includes(new URL(u).protocol); } catch { return false; }
});

export const feedStory = z.object({
  slug,
  title: z.string().trim().min(3).max(140),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  industry: z.string().regex(/^[a-z0-9-]+$/).max(60).nullable(),
  type: z.enum(['insight', 'company-news']),
  summary: z.string().trim().min(10).max(600),
  body: z.string().trim().min(10).max(6000),
  source: z.object({ name: z.string().trim().min(1).max(100), url: httpUrl }).nullable(),
  linkedin: z.string().trim().max(2000).default(''),
});
export type FeedStory = z.infer<typeof feedStory>;

/** Reads and checks the feed. Bad stories are skipped one by one; anything else wrong returns null (keep what we had). */
export async function fetchFeed(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): Promise<{ stories: FeedStory[]; skipped: number } | null> {
  try {
    const u = new URL(url);
    u.searchParams.set('v', String(Date.now())); // past the minute-long edge cache, so a rebuild right after an approval sees it
    const res = await fetchImpl(u, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const json = (await res.json()) as { stories?: unknown };
    if (!json || !Array.isArray(json.stories)) return null;
    const stories: FeedStory[] = [];
    let skipped = 0;
    const seen = new Set<string>();
    for (const s of json.stories) {
      const r = feedStory.safeParse(s);
      if (!r.success || seen.has(r.data.slug)) { skipped++; continue; }
      if (r.data.type === 'insight' && !r.data.source) { skipped++; continue; } // an insight always links to its original
      seen.add(r.data.slug);
      stories.push(r.data);
    }
    return { stories, skipped };
  } catch {
    return null;
  }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The story page body: our text as paragraphs, then (insights) a clear link to the original article. */
export function storyHtml(s: Pick<FeedStory, 'body' | 'source' | 'type'>): string {
  const paras = s.body.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`);
  if (s.type === 'insight' && s.source) {
    paras.unshift('<h2>What It Means</h2>');
    paras.push(`<p class="source-link">Read the original at <a href="${esc(s.source.url)}" target="_blank" rel="noopener nofollow">${esc(s.source.name)}</a>.</p>`);
  }
  return paras.join('\n');
}

/** The frontmatter-like data for the collection (same shape as a Markdown story, plus the source). */
export function storyData(s: FeedStory) {
  return {
    title: s.title,
    date: s.date,
    summary: s.summary,
    ...(s.industry ? { industry: s.industry } : {}),
    type: s.type,
    audience: ['clients'],
    linkedin: s.linkedin || undefined,
    ...(s.source ? { source: s.source } : {}),
  };
}
