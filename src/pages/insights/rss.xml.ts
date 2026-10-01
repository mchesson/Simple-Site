import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getStories } from '../../lib';
import { site } from '../../data/site';

export async function GET(context: APIContext) {
  const stories = await getStories();
  return rss({
    title: `${site.name} | Insights`,
    description: site.description,
    site: context.site!,
    trailingSlash: false, // one address per page (astro.config trailingSlash: 'never')
    items: stories.map((s) => ({
      title: s.data.title,
      pubDate: s.data.date,
      description: s.data.summary,
      link: `/insights/${s.id}`,
      categories: [s.data.industry?.id ?? 'company', s.data.type, ...s.data.audience],
    })),
  });
}
