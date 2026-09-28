// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  // Set SITE_URL on the host for test copies (e.g. https://teksourcetalent.com)
  // so canonical and LinkedIn share links point at that copy.
  site: process.env.SITE_URL || 'https://technicalsource.com',
  integrations: [sitemap()],
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
