// robots.txt: blocks search engines unless ALLOW_INDEXING=true (set only on the
// production deployment at launch). The test site on vercel.app stays hidden.
import type { APIRoute } from 'astro';

export const GET: APIRoute = ({ site }) => {
  const allow = process.env.ALLOW_INDEXING === 'true';
  const body = allow
    ? `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${new URL('/sitemap-index.xml', site)}\n`
    : `User-agent: *\nDisallow: /\n`;
  return new Response(body, { headers: { 'Content-Type': 'text/plain' } });
};
