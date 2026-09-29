// One feed per industry plus company news, for newsletter automation:
// /insights/<industry-id>/rss.xml and /insights/company/rss.xml
import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getIndustries, getStories } from '../../../lib';
import { site } from '../../../data/site';

export async function getStaticPaths() {
  const industries = await getIndustries();
  return [
    ...industries.map((i) => ({ params: { feed: i.id }, props: { label: i.data.name } })),
    { params: { feed: 'company' }, props: { label: 'Company News' } },
  ];
}

export async function GET(context: APIContext) {
  const feed = context.params.feed!;
  const { label } = context.props as { label: string };
  const stories = (await getStories()).filter((s) => (s.data.industry?.id ?? 'company') === feed);
  return rss({
    title: `${site.name} | ${label}`,
    description: `${label} from ${site.name}.`,
    site: context.site!,
    items: stories.map((s) => ({
      title: s.data.title,
      pubDate: s.data.date,
      description: s.data.summary,
      link: `/insights/${s.id}/`,
      categories: [feed, s.data.type, ...s.data.audience],
    })),
  });
}
