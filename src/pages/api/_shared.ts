// Shared helpers for the form endpoints.
export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/** Accepts JSON (from the page script), a multipart post with files (from the
 *  page script or a normal form post) or a normal form post (no JavaScript). */
export async function readForm(request: Request): Promise<{ data: Record<string, string>; files: Record<string, File>; isJson: boolean }> {
  const type = request.headers.get('content-type') ?? '';
  if (type.includes('application/json')) return { data: await request.json(), files: {}, isJson: true };
  const fd = await request.formData();
  const data: Record<string, string> = {};
  const files: Record<string, File> = {};
  for (const [k, v] of fd.entries()) {
    if (typeof v === 'string') data[k] = v;
    else if (v.size > 0) files[k] = v;
  }
  // The page script marks its posts so it gets JSON back instead of a redirect.
  return { data, files, isJson: request.headers.get('accept')?.includes('application/json') ?? false };
}

export const clean = (v: unknown, max = 2000) => String(v ?? '').trim().slice(0, max);
export const validEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

/** For non-JavaScript posts, send the visitor back to the page with a status flag. */
export function back(request: Request, status: 'sent' | 'error') {
  const ref = request.headers.get('referer') || '/';
  const url = new URL(ref);
  url.searchParams.set('form', status);
  return Response.redirect(url.toString(), 303);
}

/** True when the request comes from a page on this same site (the browser
 *  sends Origin with every POST from script). Other sites and scripts that
 *  don't send it are turned away. */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  let host: string;
  try { host = new URL(origin).host; } catch { return false; }
  // Host names only: behind Vercel's proxy the request may read as http.
  const own = [new URL(request.url).host, request.headers.get('x-forwarded-host'), process.env.SITE_URL && new URL(process.env.SITE_URL).host];
  return own.includes(host);
}

/** The visitor's address, as Vercel reports it. */
export const visitor = (request: Request) =>
  (request.headers.get('x-real-ip') || request.headers.get('x-forwarded-for')?.split(',')[0] || 'unknown').trim();

/** A simple per-visitor limit: at most `max` requests per `minutes`. It's kept
 *  in memory, so each server instance counts on its own; that's enough to stop
 *  one visitor from running up the bill. Returns false when over the limit. */
export function rateLimiter(max: number, minutes: number) {
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const now = Date.now(), since = now - minutes * 60_000;
    const recent = (hits.get(key) ?? []).filter((t) => t > since);
    if (hits.size > 5000) hits.clear();
    if (recent.length >= max) return (hits.set(key, recent), false);
    hits.set(key, [...recent, now]);
    return true;
  };
}
