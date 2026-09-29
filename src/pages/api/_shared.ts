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
