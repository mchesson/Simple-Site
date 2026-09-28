import { defineCollection, reference } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

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
const stories = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/stories' }),
  schema: z.object({
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
  }),
});

export const collections = { industries, stories };
