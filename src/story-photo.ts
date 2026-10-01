// Which photo a story shows (owner, Oct 1, 2026: photos only on Insights
// stories; the rest of the site keeps its brand graphics). A story's own
// `image` (a photo id from src/data/photo-credits.ts) wins; otherwise one is
// picked from the library by industry (company news gets the team photos),
// the same one every build for the same story, so neighbouring cards tend to
// differ. Stories from TS Workspace have no image yet: if the feed ever sends
// one, pass it through storyData (src/feed.ts) as `image` and it is used here.
import { photos, type PhotoId } from './data/photo-credits';

/** Photos that fit each industry; `company` is company news and anything without an industry. */
export const storyPhotoPools: Record<string, PhotoId[]> = {
  'life-sciences': ['capsule-filling', 'process-tanks', 'engineer-tablet-plant', 'engineer-plant-floor'],
  'data-centers': ['data-center-aisle', 'fiber-patch-panel', 'electrical-testing', 'tower-cranes-dusk', 'construction-scaffolding'],
  'enterprise-technology': ['developer-workstation', 'fiber-patch-panel', 'team-working-session'],
  company: ['team-working-session', 'team-reviewing-drawings'],
};

const isPhotoId = (s: string | undefined): s is PhotoId => !!s && Object.hasOwn(photos, s);

/** Small stable hash (FNV-1a) so a story keeps its photo from build to build. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

type StoryRef = { id: string; image?: string; industry?: string };
const poolOf = (s: StoryRef) => storyPhotoPools[s.industry ?? 'company'] ?? storyPhotoPools.company;

/** One story on its own: its own photo, or its hashed pick from the industry pool. */
export function storyPhoto(story: StoryRef, avoid: ReadonlySet<string> = new Set()): PhotoId {
  if (isPhotoId(story.image)) return story.image;
  const pool = poolOf(story);
  const start = hash(story.id) % pool.length;
  for (let k = 0; k < pool.length; k++) {
    const p = pool[(start + k) % pool.length];
    if (!avoid.has(p)) return p;
  }
  return pool[start];
}

/**
 * Photos for a list of stories in the order they're shown (newest first), so
 * no card repeats the photo of the card next to it, in the full list
 * (/insights, homepage) or within its industry (industry pages).
 */
export function assignStoryPhotos(stories: StoryRef[]): Map<string, PhotoId> {
  const out = new Map<string, PhotoId>();
  let prev: PhotoId | undefined;
  const prevIn = new Map<string, PhotoId>();
  stories.forEach((s, i) => {
    const key = s.industry ?? 'company';
    // Also step past the next card's own photo (a story that names one keeps it).
    const next = stories[i + 1]?.image;
    const avoid = new Set([prev, prevIn.get(key), isPhotoId(next) ? next : undefined].filter((p): p is PhotoId => !!p));
    const photo = storyPhoto(s, avoid);
    out.set(s.id, photo);
    prev = photo;
    prevIn.set(key, photo);
  });
  return out;
}
