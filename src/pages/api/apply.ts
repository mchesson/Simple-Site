// POST /api/apply: job applications and general resume submissions from the
// site's own forms (job pages and Careers "Not Looking Right Now?").
// 1. Emails the application, resume attached, to the team inbox (src/mail.ts).
// 2. Also files it in Crelate, when the key is set: candidate, resume upload,
//    link to the job, and a note saying where it came from.
// The visitor sees success if either one worked.
//
// GET /api/apply?check=1 reads Crelate's public API description (OpenAPI) and
// lists the endpoints for candidates, notes, attachments/resumes and job
// pipelines, with their fields. No key, no candidate data. Use it to confirm
// the paths in RESUME_UPLOAD and JOB_LINK below.
import type { APIRoute } from 'astro';
import { crelate, idOf, isConfigured, CrelateError } from '../../crelate';
import { publicJobs } from '../../jobs';
import { mailConfigured, sendMail } from '../../mail';
import { json, readForm, clean, validEmail, back } from './_shared';

export const prerender = false;

// Built from Crelate's API3 conventions without access to the live API docs.
// Confirm against /api/apply?check=1 and the Vercel function logs.
const RESUME_UPLOAD = (candidateId: string) => `candidates/${candidateId}/attachments`;
const JOB_LINK = (jobId: string) => `jobs/${jobId}/contacts`;

const OK_TYPES = /\.(pdf|docx?|rtf|txt)$/i;
const MAX_BYTES = 4 * 1024 * 1024;

const log = (step: string, e: unknown) => console.error(`[apply] ${step} failed`, e instanceof CrelateError ? `${e.status} ${e.detail}` : e);

export const POST: APIRoute = async ({ request }) => {
  const { data, files, isJson } = await readForm(request);
  const fail = (error: string, status: number) => (isJson ? json({ ok: false, error }, status) : back(request, 'error'));
  if (clean(data.website)) return isJson ? json({ ok: true }) : back(request, 'sent');

  const f = {
    firstName: clean(data.firstName, 80),
    lastName: clean(data.lastName, 80),
    email: clean(data.email, 200),
    phone: clean(data.phone, 40),
    location: clean(data.location, 120),
    message: clean(data.message, 4000),
    jobId: clean(data.jobId, 60),
    page: clean(data.page, 300),
  };
  const resume = files.resume;
  if (!f.firstName || !f.lastName || !validEmail(f.email)) return fail('Please add your name and a valid email.', 400);
  if (!resume) return fail('Please attach your resume.', 400);
  if (!OK_TYPES.test(resume.name)) return fail('Please attach your resume as a PDF or Word file.', 400);
  if (resume.size > MAX_BYTES) return fail('Please choose a resume under 4 MB.', 413);
  if (!mailConfigured() && !isConfigured()) {
    console.warn('[apply] neither RESEND_API_KEY nor CRELATE_API_KEY is set; application not sent', { email: f.email });
    return fail('not-configured', 503);
  }

  // Only a published job can be applied to; its public title is used below.
  const job = f.jobId && isConfigured() ? await publicJobs().then((all) => all.find((j) => j.id === f.jobId), () => undefined) : undefined;
  const what = job ? `Application: ${job.title}` : 'Resume submission (general consideration)';
  const details = [
    what,
    `Name: ${f.firstName} ${f.lastName}`,
    `Email: ${f.email}`,
    `Phone: ${f.phone || 'not given'}`,
    `Location: ${f.location || 'not given'}`,
    f.page ? `Page: ${f.page}` : null,
    '',
    f.message || '(no message)',
  ].filter((l) => l !== null).join('\n');
  const bytes = await resume.arrayBuffer();

  const emailed = mailConfigured()
    ? await sendMail({ subject: job ? `Application from ${f.firstName} ${f.lastName}: ${job.title}` : `Resume from ${f.firstName} ${f.lastName} (general consideration)`, text: details, replyTo: f.email, attachments: [{ filename: resume.name, content: bytes }] })
        .then(() => true, (e) => (log('email', e), false))
    : false;

  let filed = false;
  if (isConfigured()) {
    try {
      const candidate = await crelate('candidates', {
        method: 'POST',
        body: { firstName: f.firstName, lastName: f.lastName, email: f.email, ...(f.phone && { phone: f.phone }) },
      });
      const candidateId = idOf(candidate);
      if (!candidateId) throw new Error('No candidate Id in Crelate response');
      filed = true;

      const upload = new FormData();
      upload.append('file', new Blob([bytes], { type: resume.type || 'application/octet-stream' }), resume.name);
      const resumeSaved = await crelate(RESUME_UPLOAD(candidateId), { method: 'POST', body: upload }).then(() => true, (e) => (log('resume upload', e), false));
      const linked = job ? await crelate(JOB_LINK(job.id), { method: 'POST', body: { contactId: candidateId } }).then(() => true, (e) => (log('job link', e), false)) : false;

      const note = [
        `Website ${what}`,
        job && !linked ? `Job Id: ${job.id} (not added to the pipeline automatically)` : null,
        resumeSaved ? null : `Resume "${resume.name}" could not be attached automatically${emailed ? '; it was emailed to the team inbox' : ''}.`,
        '',
        details,
      ].filter((l) => l !== null).join('\n');
      await crelate('notes', { method: 'POST', body: { body: note, candidateId, ...(job && { jobId: job.id }) } }).catch((e) => log('note', e));
    } catch (e) {
      log('Crelate candidate', e);
    }
  }

  if (emailed || filed) return isJson ? json({ ok: true }) : back(request, 'sent');
  return fail('send-failed', 502);
};

export const GET: APIRoute = async ({ url }) => {
  if (url.searchParams.get('check') !== '1') return json({ ok: false }, 404);
  const base = (process.env.CRELATE_API_BASE || 'https://app.crelate.com/api3').replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/docs/v3/crelate-openapi.json`);
    const spec: any = await res.json();
    const ref = (s: any): any => (s?.$ref ? s.$ref.split('/').slice(1).reduce((o: any, k: string) => o?.[k], spec) : s);
    const fields = (s: any) => {
      const r = ref(s?.items ? s.items : s);
      return r?.properties ? Object.keys(r.properties) : r?.type ?? null;
    };
    const wanted = /attach|resume|artifact|document|file|upload|application|pipeline|(candidates|contacts)($|\/\{[^}]+\}$)|notes$|jobs\/\{[^}]+\}\/(contacts|candidates)/i;
    const paths = Object.entries(spec.paths ?? {})
      .filter(([p]) => wanted.test(p))
      .map(([p, ops]: [string, any]) => ({
        path: p,
        ops: Object.entries(ops)
          .filter(([m]) => ['get', 'post', 'put', 'patch'].includes(m))
          .map(([m, op]: [string, any]) => ({
            method: m.toUpperCase(),
            summary: op.summary ?? '',
            params: (op.parameters ?? []).map((x: any) => ref(x)?.name).filter(Boolean),
            body: Object.fromEntries(Object.entries(op.requestBody?.content ?? {}).map(([t, c]: [string, any]) => [t, fields(c.schema)])),
          })),
      }));
    return json({ ok: true, status: res.status, count: paths.length, paths });
  } catch (e) {
    return json({ ok: false, error: String(e) });
  }
};
