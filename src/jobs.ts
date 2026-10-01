// Open positions from Crelate, shared by /api/jobs (list + search) and the
// job pages (/careers/jobs/<title>-<id>). Server only.
// Safety: nothing is shown unless JOBS_LIST_ENABLED=true in Vercel, and only
// the allowlisted public portal fields ever leave this file (see toPublicJob).
import { crelate, listOf, isPublished, toPublicJob, type PublicJob } from './crelate';
import { resolveLocation, jobPoint, miles, isRemote } from './geo';
import { withFallback, parseSnapshot, type Saved } from './jobs-fallback';

export const jobsEnabled = () => process.env.JOBS_LIST_ENABLED === 'true';

let cache: { at: number; raw: any[]; capped: boolean } | null = null;
const PAGE = 100, MAX = 10000, PARALLEL = 5;
/** Every job in Crelate (paged, a few pages at a time), cached for 3 minutes (a closed job leaves the site within about 5). */
export async function allJobs(): Promise<{ raw: any[]; capped: boolean }> {
  if (cache && Date.now() - cache.at < 3 * 60 * 1000) return cache;
  const raw: any[] = [];
  let done = false;
  for (let offset = 0; offset < MAX && !done; offset += PAGE * PARALLEL) {
    const pages = await Promise.all(
      Array.from({ length: PARALLEL }, (_, i) => crelate('jobs', { params: { limit: PAGE, offset: offset + i * PAGE } }).then(listOf)),
    );
    for (const page of pages) {
      raw.push(...page);
      if (page.length < PAGE) done = true;
    }
  }
  cache = { at: Date.now(), raw, capped: !done };
  return cache;
}

/** Published jobs straight from Crelate, public fields only (no fallback: the build snapshot uses this). */
export async function freshPublicJobs(): Promise<PublicJob[]> {
  return (await allJobs()).raw.filter(isPublished).map(toPublicJob);
}

let lastGood: Saved | null = null;
let snapshotRead: Promise<Saved | null> | null = null;
/** The list saved at the site's last build (public fields only), read once per server. */
function buildSnapshot(): Promise<Saved | null> {
  snapshotRead ??= (async () => {
    const base = process.env.SITE_URL || 'https://technicalsource.com';
    const res = await fetch(`${base}/jobs-snapshot.json`, { signal: AbortSignal.timeout(5000) });
    return res.ok ? parseSnapshot(await res.json()) : null;
  })().catch(() => { snapshotRead = null; return null; });
  return snapshotRead;
}

/** Published jobs, public fields only. When Crelate can't be read, the last list read (see jobs-fallback.ts). */
export async function publicJobs(): Promise<PublicJob[]> {
  const { jobs } = await withFallback(freshPublicJobs, {
    memory: () => lastGood,
    remember: (s) => { lastGood = s; },
    snapshot: buildSnapshot,
  });
  return jobs;
}

const slugify = (s: string) => s.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);

/** The job's page on this site. */
export const jobPath = (j: PublicJob) => `/careers/jobs/${slugify(j.title) || 'job'}-${j.id}`;

/** Find a job from its page address (the Crelate Id is at the end). */
export async function findJob(param: string): Promise<PublicJob | undefined> {
  const jobs = await publicJobs();
  return jobs.find((j) => j.id && param.toLowerCase().endsWith(j.id.toLowerCase()));
}

export type JobResult = { title: string; location: string; summary: string; url: string; distance: number | null; remote: boolean };

/** Keyword and distance search over published jobs (Careers page and chat).
 *  radius in miles; 0 = any distance. Returns public fields only. */
export async function searchJobs(p: { q?: string; loc?: string; radius?: number }): Promise<{ jobs: JobResult[]; origin: string | null; error?: 'bad-location' }> {
  const words = (p.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const locInput = (p.loc ?? '').trim();
  const radius = Math.max(0, Number(p.radius ?? 50) || 0);
  const origin = locInput ? resolveLocation(locInput) : null;
  if (locInput && !origin) return { jobs: [], origin: null, error: 'bad-location' };

  let jobs = (await publicJobs()).map((j) => {
    const remote = isRemote(j.title, j.city);
    const pt = jobPoint(j.zip, j.city, j.state);
    const distance = origin && pt ? Math.round(miles(origin, pt)) : null;
    return { ...j, remote, distance, url: jobPath(j), location: remote ? 'Remote' : [j.city, j.state].filter(Boolean).join(', ') };
  });
  if (words.length) jobs = jobs.filter((j) => words.every((w) => `${j.title} ${j.summary}`.toLowerCase().includes(w)));
  if (origin) {
    jobs = jobs.filter((j) => j.remote || (j.distance !== null && (radius === 0 || j.distance <= radius)));
    jobs.sort((a, b) => (a.remote ? 1 : 0) - (b.remote ? 1 : 0) || (a.distance ?? 0) - (b.distance ?? 0));
  }
  return {
    jobs: jobs.map(({ title, location, summary, url, distance, remote }) => ({ title, location, summary, url, distance, remote })),
    origin: origin?.label ?? null,
  };
}
