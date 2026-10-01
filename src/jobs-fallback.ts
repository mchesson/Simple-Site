// When Crelate can't be read (Oct 1, 2026: Crelate turned the API user off and
// the careers page fell back to Crelate's own portal), the site keeps showing
// the last list it read: first the one this server read itself, then the
// snapshot saved when the site was last built (/jobs-snapshot.json, public
// posting fields only). Applications still reach email and TS Workspace.
import type { PublicJob } from './crelate';

export type Saved = { at: string; jobs: PublicJob[] };

/** A snapshot as read from /jobs-snapshot.json, or null when it isn't one. */
export function parseSnapshot(x: unknown): Saved | null {
  const s = x as Partial<Saved> | null;
  if (!s || typeof s.at !== 'string' || !Array.isArray(s.jobs)) return null;
  const jobs = s.jobs.filter((j): j is PublicJob => Boolean(j && typeof j.id === 'string' && typeof j.title === 'string' && j.title));
  return jobs.length ? { at: s.at, jobs } : null;
}

/**
 * Read the jobs; if that fails, use what was saved (newest first). Throws
 * the original error only when nothing was ever saved.
 */
export async function withFallback(
  read: () => Promise<PublicJob[]>,
  saved: { memory: () => Saved | null; remember: (s: Saved) => void; snapshot: () => Promise<Saved | null> },
  now = () => new Date().toISOString(),
): Promise<{ jobs: PublicJob[]; savedAt: string | null }> {
  try {
    const jobs = await read();
    saved.remember({ at: now(), jobs });
    return { jobs, savedAt: null };
  } catch (e) {
    const fb = saved.memory() ?? (await saved.snapshot().catch(() => null));
    if (fb) {
      console.error(`[jobs] Crelate unavailable; showing the list saved ${fb.at}`);
      return { jobs: fb.jobs, savedAt: fb.at };
    }
    throw e;
  }
}
