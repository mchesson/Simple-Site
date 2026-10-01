// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import vercel from '@astrojs/vercel';
import { securityHeadersIntegration } from './src/security-headers.mjs';

export default defineConfig({
  // Styles are small: put them in each page so it can draw without waiting.
  build: { inlineStylesheets: 'always' },
  // Set SITE_URL on the host for test copies (e.g. https://teksourcetalent.com)
  // so canonical and LinkedIn share links point at that copy.
  site: process.env.SITE_URL || 'https://technicalsource.com',
  // securityHeadersIntegration: frame, sniffing, referrer and permissions
  // headers on every route (src/security-headers.mjs). It runs after the
  // Vercel adapter (Astro runs the adapter's hooks first).
  integrations: [sitemap(), securityHeadersIntegration()],
  // One address per page, without a trailing slash: Vercel forwards /company/
  // to /company (308). Old WordPress links all end in a slash, so this also
  // makes the redirects below answer for them.
  trailingSlash: 'never',
  // Pages stay static; only the form and jobs endpoints in src/pages/api run as
  // Vercel functions (they hold the Crelate API key).
  // maxDuration: time for /api/jobs to page through every Crelate job on a cold start.
  adapter: vercel({ maxDuration: 60 }),
  // Old WordPress addresses (every page in its sitemap, Oct 2026, plus its
  // feeds and XML sitemaps), so existing links and search results keep working.
  // Vercel answers each with a permanent redirect (308), with or without the
  // trailing slash. /privacy-policy, /terms-and-conditions, /employee-resources
  // and /company exist on this site under the same address. /wp-admin,
  // /wp-login.php and other WordPress paths are left to 404 on purpose.
  redirects: {
    '/contact-us': '/contact',
    '/our-locations': '/company#locations',
    '/state/nc': '/company#locations',
    '/careeropportunities': '/careers',
    '/careeropportunities/working-with-technical-source': '/careers',
    '/careeropportunities/frequently-asked-questions': '/careers',
    '/career-resources': '/careers',
    '/current-openings': '/careers#jobs',
    '/testing-alternate-portal': '/careers#jobs',
    '/submit-your-resume': '/careers#network',
    '/submit-your-resume-thank-you': '/careers#network',
    '/workforce-solutions': '/services',
    '/workforce-solutions/talent-services': '/services#project-support',
    '/workforce-solutions/managed-services': '/services#managed-project-teams',
    '/workforce-solutions/workforce-management': '/services',
    '/workforce-solutions/industries': '/industries',
    '/sitemap': '/',
    '/news': '/insights',
    '/category/uncategorized': '/insights',
    '/feed': '/insights/rss.xml',
    '/category/uncategorized/feed': '/insights/rss.xml',
    '/sitemap.xml': '/sitemap-index.xml',
    '/sitemap_index.xml': '/sitemap-index.xml',
    '/wp-sitemap.xml': '/sitemap-index.xml',
    '/page-sitemap.xml': '/sitemap-index.xml',
    '/states-sitemap.xml': '/sitemap-index.xml',
  },
});
