// Server-only: sends every website submission to TS Workspace, the company's
// own ATS/CRM (repo mchesson/ts-ats, format in its docs/website-intake.md).
// It's one more destination next to the team email and Crelate: a failure
// here never reaches the visitor, and nothing here ever throws.
//
// Configuration (Vercel → Settings → Environment Variables):
//   ATS_INTAKE_URL  https://tsworkspace.com/api/intake
//   ATS_INTAKE_KEY  same value as INTAKE_API_KEY in the ATS project (sensitive)
// Without either one, submissions simply aren't sent there.
//
// The key goes only in the Authorization header. Logs show the status and
// the lead id, never the key or the visitor's details.
import { randomUUID } from 'node:crypto';
import type { Attribution } from './source';

export type AtsType = 'inquiry' | 'application' | 'resume' | 'chat';
export type AtsPayload = {
  type: AtsType;
  externalId: string;
  submittedAt: string;
  contact: { firstName: string; lastName: string; email: string; phone?: string; company?: string; location?: string };
  industry?: string;
  service?: string;
  message?: string;
  job?: { id: string; title?: string; url?: string };
  jobSeeker?: boolean;
  transcript?: { role: 'user' | 'assistant'; text: string }[];
  page?: string;
  attribution?: Attribution;
};
export type AtsResult = { ok: boolean; id?: string; duplicate?: boolean; error?: string; skipped?: boolean };

const TIMEOUT_MS = 8000;
export const atsSettings = () => ({ url: Boolean(process.env.ATS_INTAKE_URL), key: Boolean(process.env.ATS_INTAKE_KEY) });
export const atsConfigured = () => Boolean(process.env.ATS_INTAKE_URL && process.env.ATS_INTAKE_KEY);

/** A new id for one submission, so the ATS never files the same one twice. */
export const newExternalId = () => `web-${randomUUID()}`;

/** Drops empty strings, empty objects and undefined, so only real values go. */
function compact<T>(v: T): T {
  if (Array.isArray(v)) return v.map(compact) as T;
  if (!v || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    const c = compact(x);
    if (c === undefined || c === '' || (c && typeof c === 'object' && !Array.isArray(c) && !Object.keys(c).length)) continue;
    out[k] = c;
  }
  return out as T;
}

let warned = false;

export async function sendToAts(payload: AtsPayload, resume?: { file: Blob; name: string }): Promise<AtsResult> {
  const url = process.env.ATS_INTAKE_URL, key = process.env.ATS_INTAKE_KEY;
  if (!url || !key) {
    if (!warned) console.warn('[ats] ATS_INTAKE_URL or ATS_INTAKE_KEY is not set; submissions are not sent to TS Workspace');
    warned = true;
    return { ok: false, skipped: true, error: 'not-configured' };
  }
  const tag = `[ats] ${payload.type}`;
  try {
    const data = JSON.stringify(compact(payload));
    let body: BodyInit;
    const headers: Record<string, string> = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
    if (resume) {
      const fd = new FormData();
      fd.set('data', data);
      fd.set('resume', resume.file, resume.name);
      body = fd; // fetch sets the multipart Content-Type
    } else {
      body = data;
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const out: any = await res.json().catch(() => ({}));
    if (!res.ok || out?.ok === false) {
      const error = res.status === 401 ? 'unauthorized' : typeof out?.error === 'string' ? out.error.slice(0, 200) : `status ${res.status}`;
      console.error(`${tag} failed`, res.status, error);
      return { ok: false, error };
    }
    console.log(`${tag} sent`, res.status, out?.id ?? '', out?.duplicate ? '(duplicate)' : '');
    return { ok: true, id: typeof out?.id === 'string' ? out.id : undefined, duplicate: Boolean(out?.duplicate) };
  } catch (e) {
    const error = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'network error';
    console.error(`${tag} failed`, error);
    return { ok: false, error };
  }
}

/** Connection test for /api/apply?check=2: the ATS answers GET with the key. */
export async function pingAts(): Promise<{ ok: boolean; status?: number; error?: string }> {
  if (!atsConfigured()) return { ok: false, error: 'not-configured' };
  try {
    const res = await fetch(process.env.ATS_INTAKE_URL!, { headers: { Authorization: `Bearer ${process.env.ATS_INTAKE_KEY}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, error: 'network error' };
  }
}
