// Which stories are shown. Drafts show only in `astro dev`. Sample stories
// (`sample: true`, the made-up ones from before launch) are hidden from
// production builds when the Vercel setting HIDE_SAMPLE_STORIES is "true";
// by default they still show, so Insights isn't empty before real stories
// are approved. Every area that shows stories disappears when it has none.

export interface StoryFlags { draft: boolean; sample: boolean }
export interface StoryRules { dev: boolean; hideSamples: boolean }

export const storyRules = (env: Record<string, string | undefined>, dev: boolean): StoryRules => ({
  dev,
  hideSamples: env.HIDE_SAMPLE_STORIES?.trim().toLowerCase() === 'true',
});

export function showStory(d: StoryFlags, rules: StoryRules): boolean {
  if (rules.dev) return true;
  if (d.draft) return false;
  return !(d.sample && rules.hideSamples);
}

/** The /insights filter buttons that have stories: industries in menu order, then Company News. */
export function storyFilters(
  industries: { id: string; name: string }[],
  stories: { industry?: string }[],
): { id: string; label: string }[] {
  const has = new Set(stories.map((s) => s.industry ?? 'company'));
  const list = industries.filter((i) => has.has(i.id)).map((i) => ({ id: i.id, label: i.name }));
  if (has.has('company')) list.push({ id: 'company', label: 'Company News' });
  return list;
}
