import { getCollection, type CollectionEntry } from 'astro:content';

const visible = <T extends { data: { draft: boolean } }>(e: T) => import.meta.env.DEV || !e.data.draft;

/** Industries in menu order. */
export async function getIndustries() {
  const all = await getCollection('industries', visible);
  return all.sort((a, b) => a.data.order - b.data.order);
}

/** A Markdown story, or an approved one from TS Workspace (src/feed.ts). */
export type Story = CollectionEntry<'stories'> | CollectionEntry<'feedStories'>;

/** The original article an insight from TS Workspace summarizes (Markdown stories have none). */
export const sourceOf = (s: Story) => ('source' in s.data ? s.data.source : undefined);

/**
 * Published stories, newest first: the Markdown files plus the approved
 * stories from TS Workspace. Drafts show only in `astro dev`.
 */
export async function getStories(): Promise<Story[]> {
  const [md, feed] = await Promise.all([getCollection('stories', visible), getCollection('feedStories', visible)]);
  const all: Story[] = [...md, ...feed];
  return all.sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
}

export const typeLabel: Record<Story['data']['type'], string> = {
  'company-news': 'Company News',
  insight: 'Insight',
  'case-study': 'Case Study',
  spotlight: 'Spotlight',
  event: 'Event',
};

export const formatDate = (d: Date) =>
  d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
