// Shared helpers for the form endpoints.
export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

/** Accepts JSON (from the page script) or a normal form post (no JavaScript). */
export async function readForm(request: Request): Promise<{ data: Record<string, string>; isJson: boolean }> {
  const type = request.headers.get('content-type') ?? '';
  if (type.includes('application/json')) return { data: await request.json(), isJson: true };
  const fd = await request.formData();
  return { data: Object.fromEntries([...fd.entries()].map(([k, v]) => [k, String(v)])), isJson: false };
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
