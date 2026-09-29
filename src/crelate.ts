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

import { cleanHtml, toLines, tidyPosting, splitFacts } from './html';

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
    // FormData (file uploads) sets its own multipart Content-Type.
    headers: { Accept: 'application/json', ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
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

/** Unwrap a list response into an array. */
export function listOf(r: any): any[] {
  if (Array.isArray(r)) return r;
  for (const k of ['Data', 'data', 'Results', 'results', 'items', 'Items']) if (Array.isArray(r?.[k])) return r[k];
  return [];
}

// ---------------------------------------------------------------------------
// Jobs: PUBLIC PORTAL FIELDS ONLY.
// Crelate's internal job fields (Name, Description, PortalCompanyName, contacts,
// recruiter/owner IDs, rates...) can contain client and recruiter names and must
// never reach the website. The allowlist below is the only way job data gets
// out; add a field only if it's part of the public portal posting.
// ---------------------------------------------------------------------------

const text = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const truthy = (v: unknown) => v === true || v === 'true' || v === 1 || v === '1';

/** Only jobs that are live on the job portal. */
export function isPublished(j: any): boolean {
  if (!truthy(j?.OnPortal)) return false;
  if (truthy(j?.IsHidden) || truthy(j?.IsOnHold) || j?.ClosedOn) return false;
  const vis = text(j?.PortalVisibility).toLowerCase();
  if (vis && /private|internal|hidden|none|off/.test(vis)) return false;
  return Boolean(text(j?.PortalTitle));
}

// Short teaser for the job list: skips a repeated title and "Location: ... /
// Type: ..." lines and short headings ("About the Role"), which the list
// doesn't need.
const summarize = (html: string, title: string) => {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const lines = toLines(html).filter((l) => norm(l) !== norm(title) && !norm(l).startsWith(norm(title) + ' ') && !/^[\w /&()-]{2,30}:\s*\S.{0,80}$/.test(l) && !/^[\w /&()-]{2,30}:$/.test(l) && !(l.length < 40 && !/[.!?]$/.test(l)));
  const t = lines.join(' ').trim();
  return t.length > 220 ? t.slice(0, 217).replace(/\s+\S*$/, '') + '…' : t;
};

// Many postings repeat the job title as their first line; the page shows it already.
const dropTitle = (html: string, title: string) => {
  const m = html.match(/^<(p|h2|h3)>([\s\S]*?)<\/\1>/);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return m && norm(toLines(m[2]).join(' ')) === norm(title) ? html.slice(m[0].length).trim() : html;
};

export interface PublicJob {
  id: string;
  title: string;
  city: string;
  state: string;
  zip: string;
  summary: string;
  /** Full posting, cleaned to plain tags (see src/html.ts), without its facts. */
  description: string;
  /** "Location", "Type", "Duration"... lines from the top of the posting. */
  facts: { label: string; value: string }[];
  slug: string;
  postedOn: string;
}

/** Map a Crelate job to its public portal posting (allowlisted fields only). */
export function toPublicJob(j: any): PublicJob {
  const title = toLines(text(j.PortalTitle)).join(' ');
  const { facts, html: description } = splitFacts(tidyPosting(dropTitle(cleanHtml(text(j.PortalDescription)), title)));
  return {
    id: text(j.Id),
    title,
    city: text(j.PortalCity),
    state: text(j.PortalState),
    zip: text(j.PortalZip).slice(0, 5),
    summary: summarize(text(j.PortalDescription), title),
    description,
    facts,
    slug: text(j.PortalUrlSlug),
    postedOn: text(j.PortalLastPostedOn),
  };
}
