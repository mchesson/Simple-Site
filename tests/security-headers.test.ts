// The security headers rule added to Vercel's routing table (src/security-headers.mjs).
import { describe, it, expect } from 'vitest';
import { headersRoute, securityHeaders, withSecurityHeaders } from '../src/security-headers.mjs';
import { jsonLd } from '../src/html';

const sample = {
  version: 3,
  routes: [
    { src: '^/(.*)/$', headers: { Location: '/$1' }, status: 308 },
    { src: '^/_astro(?:/(.*))$', headers: { 'cache-control': 'public, max-age=31536000, immutable' }, continue: true },
    { handle: 'filesystem' },
    { src: '^/api/jobs$', dest: '_render' },
    { src: '^/.*$', dest: '/404.html', status: 404 },
  ],
};

describe('security headers', () => {
  it('adds one rule for every path, just before the filesystem step, like the adapter’s own', () => {
    const out = withSecurityHeaders(sample);
    const at = out.routes.indexOf(headersRoute);
    expect(at).toBe(2);
    expect(out.routes[at + 1]).toEqual({ handle: 'filesystem' });
    expect(headersRoute).toMatchObject({ src: '^/(.*)$', continue: true });
    expect(out.routes).toHaveLength(sample.routes.length + 1);
    expect(sample.routes).toHaveLength(5); // the input is not changed
  });

  it('is safe to run twice', () => {
    const twice = withSecurityHeaders(withSecurityHeaders(sample));
    expect(twice.routes.filter((r) => r === headersRoute)).toHaveLength(1);
  });

  it('stops other sites from framing ours, and nothing that could break a page', () => {
    expect(securityHeaders['X-Frame-Options']).toBe('SAMEORIGIN');
    expect(securityHeaders['Content-Security-Policy']).toBe("frame-ancestors 'self'; base-uri 'self'");
    expect(securityHeaders['X-Content-Type-Options']).toBe('nosniff');
    // Scripts (GA4, LinkedIn, the chat) are not restricted here.
    expect(securityHeaders['Content-Security-Policy']).not.toMatch(/script-src|default-src/);
  });
});

describe('structured data (JSON-LD)', () => {
  it('can never close its <script> tag, whatever a job title or story says', () => {
    const out = jsonLd({ title: 'CQV Lead </script><script>alert(1)</script>' });
    expect(out).not.toMatch(/<\/script/i);
    expect(out).not.toContain('<');
    expect(JSON.parse(out)).toEqual({ title: 'CQV Lead </script><script>alert(1)</script>' });
  });
});
