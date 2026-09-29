// Open positions from Crelate, shared by /api/jobs (list + search) and the
// job pages (/careers/jobs/<title>-<id>). Server only.
// Safety: nothing is shown unless JOBS_LIST_ENABLED=true in Vercel, and only
// the allowlisted public portal fields ever leave this file (see toPublicJob).
import { crelate, listOf, isPublished, toPublicJob, type PublicJob } from './crelate';

export const jobsEnabled = () => process.env.JOBS_LIST_ENABLED === 'true';

let cache: { at: number; raw: any[]; capped: boolean } | null = null;
const PAGE = 100, MAX = 10000, PARALLEL = 5;
/** Every job in Crelate (paged, a few pages at a time), cached for 10 minutes. */
export async function allJobs(): Promise<{ raw: any[]; capped: boolean }> {
  if (cache && Date.now() - cache.at < 10 * 60 * 1000) return cache;
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

/** Published jobs, public fields only. */
export async function publicJobs(): Promise<PublicJob[]> {
  return (await allJobs()).raw.filter(isPublished).map(toPublicJob);
}

const slugify = (s: string) => s.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70);

/** The job's page on this site. */
export const jobPath = (j: PublicJob) => `/careers/jobs/${slugify(j.title) || 'job'}-${j.id}`;

/** Find a job from its page address (the Crelate Id is at the end). */
export async function findJob(param: string): Promise<PublicJob | undefined> {
  const jobs = await publicJobs();
  return jobs.find((j) => j.id && param.toLowerCase().endsWith(j.id.toLowerCase()));
}
