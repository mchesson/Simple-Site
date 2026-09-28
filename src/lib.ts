import { getCollection, type CollectionEntry } from 'astro:content';

const visible = <T extends { data: { draft: boolean } }>(e: T) => import.meta.env.DEV || !e.data.draft;

/** Industries in menu order. */
export async function getIndustries() {
  const all = await getCollection('industries', visible);
  return all.sort((a, b) => a.data.order - b.data.order);
}

/** Published stories, newest first. Drafts show only in `astro dev`. */
export async function getStories() {
  const all = await getCollection('stories', visible);
  return all.sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
}

export const typeLabel: Record<CollectionEntry<'stories'>['data']['type'], string> = {
  'company-news': 'Company News',
  insight: 'Insight',
  'case-study': 'Case Study',
  spotlight: 'Spotlight',
  event: 'Event',
};

export const formatDate = (d: Date) =>
  d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
