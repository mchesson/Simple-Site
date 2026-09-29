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

import { toLines } from './html';
import { structurePosting } from './posting';

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
  const { facts, html: description, summary } = structurePosting(text(j.PortalDescription), title);
  return {
    id: text(j.Id),
    title,
    city: text(j.PortalCity),
    state: text(j.PortalState),
    zip: text(j.PortalZip).slice(0, 5),
    summary,
    description,
    facts,
    slug: text(j.PortalUrlSlug),
    postedOn: text(j.PortalLastPostedOn),
  };
}

// ---------------------------------------------------------------------------
// Writing to Crelate: the form endpoints use only these helpers, so the field
// mapping lives in one place. Paths come from Crelate's API description
// (/api/apply?check=1): create calls take the record as { entity: {...} },
// candidates are contacts, files are "artifacts". Field names inside `entity`
// follow Crelate's naming (as in its job records); confirm them with
// /api/apply?check=2 and the Vercel function logs, and adjust here.
// ---------------------------------------------------------------------------

const ref = (id: string, entityName: string) => ({ Id: id, EntityName: entityName });

/** The contact with this email, or create one (a client inquiry, or a
 *  candidate). Returns its Id. Reusing the existing record avoids duplicates
 *  when someone applies twice or is already in Crelate. */
export async function createContact(p: { firstName: string; lastName: string; email: string; phone?: string }): Promise<string> {
  const existing = await crelate('contacts', { params: { emails: p.email, limit: 1 } }).then(listOf, () => []);
  const found = existing[0]?.Id;
  if (found) return String(found);
  const entity = {
    FirstName: p.firstName,
    LastName: p.lastName,
    EmailAddresses_Personal: { Value: p.email, IsPrimary: true },
    ...(p.phone && { PhoneNumbers_Mobile: { Value: p.phone, IsPrimary: true } }),
  };
  const id = idOf(await crelate('contacts', { method: 'POST', body: { entity } }));
  if (!id) throw new Error('No contact Id in Crelate response');
  return id;
}

/** Add a note to a contact, optionally regarding a job. */
export async function addNote(contactId: string, body: string, jobId?: string): Promise<void> {
  await crelate('notes', {
    method: 'POST',
    body: { entity: { Display: body, ParentId: ref(contactId, 'Contacts'), ...(jobId && { RegardingId: { Id: jobId } }) } },
  });
}

// Crelate file type "Resume" (from /api/apply?check=3).
export const RESUME_ARTIFACT_TYPE_ID = '02f21b38-d26b-4971-ba80-6960aad0db08';

/** Save a resume as the contact's primary document. */
export async function uploadResume(contactId: string, file: Blob, name: string): Promise<void> {
  const form = new FormData();
  form.append('entity', JSON.stringify({ FileName: name }));
  form.append('file', file, name);
  await crelate('artifacts/primary', { method: 'POST', params: { target_entity_name: 'Contacts', target_record_id: contactId }, body: form });
}

/** Add a contact to a job's pipeline. */
export async function addToJob(jobId: string, contactId: string): Promise<void> {
  await crelate(`jobs/${jobId}/contacts`, { method: 'POST', params: { contact_ids: contactId }, body: {} });
}
