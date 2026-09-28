import { getCollection } from 'astro:content';

/** Published stories, newest first. Drafts show only in `astro dev`. */
export async function getStories() {
  const all = await getCollection('stories', ({ data }) => import.meta.env.DEV || !data.draft);
  return all.sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
}
