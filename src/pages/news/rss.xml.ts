import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getStories } from '../../lib';
import { site } from '../../data/site';

export async function GET(context: APIContext) {
  const stories = await getStories();
  return rss({
    title: `${site.name} | News & Insights`,
    description: site.description,
    site: context.site!,
    items: stories.map((s) => ({
      title: s.data.title,
      pubDate: s.data.date,
      description: s.data.summary,
      link: `/news/${s.id}/`,
      categories: [s.data.pillar, s.data.type, ...s.data.audience],
    })),
  });
}
