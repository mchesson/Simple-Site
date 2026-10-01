// The job list as it was when the site was built (public posting fields only,
// toPublicJob), so the careers page still lists jobs if Crelate can't be read
// later (src/jobs-fallback.ts). Never fails the build: no list is saved as
// an empty one, which the fallback ignores.
import type { APIRoute } from 'astro';
import { isConfigured } from '../crelate';
import { jobsEnabled, publicJobs } from '../jobs';

export const prerender = true;

export const GET: APIRoute = async () => {
  let jobs: Awaited<ReturnType<typeof publicJobs>> = [];
  if (jobsEnabled() && isConfigured()) {
    // publicJobs, not fresh: if Crelate is down at build time, the previous snapshot carries over.
    try { jobs = await publicJobs(); } catch (e) { console.error('[jobs-snapshot] no list saved', e instanceof Error ? e.message : e); }
  }
  return new Response(JSON.stringify({ at: new Date().toISOString(), jobs }), { headers: { 'Content-Type': 'application/json' } });
};
