// Security headers on every page and endpoint of the website (TS Workspace
// docs/security/review.md, SEC-M8). Tested in tests/security-headers.test.ts.
//
// Why a build step: the Vercel adapter writes the site's routing table
// (.vercel/output/config.json) itself, and Vercel reads that table, not a
// vercel.json, for headers. So after the adapter has written it, this adds one
// headers rule in the same place the adapter puts its own (/_astro cache
// headers): just before "filesystem", with continue, so every page, file and
// endpoint gets them. Redirects come earlier and don't need them.
//
// Only headers that can't break a page:
// - no other site may show ours in a frame (clickjacking): frame-ancestors
//   'self' and X-Frame-Options SAMEORIGIN; base-uri 'self';
// - nosniff, a referrer policy (the browser default, written out), and a
//   permissions policy (the site uses no camera, microphone or location).
// A full Content-Security-Policy (scripts: GA4, LinkedIn; the chat) is a
// separate step, report-only first (TS Workspace build item S-SEC7).
import { readFile, writeFile } from 'node:fs/promises';

export const securityHeaders = {
  'Content-Security-Policy': "frame-ancestors 'self'; base-uri 'self'",
  'X-Frame-Options': 'SAMEORIGIN',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

export const headersRoute = { src: '^/(.*)$', headers: securityHeaders, continue: true };

/** The Vercel routing table with the headers rule added once, before "filesystem". */
export function withSecurityHeaders(config) {
  // Safe to run twice: an earlier copy of the rule is dropped first.
  const routes = (config.routes ?? []).filter((r) => !(r.continue && r.headers && 'X-Frame-Options' in r.headers));
  const at = routes.findIndex((r) => r.handle === 'filesystem');
  routes.splice(at === -1 ? 0 : at, 0, headersRoute);
  return { ...config, routes };
}

/** The Astro integration: runs after the Vercel adapter has written its config. */
export function securityHeadersIntegration() {
  let root;
  return {
    name: 'security-headers',
    hooks: {
      'astro:config:done': ({ config }) => { root = config.root; },
      'astro:build:done': async ({ logger }) => {
        const file = new URL('./.vercel/output/config.json', root);
        let config;
        try { config = JSON.parse(await readFile(file, 'utf8')); } catch {
          logger.warn('No .vercel/output/config.json: security headers not added (not a Vercel build).');
          return;
        }
        await writeFile(file, JSON.stringify(withSecurityHeaders(config), null, 2));
        logger.info('Security headers added to every route.');
      },
    },
  };
}
