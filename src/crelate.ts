// Server-only helper for the Crelate API (ATS + CRM). Used by the endpoints in
// src/pages/api/. Never import this from a page or browser script: it reads the
// API key, which must stay on the server.
//
// Configuration (Vercel → Settings → Environment Variables):
//   CRELATE_API_KEY   required; from Crelate → Settings → Your Settings & Preferences → API Key
//   CRELATE_API_BASE  optional; defaults to https://app.crelate.com/api3
//
// The key is sent in the X-Api-Key header, never in the URL. Field names below
// follow Crelate's API3 (firstName, lastName, email, companyName, notes with
// contactId/candidateId). If Crelate rejects a field, the error is logged in
// Vercel → Deployments → Functions/Logs; adjust the mapping here.

import { toLines } from './html';
import { structurePosting } from './posting';

const base = () => (process.env.CRELATE_API_BASE || 'https://app.crelate.com/api3').replace(/\/$/, '');
export const isConfigured = () => Boolean(process.env.CRELATE_API_KEY);

/** Strip anything key-like from text before it is logged. */
const redact = (s: string) => {
  const key = process.env.CRELATE_API_KEY;
  return (key ? s.split(key).join('[key]') : s).replace(/api_key=[^&"\s]*/gi, 'api_key=[key]');
};

/** Crelate's own error messages (from its Errors array), without the request address. */
export const crelateMessage = (e: unknown) => {
  if (!(e instanceof CrelateError)) return 'request failed';
  try {
    const msgs = (JSON.parse(e.detail)?.Errors ?? []).map((x: any) => String(x?.Message ?? '')).filter(Boolean);
    return `${e.status}${msgs.length ? ': ' + msgs.join('; ') : ''}`;
  } catch {
    return String(e.status);
  }
};

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
  // The key goes only in the X-Api-Key header (as Crelate's API docs say),
  // never in the address: Crelate repeats the address in its error messages.
  const res = await fetch(url, {
    method,
    // FormData (file uploads) sets its own multipart Content-Type.
    headers: {
      Accept: 'application/json',
      'X-Api-Key': process.env.CRELATE_API_KEY ?? '',
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new CrelateError(res.status, redact(text).slice(0, 500));
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

/** Pull a record ID out of Crelate's response, whatever its casing/wrapping. */
export function idOf(r: any): string | undefined {
  // Create calls answer { Data: "<new id>", Errors: [], Metadata: {...} }.
  if (typeof r?.Data === 'string' && r.Data) return r.Data;
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
// out; add a field only if it's part of the public portal posting. Job type
// titles (JobTypeIds, e.g. "Contract") are also used: they name no one.
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
  /** Short line under the title at the top of some postings. */
  subtitle: string;
  /** "Location", "Type", "Duration"... lines from the top of the posting. */
  facts: { label: string; value: string }[];
  slug: string;
  postedOn: string;
}

/** Map a Crelate job to its public portal posting (allowlisted fields only). */
// A length of time ("12 month", "6-9 months", "2+ years", "long-term") or an extension.
const DURATION_WORDS = /\b\d+\s*(?:[-–to]+\s*\d+\s*)?\+?\s*-?\s*(?:months?|mos?|weeks?|wks?|years?|yrs?|days?)\b|\b(?:long|short)[- ]term\b|\bextension\b/i;
// Job types in the words recruiters use, as the site shows them.
const JOB_TYPES: [RegExp, string][] = [
  [/contract[- ]to[- ]hire|temp[- ]to[- ]perm|contract[- ]to[- ]perm/i, 'Contract to Hire'],
  [/direct[- ]hire/i, 'Direct Hire'],
  [/\bpermanent\b|\bperm\b/i, 'Permanent'],
  [/\bcontract(or)?\b/i, 'Contract'],
  [/\btemp(orary)?\b/i, 'Temporary'],
  [/full[- ]time/i, 'Full-Time'],
  [/part[- ]time/i, 'Part-Time'],
];
/** "12 Month Contract with potential extension" → "Contract". */
function jobTypeOf(s: string): string {
  const found: string[] = [];
  let rest = s;
  for (const [re, name] of JOB_TYPES) if (re.test(rest)) { found.push(name); rest = rest.replace(re, ' '); }
  return found.join(' · ');
}

export function toPublicJob(j: any): PublicJob {
  const title = toLines(text(j.PortalTitle)).join(' ');
  const { facts: fromText, html: description, summary, subtitle } = structurePosting(text(j.PortalDescription), title);
  // Every job shows the same row: what the posting says, filled in from
  // Crelate's own fields where it says nothing (location, job type).
  const city = text(j.PortalCity), state = text(j.PortalState);
  const remote = /\bremote\b/i.test(`${title} ${city}`);
  const jobTypes = (Array.isArray(j.JobTypeIds) ? j.JobTypeIds : []).map((x: any) => text(x?.Title)).filter(Boolean).join(' · ');
  const fallback: Record<string, string> = { Location: remote ? 'Remote' : [city, state].filter(Boolean).join(', '), 'Job Type': jobTypes };
  // All three labels always show, so every job page looks the same; a detail
  // nobody entered is left blank (owner's choice).
  const facts = ['Location', 'Job Type', 'Duration'].map(
    (label) => fromText.find((f) => f.label === label) ?? { label, value: fallback[label] || '' },
  );
  // "Job Type: 12 Month Contract with potential extension" holds a duration:
  // Job Type shows the type ("Contract"), Duration the whole phrase.
  const [, typeFact, durationFact] = facts;
  if (DURATION_WORDS.test(typeFact.value)) {
    if (!durationFact.value) durationFact.value = typeFact.value;
    typeFact.value = jobTypeOf(typeFact.value) || jobTypeOf(jobTypes) || jobTypes;
  }
  return {
    id: text(j.Id),
    title,
    city: text(j.PortalCity),
    state: text(j.PortalState),
    zip: text(j.PortalZip).slice(0, 5),
    summary,
    subtitle,
    description,
    facts,
    slug: text(j.PortalUrlSlug),
    postedOn: text(j.PortalLastPostedOn),
  };
}

// ---------------------------------------------------------------------------
// Writing to Crelate: the form endpoints use only these helpers, so the field
// mapping lives in one place. Checked against Crelate's API description
// (https://app.crelate.com/api3/docs/v3/crelate-openapi.json):
//   - create calls send { entity: {...} } and answer { Data: "<new id>" }
//   - candidates are contacts; RecordType is a bitmask: 1 Candidate, 2 Client Contact
//   - email/phone fields are single { Value, IsPrimary } objects
//   - lookups are { Id }; "any"-type lookups (a note's ParentId) add EntityName
//   - resumes: POST /artifacts/primary?target_entity_name=&target_record_id=
//     with the file (the primary Artifact Type is assigned automatically)
//   - job pipeline: POST /jobs/{jobId}/contacts?contact_ids= with a stage
//     (statusName or statusId) from the Recruiting workflow
//   - applications: POST /jobs/{jobId}/apply, multipart with "applicant" as a
//     JSON text field and the resume as "resumeFile" (checked against the live
//     account with scripts/crelate-live-test.mjs: a JSON part answers 500,
//     other file field names answer "A resume is required")
// ---------------------------------------------------------------------------

export const RECORD_TYPE = { candidate: 1, client: 2 } as const;
const RECRUITING_WORKFLOW = 'F6EF012F-998D-4132-B38B-A17A00B2B958';
/** Pipeline stage for website applicants (owner's choice). If it's renamed in
 *  Crelate, the first Recruiting stage is used instead. */
export const APPLY_STAGE = 'Maybe';

const hourly = <T>(load: () => Promise<T>) => {
  let cache: { at: number; value: T } | null = null;
  return async () => {
    if (!cache || Date.now() - cache.at > 60 * 60 * 1000) cache = { at: Date.now(), value: await load() };
    return cache.value;
  };
};

/** Crelate contact source named like "Website" (e.g. "Company Website"), if one exists. */
const websiteSourceId = hourly(async (): Promise<string | null> => {
  const sources = await crelate('contactsources', { params: { limit: 100 } }).then(listOf, () => []);
  const name = (s: any) => String(s?.Name ?? '').trim();
  // Only a source really named for the website: a loose match picked up
  // "CareerBuilderSearch" (checked in the live Crelate account).
  const hit = sources.find((s) => /^(company )?web ?site$/i.test(name(s))) ?? sources.find((s) => /\bweb ?site\b/i.test(name(s)));
  return hit?.Id ? String(hit.Id) : null;
});

/** Recruiting pipeline stages in order. */
export const recruitingStages = hourly(async (): Promise<{ id: string; name: string; order: number }[]> => {
  const all = await crelate('workflowstatuses', { params: { workflow_type_ids: RECRUITING_WORKFLOW, limit: 100 } }).then(listOf, () => []);
  return all
    .map((s: any) => ({ id: String(s?.Id ?? ''), name: String(s?.Name ?? ''), order: Number(s?.SortOrder ?? 0) }))
    .filter((s) => s.id && s.name)
    .sort((a, b) => a.order - b.order);
});

/** The contact with this email, or a new one (a client inquiry, or a
 *  candidate). Returns its Id. Reusing the existing record avoids duplicates
 *  when someone applies twice or is already in Crelate; an existing contact
 *  who applies for a job is also marked as a candidate. */
/**
 * A phone Crelate will accept: +1 and 10 digits for a US number. Crelate
 * refuses anything else (e.g. a mistyped 11-digit number), and that refusal
 * used to lose the whole application in Crelate, so an unreadable number is
 * left out here (the team email and TS Workspace still get it as typed).
 */
export function crelatePhone(v?: string): string | undefined {
  const d = String(v ?? '').replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return undefined;
}

export async function createContact(p: { firstName: string; lastName: string; email?: string; phone?: string; kind: 'candidate' | 'client' }): Promise<string> {
  const bit = RECORD_TYPE[p.kind];
  // Without an email (a referral may give only a phone) there's nothing safe to match on: always a new contact.
  const existing = p.email ? (await crelate('contacts', { params: { emails: p.email, limit: 1 } }).then(listOf, () => []))[0] : undefined;
  if (existing?.Id) {
    const type = Number(existing.RecordType ?? 0);
    if (!(type & bit)) {
      await crelate(`contacts/${existing.Id}`, { method: 'PATCH', body: { entity: { RecordType: type | bit } } }).catch((e) =>
        console.warn('[crelate] could not add record type to existing contact', e instanceof CrelateError ? `${e.status} ${e.detail}` : e),
      );
    }
    return String(existing.Id);
  }
  const sourceId = await websiteSourceId().catch(() => null);
  const entity = {
    FirstName: p.firstName,
    LastName: p.lastName,
    RecordType: bit,
    ...(p.email && { EmailAddresses_Personal: { Value: p.email, IsPrimary: true } }),
    ...(crelatePhone(p.phone) && { PhoneNumbers_Mobile: { Value: crelatePhone(p.phone), IsPrimary: true } }),
    ...(sourceId && { ContactSourceId: { Id: sourceId } }),
  };
  const id = idOf(await crelate('contacts', { method: 'POST', body: { entity } }));
  if (!id) throw new Error('No contact Id in Crelate response');
  return id;
}

/** Apply to a job the way Crelate's own job portal does. Depending on
 *  Crelate's settings the application waits in Recruiting Intake or is
 *  approved straight away into a contact (returned when it is). */
export async function applyToJob(jobId: string, p: { firstName: string; lastName: string; email: string; phone?: string }, file: Blob, fileName: string): Promise<{ applicationId: string; contactId?: string }> {
  const sourceId = await websiteSourceId().catch(() => null);
  const applicant = {
    FirstName: p.firstName,
    LastName: p.lastName,
    Email_Personal: p.email,
    ...(crelatePhone(p.phone) && { Phone_Mobile: crelatePhone(p.phone) }),
    ...(sourceId && { ContactSourceId: { Id: sourceId } }),
  };
  const form = new FormData();
  form.append('applicant', JSON.stringify(applicant));
  form.append('resumeFile', file, fileName);
  const applicationId = idOf(await crelate(`jobs/${jobId}/apply`, { method: 'POST', body: form }));
  if (!applicationId || typeof applicationId !== 'string') throw new Error('No application Id in Crelate response');
  const app: any = await crelate(`applications/${applicationId}`).catch(() => null);
  const contactId = app?.Data?.ContactId?.Id;
  return { applicationId, ...(contactId && { contactId: String(contactId) }) };
}

/** Add a note to a contact, optionally regarding a job. */
export async function addNote(contactId: string, body: string, jobId?: string): Promise<void> {
  await crelate('notes', {
    method: 'POST',
    body: { entity: { Display: body, ParentId: { Id: contactId, EntityName: 'Contacts' }, ...(jobId && { RegardingId: { Id: jobId } }) } },
  });
}

/** Save a resume as the contact's primary document. */
export async function uploadResume(contactId: string, file: Blob, name: string): Promise<void> {
  const form = new FormData();
  form.append('file', file, name);
  await crelate('artifacts/primary', { method: 'POST', params: { target_entity_name: 'Contacts', target_record_id: contactId }, body: form });
}

/** Add a contact to a job's pipeline at the website-applicant stage. */
export async function addToJob(jobId: string, contactId: string): Promise<void> {
  const stages = await recruitingStages();
  const stage = (APPLY_STAGE && stages.find((s) => s.name.toLowerCase() === APPLY_STAGE.toLowerCase())) || stages[0];
  const body = stage ? { statusId: stage.id } : { statusName: APPLY_STAGE || 'Applied' };
  await crelate(`jobs/${jobId}/contacts`, { method: 'POST', params: { contact_ids: contactId }, body });
}
