// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://technicalsource.com',
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
