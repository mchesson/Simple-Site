import { defineCollection, reference } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fetchFeed, storyData, storyHtml } from './feed';
import { photos } from './data/photo-credits';

// One Markdown file per industry in src/content/industries. Adding a file adds
// the industry everywhere: menu, homepage row, industry page, footer, forms,
// story tags and RSS feeds. The file name is the URL (/industries/<file-name>).
const industries = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/industries' }),
  schema: z.object({
    name: z.string(),
    /** Position in menus and lists (lowest first). */
    order: z.number(),
    /** One short line for the homepage row and menus. */
    short: z.string(),
    /** One or two sentences for the Industries page and search results. */
    summary: z.string(),
    /** Accent color for the chevron icon (brand colors only). */
    color: z.string(),
    headline: z.string(),
    /** The part of the headline shown in green (must appear in the headline). */
    highlight: z.string().optional(),
    intro: z.string(),
    /** "What we support": the kinds of projects in this industry. */
    focus: z.array(z.object({ title: z.string(), body: z.string() })),
    /** "Expertise we bring": disciplines, phrased as capabilities. */
    expertise: z.array(z.string()),
    draft: z.boolean().default(false),
  }),
});

// One Markdown file per story (news, insights, case studies) in src/content/stories.
const storyFields = {
  title: z.string(),
  date: z.coerce.date(),
  summary: z.string().max(240),
  /** Leave out for company-wide news. */
  industry: reference('industries').optional(),
  type: z.enum(['company-news', 'insight', 'case-study', 'spotlight', 'event']),
  audience: z.array(z.enum(['clients', 'candidates', 'consultants', 'partners'])).min(1),
  author: z.string().default('Technical Source'),
  image: z.string().optional(),
  /** Ready-to-post LinkedIn copy; the story page offers a copy button. */
  linkedin: z.string().optional(),
  /** Client or project details withheld for confidentiality. */
  anonymized: z.boolean().default(false),
  /** Prototype content that must be replaced before launch. */
  sample: z.boolean().default(false),
  draft: z.boolean().default(false),
};
const stories = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/stories' }),
  schema: z.object(storyFields),
});

// Approved Website Insights and Company News from TS Workspace (src/feed.ts),
// read when the site builds and shown with the Markdown stories. Insights
// carry `source` (the original article); the page links to it.
const feedStories = defineCollection({
  loader: {
    name: 'ts-workspace-stories',
    load: async ({ store, logger, parseData, generateDigest }) => {
      const url = process.env.ATS_STORIES_URL;
      if (!url) {
        store.clear();
        logger.info('ATS_STORIES_URL not set: Markdown stories only.');
        return;
      }
      const feed = await fetchFeed(url);
      if (!feed) {
        logger.warn(`TS Workspace stories unavailable; keeping the ${store.keys().length} from the last good read.`);
        return;
      }
      const industries = new Set(readdirSync(path.join(process.cwd(), 'src/content/industries')).map((f) => f.replace(/\.md$/, '')));
      const markdown = new Set(readdirSync(path.join(process.cwd(), 'src/content/stories')).map((f) => f.replace(/\.md$/, '')));
      store.clear();
      let skipped = feed.skipped;
      for (const s of feed.stories) {
        // A Markdown story with the same address wins; an industry the site no longer has is skipped.
        if (markdown.has(s.slug) || (s.industry && !industries.has(s.industry))) { skipped++; continue; }
        const data = await parseData({ id: s.slug, data: storyData(s) });
        store.set({ id: s.slug, data, body: s.body, rendered: { html: storyHtml(s) }, digest: generateDigest(JSON.stringify(s)) });
      }
      logger.info(`TS Workspace stories: ${store.keys().length} loaded${skipped ? `, ${skipped} skipped` : ''}.`);
    },
  },
  schema: z.object({
    ...storyFields,
    summary: z.string().max(600),
    /** Where the original article is (insights). */
    source: z.object({ name: z.string(), url: z.string().url() }).optional(),
  }),
});

export const collections = { industries, stories, feedStories };
