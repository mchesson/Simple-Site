// One feed per pillar (plus company). Email newsletters and automations
// subscribe to these, e.g. /news/life-sciences/rss.xml
import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getStories } from '../../../lib';
import { site } from '../../../data/site';
import { storyPillarLabel, type StoryPillar } from '../../../data/pillars';

export function getStaticPaths() {
  return (Object.keys(storyPillarLabel) as StoryPillar[]).map((feed) => ({ params: { feed } }));
}

export async function GET(context: APIContext) {
  const feed = context.params.feed as StoryPillar;
  const stories = (await getStories()).filter((s) => s.data.pillar === feed);
  return rss({
    title: `${site.name} | ${storyPillarLabel[feed]}`,
    description: `${storyPillarLabel[feed]} news and insights from ${site.name}.`,
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
