// Location helpers for the careers job search: turns ZIP codes and
// "City, ST" into coordinates using the bundled `zipcodes` database (no
// outside service), and measures distance in miles.
import zipcodes from 'zipcodes';

export interface Point { lat: number; lon: number; label: string }


/** Resolve a ZIP code or "City, ST" / "City ST" to a point. */
export function resolveLocation(input: string): Point | null {
  const q = input.trim();
  if (!q) return null;
  const zip = q.match(/\b(\d{5})\b/);
  if (zip) {
    const z = zipcodes.lookup(zip[1]);
    return z ? { lat: z.latitude, lon: z.longitude, label: `${z.city}, ${z.state} ${z.zip}` } : null;
  }
  const m = q.match(/^(.+?)[,\s]+([A-Za-z]{2})$/);
  if (m) {
    const [, city, st] = m;
    const hit = zipcodes.lookupByName(city.trim(), st.toUpperCase())[0];
    if (hit) return { lat: hit.latitude, lon: hit.longitude, label: `${hit.city}, ${hit.state}` };
  }
  return null;
}

/** Coordinates for a job from its portal ZIP, or its city and state. */
export function jobPoint(zip: string, city: string, state: string): Point | null {
  if (/^\d{5}$/.test(zip)) {
    const z = zipcodes.lookup(zip);
    if (z) return { lat: z.latitude, lon: z.longitude, label: `${z.city}, ${z.state}` };
  }
  if (city && state && state.length === 2) return resolveLocation(`${city}, ${state}`);
  return null;
}

/** Great-circle distance in miles. */
export function miles(a: Point, b: Point): number {
  const R = 3958.8, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export const isRemote = (...parts: string[]) => parts.some((p) => /\bremote\b/i.test(p));
