// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import vercel from '@astrojs/vercel';

export default defineConfig({
  // Styles are small: put them in each page so it can draw without waiting.
  build: { inlineStylesheets: 'always' },
  // Set SITE_URL on the host for test copies (e.g. https://teksourcetalent.com)
  // so canonical and LinkedIn share links point at that copy.
  site: process.env.SITE_URL || 'https://technicalsource.com',
  integrations: [sitemap()],
  // Pages stay static; only the form and jobs endpoints in src/pages/api run as
  // Vercel functions (they hold the Crelate API key).
  // maxDuration: time for /api/jobs to page through every Crelate job on a cold start.
  adapter: vercel({ maxDuration: 60 }),
  // Old WordPress addresses, so existing links and search results keep working.
  // TODO: confirm the full list of old URLs once WordPress access is available.
  redirects: {
    '/contact-us': '/contact',
    '/our-locations': '/company#locations',
    '/careeropportunities': '/careers',
    '/careeropportunities/working-with-technical-source': '/careers',
    '/career-resources': '/careers',
    '/news': '/insights',
  },
});
