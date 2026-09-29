// GET /api/jobs: public job postings from Crelate for the careers page.
//   ?q=keyword  ?loc=ZIP or "City, ST"  ?radius=miles (default 50; 0 = any)
// Safety: returns nothing unless JOBS_LIST_ENABLED=true in Vercel, and only
// ever returns the allowlisted public portal fields (see toPublicJob).
// Diagnostics (no job text, no client data):
//   ?check=1  field names of the first job
//   ?check=2  counts and the distinct values of a few status fields
//   ?check=3  published jobs: public title + non-identifying status fields
//   ?check=5&q=title  how the site read public postings (facts + outline)
//   ?check=6&q=title  the raw public posting markup of one job
//   ?check=4  links found on the public job portal page (to learn its job
//             and resume-submission link patterns)
import type { APIRoute } from 'astro';
import { isConfigured, isPublished, toPublicJob, CrelateError } from '../../crelate';
import { allJobs, publicJobs, jobsEnabled, searchJobs } from '../../jobs';
import { site } from '../../data/site';
import { json } from './_shared';
import { decode } from '../../html';

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
    if (check === '6') {
      // Raw layout of one public posting (its PortalDescription, the text
      // already public on the job portal), to fix how the site reads it.
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const raw = (await allJobs()).raw.filter(isPublished).find((j) => q && String(j?.PortalTitle ?? '').toLowerCase().includes(q));
      const html = String(raw?.PortalDescription ?? '');
      return json({ ok: true, title: raw?.PortalTitle ?? null, html: html.slice(0, 8000), length: html.length }, 200, { 'Cache-Control': 'no-store' });
    }
    if (check === '5') {
      // How the site read each public posting: facts and the outline of the
      // tidied text (public posting content only), to fix layout issues.
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      const jobs = (await publicJobs()).filter((j) => !q || j.title.toLowerCase().includes(q)).slice(0, 5);
      return json({
        ok: true,
        jobs: jobs.map((j) => ({
          title: j.title,
          subtitle: j.subtitle,
          facts: j.facts,
          outline: [...j.description.matchAll(/<(h3|p|ul|ol)>([\s\S]*?)<\/\1>/g)].slice(0, 25).map((m) => `${m[1]}: ${decode(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 70)}`),
        })),
      }, 200, { 'Cache-Control': 'no-store' });
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

    const result = await searchJobs({ q: url.searchParams.get('q') ?? '', loc: url.searchParams.get('loc') ?? '', radius: Number(url.searchParams.get('radius') ?? 50) });
    if (result.error) return json({ ok: false, error: result.error, jobs: [] });
    const { jobs: out, origin } = result;
    return json({ ok: true, jobs: out, origin }, 200, { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' });
  } catch (e) {
    console.error('[jobs] Crelate error', e instanceof CrelateError ? `${e.status} ${e.detail}` : e);
    return json({ ok: false, error: 'unavailable', jobs: [] });
  }
};
