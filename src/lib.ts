import { getCollection, type CollectionEntry } from 'astro:content';
import { storyPhoto, assignStoryPhotos } from './story-photo';
import type { PhotoId } from './data/photo-credits';
import { showStory, storyRules } from './story-filter';

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

const ref = (s: Story) => ({ id: s.id, image: s.data.image, industry: s.data.industry?.id });
// Filled by getStories(): each story's photo, chosen across the whole list so neighbours differ.
let photos = new Map<string, PhotoId>();

/** The photo a story's card and page show (src/story-photo.ts). */
export const photoOf = (s: Story): PhotoId => photos.get(s.id) ?? storyPhoto(ref(s));

/**
 * Published stories, newest first: the Markdown files plus the approved
 * stories from TS Workspace. Drafts show only in `astro dev`; sample stories
 * are hidden when HIDE_SAMPLE_STORIES=true (src/story-filter.ts).
 */
export async function getStories(): Promise<Story[]> {
  const rules = storyRules(process.env, import.meta.env.DEV);
  const shown = (e: Story) => showStory(e.data, rules);
  const [md, feed] = await Promise.all([getCollection('stories', shown), getCollection('feedStories', shown)]);
  const all: Story[] = [...md, ...feed];
  all.sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());
  photos = assignStoryPhotos(all.map(ref));
  return all;
}

/** True when at least one story is published (pages hide story areas otherwise). */
export const hasStories = async () => (await getStories()).length > 0;

export const typeLabel: Record<Story['data']['type'], string> = {
  'company-news': 'Company News',
  insight: 'Insight',
  'case-study': 'Case Study',
  spotlight: 'Spotlight',
  event: 'Event',
};

export const formatDate = (d: Date) =>
  d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
