// GET /api/jobs: public job postings from Crelate for the careers page.
//   ?q=keyword  ?loc=ZIP or "City, ST"  ?radius=miles (default 50; 0 = any)
// Safety: returns nothing unless JOBS_LIST_ENABLED=true in Vercel, and only
// ever returns the allowlisted public portal fields (see toPublicJob).
// Diagnostics (no job text, no client data):
//   ?check=1  field names of the first job
//   ?check=2  counts and the distinct values of a few status fields
//   ?check=3  published jobs: public title + non-identifying status fields
//   ?check=4  links found on the public job portal page (to learn its job
//             and resume-submission link patterns)
import type { APIRoute } from 'astro';
import { isConfigured, isPublished, toPublicJob, CrelateError } from '../../crelate';
import { allJobs, publicJobs, jobPath, jobsEnabled } from '../../jobs';
import { resolveLocation, jobPoint, miles, isRemote } from '../../geo';
import { site } from '../../data/site';
import { json } from './_shared';

export const prerender = false;

export const GET: APIRoute = async ({ url }) => {
  if (!isConfigured()) return json({ ok: false, error: 'not-configured', jobs: [] });
  try {
    const check = url.searchParams.get('check');
    if (check === '4') {
      // The public portal page, fetched from here because it's the only place
      // that can reach it. Returns link addresses only.
      const res = await fetch(site.jobsPortal, { headers: { Accept: 'text/html' } });
      const html = await res.text();
      const found = (re: RegExp) => [...new Set([...html.matchAll(re)].map((m) => m[1] ?? m[0]))].slice(0, 80);
      return json({
        ok: true,
        status: res.status,
        size: html.length,
        links: found(/href=["']([^"']+)["']/gi),
        crelateUrls: found(/https?:\/\/[^"'\s<>()]*crelate[^"'\s<>()]*/gi),
        portalPaths: found(/\/portal\/technicalsource\/[^"'\s<>()]*/gi),
      });
    }
    if (check) {
      const { raw, capped } = await allJobs();
      if (check === '1') return json({ ok: true, count: raw.length, fields: raw[0] ? Object.keys(raw[0]).sort() : [] });
      if (check === '3') {
        // Published jobs with their PUBLIC title and non-identifying status
        // fields, to spot why the portal shows a different number of jobs.
        const pick = (j: any) => ({
          title: toPublicJob(j).title,
          hasSlug: Boolean(j?.PortalUrlSlug),
          lastPosted: j?.PortalLastPostedOn ?? null,
          visibility: j?.PortalVisibility ?? null,
          featured: j?.IsFeatured ?? null,
          freeBoards: j?.IsPublishedToFreeBoards ?? null,
          openings: j?.NumberOfOpenings ?? null,
          placements: j?.NumberOfPlacements ?? null,
          placementStatus: j?.PlacementStatus?.Title ?? j?.PlacementStatus ?? null,
          estimatedEnd: j?.EstimatedEndDate ?? null,
          isLead: j?.IsLead ?? null,
          hasParent: Boolean(j?.ParentJobId),
        });
        return json({ ok: true, published: raw.filter(isPublished).map(pick).sort((a, b) => String(a.title).localeCompare(String(b.title))) });
      }
      const distinct = (k: string) => [...new Set(raw.map((j) => JSON.stringify(j?.[k] ?? null)))].slice(0, 25);
      const published = raw.filter(isPublished);
      return json({
        ok: true,
        total: raw.length,
        readAllJobs: !capped,
        onPortal: raw.filter((j) => j?.OnPortal === true).length,
        onPortalButOnHold: raw.filter((j) => j?.OnPortal === true && j?.IsOnHold === true).length,
        onPortalButClosed: raw.filter((j) => j?.OnPortal === true && j?.ClosedOn).length,
        publishedAfterFilters: published.length,
        publishedByVisibility: published.reduce((m: Record<string, number>, j) => ((m[String(j?.PortalVisibility)] = (m[String(j?.PortalVisibility)] ?? 0) + 1), m), {}),
        withZip: published.filter((j) => /^\d{5}/.test(String(j?.PortalZip ?? ''))).length,
        values: { OnPortal: distinct('OnPortal'), PortalVisibility: distinct('PortalVisibility'), IsHidden: distinct('IsHidden'), IsOnHold: distinct('IsOnHold'), PortalState: distinct('PortalState'), PortalCountryId: distinct('PortalCountryId') },
      });
    }

    if (!jobsEnabled()) return json({ ok: true, jobs: [], disabled: true });

    const q = (url.searchParams.get('q') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const locInput = url.searchParams.get('loc') ?? '';
    const radius = Math.max(0, Number(url.searchParams.get('radius') ?? 50) || 0);
    const origin = locInput ? resolveLocation(locInput) : null;
    if (locInput && !origin) return json({ ok: false, error: 'bad-location', jobs: [] });

    let jobs = (await publicJobs()).map((j) => {
      const remote = isRemote(j.title, j.city);
      const pt = jobPoint(j.zip, j.city, j.state);
      const distance = origin && pt ? Math.round(miles(origin, pt)) : null;
      return { ...j, remote, distance, url: jobPath(j), location: remote ? 'Remote' : [j.city, j.state].filter(Boolean).join(', ') };
    });
    if (q.length) jobs = jobs.filter((j) => q.every((w) => `${j.title} ${j.summary}`.toLowerCase().includes(w)));
    if (origin) {
      jobs = jobs.filter((j) => j.remote || (j.distance !== null && (radius === 0 || j.distance <= radius)));
      jobs.sort((a, b) => (a.remote ? 1 : 0) - (b.remote ? 1 : 0) || (a.distance ?? 0) - (b.distance ?? 0));
    }
    const out = jobs.map(({ title, location, summary, url, distance, remote }) => ({ title, location, summary, url, distance, remote }));
    return json({ ok: true, jobs: out, origin: origin?.label ?? null }, 200, { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' });
  } catch (e) {
    console.error('[jobs] Crelate error', e instanceof CrelateError ? `${e.status} ${e.detail}` : e);
    return json({ ok: false, error: 'unavailable', jobs: [] });
  }
};
