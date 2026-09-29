// POST /api/apply: job applications and general resume submissions from the
// site's own forms (job pages and Careers "Not Looking Right Now?").
// 1. Emails the application, resume attached, to the team inbox (src/mail.ts).
// 2. Also files it in Crelate, when the key is set: candidate, resume upload,
//    link to the job, and a note saying where it came from.
// The visitor sees success if either one worked.
//
// Diagnostics (no candidate data):
//   GET /api/apply?check=1  Crelate settings the forms use: pipeline stages,
//                           contact sources, file types, note parent types
import type { APIRoute } from 'astro';
import { crelate, isConfigured, listOf, createContact, addNote, uploadResume, addToJob, recruitingStages, APPLY_STAGE, CrelateError } from '../../crelate';
import { publicJobs } from '../../jobs';
import { mailConfigured, sendMail } from '../../mail';
import { json, readForm, clean, validEmail, back } from './_shared';

export const prerender = false;

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
      const candidateId = await createContact({ firstName: f.firstName, lastName: f.lastName, email: f.email, phone: f.phone, kind: 'candidate' });
      filed = true;

      const resumeSaved = await uploadResume(candidateId, new Blob([bytes], { type: resume.type || 'application/octet-stream' }), resume.name).then(() => true, (e) => (log('resume upload', e), false));
      const linked = job ? await addToJob(job.id, candidateId).then(() => true, (e) => (log('job link', e), false)) : false;

      const note = [
        `Website ${what}`,
        job && !linked ? `Job Id: ${job.id} (not added to the pipeline automatically)` : null,
        resumeSaved ? null : `Resume "${resume.name}" could not be attached automatically${emailed ? '; it was emailed to the team inbox' : ''}.`,
        '',
        details,
      ].filter((l) => l !== null).join('\n');
      await addNote(candidateId, note, job?.id).catch((e) => log('note', e));
    } catch (e) {
      log('Crelate candidate', e);
    }
  }

  if (emailed || filed) return isJson ? json({ ok: true }) : back(request, 'sent');
  return fail('send-failed', 502);
};

export const GET: APIRoute = async ({ url }) => {
  const check = url.searchParams.get('check');
  if (check !== '1') return json({ ok: false, error: 'unknown-check', got: check }, 404);
  if (!isConfigured()) return json({ ok: false, error: 'not-configured' });
  // Crelate settings the forms rely on: pipeline stages, contact sources,
  // file types, and the record types a note can belong to. No contact data.
  const safe = <T>(p: Promise<T>) => p.catch((e) => ({ error: e instanceof CrelateError ? `${e.status} ${e.detail}` : String(e) }));
  const [stages, sources, types, activityInfo] = await Promise.all([
    safe(recruitingStages()),
    safe(crelate('contactsources', { params: { limit: 200 } }).then(listOf)),
    safe(crelate('artifacttypes', { params: { limit: 100 } }).then(listOf)),
    safe(crelate('activities/info')),
  ]);
  const find = (o: any, name: string, depth = 0): any => {
    if (!o || typeof o !== 'object' || depth > 8) return null;
    if (o.Name === name || o.FieldName === name) return o;
    for (const v of Object.values(o)) { const hit = find(v, name, depth + 1); if (hit) return hit; }
    return null;
  };
  const names = (list: any) => (Array.isArray(list) ? list.map((x: any) => ({ id: x?.Id, name: x?.Name })) : list);
  return json({
    ok: true,
    stageUsed: APPLY_STAGE || (Array.isArray(stages) ? stages[0]?.name : null),
    recruitingStages: stages,
    contactSources: names(sources),
    fileTypes: names(types),
    noteParent: find(activityInfo, 'ParentId'),
  }, 200, { 'Cache-Control': 'no-store' });
};
