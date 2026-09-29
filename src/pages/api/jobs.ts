// GET /api/jobs: open jobs from Crelate for the careers page.
// Cached at Vercel's edge for 10 minutes so Crelate isn't called on every visit.
// GET /api/jobs?check=1 returns only the field names of the first job (no
// values) to help map Crelate's fields in src/crelate.ts → toJob().
import type { APIRoute } from 'astro';
import { crelate, isConfigured, listOf, toJob, CrelateError } from '../../crelate';
import { json } from './_shared';

export const prerender = false;

const CLOSED = /closed|filled|cancel|hold|inactive|lost/i;

export const GET: APIRoute = async ({ url }) => {
  if (!isConfigured()) return json({ ok: false, error: 'not-configured', jobs: [] }, 200);
  try {
    const raw = listOf(await crelate('jobs', { params: { limit: 100, offset: 0 } }));
    if (url.searchParams.get('check')) {
      return json({ ok: true, count: raw.length, fields: raw[0] ? Object.keys(raw[0]).sort() : [] });
    }
    // DISABLED: the API's job name/description are internal (they can include
    // client and recruiter names), and the API doesn't say which jobs are
    // published to the portal. Until the public posting title and a "published"
    // flag are confirmed from /api/jobs?check=1, return no jobs, so the careers
    // page shows the "View Open Positions" portal button. Never map internal
    // name/description fields to anything public.
    void toJob; void CLOSED;
    return json({ ok: true, jobs: [] }, 200, { 'Cache-Control': 'no-store' });
  } catch (e) {
    console.error('[jobs] Crelate error', e instanceof CrelateError ? `${e.status} ${e.detail}` : e);
    return json({ ok: false, error: 'unavailable', jobs: [] }, 200);
  }
};
