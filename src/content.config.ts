import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

// Every story is a Markdown file in src/content/stories. The tags below decide
// where it appears on the site and which audiences it is distributed to.
const stories = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/stories' }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    summary: z.string().max(240),
    pillar: z.enum(['life-sciences', 'data-centers', 'enterprise-technology', 'company']),
    type: z.enum(['company-news', 'insight', 'case-study', 'spotlight', 'event']),
    audience: z.array(z.enum(['buyers', 'talent', 'consultants', 'partners'])).min(1),
    author: z.string().default('Technical Source'),
    image: z.string().optional(),
    /** Ready-to-post LinkedIn copy; the story page offers a copy button. */
    linkedin: z.string().optional(),
    /** Client or program details anonymized for NDA reasons. */
    anonymized: z.boolean().default(false),
    /** Prototype content that must be replaced before launch. */
    sample: z.boolean().default(false),
    draft: z.boolean().default(false),
  }),
});

export const collections = { stories };
