// Server-only helper for the Crelate API (ATS + CRM). Used by the endpoints in
// src/pages/api/. Never import this from a page or browser script: it reads the
// API key, which must stay on the server.
//
// Configuration (Vercel → Settings → Environment Variables):
//   CRELATE_API_KEY   required; from Crelate → Settings → Your Settings & Preferences → API Key
//   CRELATE_API_BASE  optional; defaults to https://app.crelate.com/api3
//
// Crelate passes the key as the `api_key` query parameter. Field names below
// follow Crelate's API3 (firstName, lastName, email, companyName, notes with
// contactId/candidateId). If Crelate rejects a field, the error is logged in
// Vercel → Deployments → Functions/Logs; adjust the mapping here.

const base = () => (process.env.CRELATE_API_BASE || 'https://app.crelate.com/api3').replace(/\/$/, '');
export const isConfigured = () => Boolean(process.env.CRELATE_API_KEY);

export class CrelateError extends Error {
  constructor(public status: number, public detail: string) {
    super(`Crelate responded ${status}`);
  }
}

export async function crelate<T = unknown>(
  path: string,
  { method = 'GET', params = {}, body }: { method?: string; params?: Record<string, string | number>; body?: unknown } = {},
): Promise<T> {
  const url = new URL(`${base()}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set('api_key', process.env.CRELATE_API_KEY ?? '');
  const res = await fetch(url, {
    method,
    headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new CrelateError(res.status, text.slice(0, 500));
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

/** Pull a record ID out of Crelate's response, whatever its casing/wrapping. */
export function idOf(r: any): string | undefined {
  return r?.Data?.Id ?? r?.data?.id ?? r?.Data?.id ?? r?.data?.Id ?? r?.Id ?? r?.id ?? (typeof r === 'string' ? r : undefined);
}
