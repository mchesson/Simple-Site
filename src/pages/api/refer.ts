// POST /api/refer: the Refer Someone form (/refer). Anyone (a contractor with
// us now, a former contractor, a client, anyone else) recommends a person.
// 1. Emails the referral to the team inbox (src/mail.ts), resume attached.
// 2. Also files it in Crelate, when the key is set: the referred person as a
//    candidate (resume uploaded if given) with a note saying who referred
//    them and how they know us. Crelate has no referral record we can link,
//    so the referrer lives in the note.
// 3. Sends it to TS Workspace (src/ats.ts) as type "referral", alongside
//    Crelate, where it shows under Applicants with "Referred by". A referral
//    from a job page ("Refer Them", /refer?job=<id>) carries that job, so TS
//    Workspace can send it to the job's recruiter.
// The visitor sees success if any one of them worked.
import type { APIRoute } from 'astro';
import { isConfigured, createContact, addNote, uploadResume, CrelateError } from '../../crelate';
import { mailConfigured, sendMail } from '../../mail';
import { json, readForm, clean, validEmail, back } from './_shared';
import { describeSource, sourceAttribution } from '../../source';
import { atsConfigured, sendToAts, newExternalId, type ReferrerRelationship } from '../../ats';
import { RELATIONSHIPS, linkedinUrl } from '../../referral';
import { jobPath, publicJobs } from '../../jobs';

export const prerender = false;

const OK_TYPES = /\.(pdf|docx?|rtf|txt)$/i;
const MAX_BYTES = 4 * 1024 * 1024;

const log = (step: string, e: unknown) => console.error(`[refer] ${step} failed`, e instanceof CrelateError ? `${e.status} ${e.detail}` : e);
const digits = (v: string) => v.replace(/\D/g, '').length;

export const POST: APIRoute = async ({ request }) => {
  const { data, files, isJson } = await readForm(request);
  const fail = (error: string, status: number) => (isJson ? json({ ok: false, error }, status) : back(request, 'error'));
  // Honeypot: real visitors never fill the hidden "website" field.
  if (clean(data.website)) return isJson ? json({ ok: true }) : back(request, 'sent');

  const r = {
    firstName: clean(data.refFirstName, 80),
    lastName: clean(data.refLastName, 80),
    email: clean(data.refEmail, 200),
    phone: clean(data.refPhone, 40),
    relationship: clean(data.relationship, 40) as ReferrerRelationship,
  };
  const f = {
    firstName: clean(data.firstName, 80),
    lastName: clean(data.lastName, 80),
    email: clean(data.email, 200),
    phone: clean(data.phone, 40),
    linkedin: clean(data.linkedin, 300),
    role: clean(data.role, 200),
    message: clean(data.message, 4000),
    page: clean(data.page, 300),
    jobId: clean(data.jobId, 60),
  };
  const theyKnow = ['on', 'true', 'yes'].includes(clean(data.theyKnow, 10).toLowerCase());
  const resume = files.resume;

  if (!r.firstName || !r.lastName || !validEmail(r.email)) return fail('Please add your name and a valid email.', 400);
  if (!Object.hasOwn(RELATIONSHIPS, r.relationship)) return fail('Please tell us how you know Technical Source.', 400);
  if (!f.firstName || !f.lastName) return fail('Please add the name of the person you’re referring.', 400);
  if (f.email && !validEmail(f.email)) return fail('Please check the email of the person you’re referring.', 400);
  if (!f.email && digits(f.phone) < 7) return fail('Please add an email or phone number for the person you’re referring.', 400);
  if (f.email && f.email.toLowerCase() === r.email.toLowerCase()) return fail('Please use the email of the person you’re referring, not your own.', 400);
  if (!theyKnow) return fail('Please confirm they know you’re referring them.', 400);
  if (f.linkedin && !linkedinUrl(f.linkedin)) return fail('Please check the LinkedIn address (for example linkedin.com/in/name).', 400);
  if (resume && !OK_TYPES.test(resume.name)) return fail('Please attach the resume as a PDF or Word file.', 400);
  if (resume && resume.size > MAX_BYTES) return fail('Please choose a resume under 4 MB.', 413);
  if (!mailConfigured() && !isConfigured() && !atsConfigured()) {
    console.warn('[refer] none of RESEND_API_KEY, CRELATE_API_KEY or ATS_INTAKE_KEY is set; referral not sent');
    return fail('not-configured', 503);
  }

  const linkedin = linkedinUrl(f.linkedin);
  // From a job page: only a published job counts; its public title is used.
  const job = f.jobId && isConfigured() ? await publicJobs().then((all) => all.find((j) => j.id === f.jobId), () => undefined) : undefined;
  const siteUrl = (process.env.SITE_URL || new URL(request.url).origin).replace(/\/$/, '');
  const referrer = `${r.firstName} ${r.lastName}`;
  const details = [
    `Referral: ${f.firstName} ${f.lastName}`,
    `Email: ${f.email || 'not given'}`,
    `Phone: ${f.phone || 'not given'}`,
    `LinkedIn: ${linkedin || 'not given'}`,
    `Kind of work: ${f.role || 'not given'}`,
    job ? `Referred for: ${job.title} (${siteUrl}${jobPath(job)})` : null,
    `Resume: ${resume ? resume.name : 'not attached'}`,
    '',
    `Referred by: ${referrer}`,
    `Referrer email: ${r.email}`,
    `Referrer phone: ${r.phone || 'not given'}`,
    `How they know us: ${RELATIONSHIPS[r.relationship]}`,
    'The referrer confirmed the person knows they are being referred.',
    f.page ? `Page: ${f.page}` : null,
    ...describeSource(data.source),
    '',
    f.message || '(no note)',
  ].filter((l) => l !== null).join('\n');
  const bytes = resume ? await resume.arrayBuffer() : null;
  const blob = () => new Blob([bytes!], { type: resume?.type || 'application/octet-stream' });

  const emailed = mailConfigured()
    ? await sendMail({
        subject: `Referral: ${f.firstName} ${f.lastName}${job ? ` for ${job.title}` : ''} (from ${referrer})`, text: details, replyTo: r.email,
        ...(resume && bytes && { attachments: [{ filename: resume.name, content: bytes }] }),
      }).then(() => true, (e) => (log('email', e), false))
    : false;

  // TS Workspace runs alongside Crelate, so it adds no waiting time.
  const ats = sendToAts({
    type: 'referral',
    externalId: newExternalId(),
    submittedAt: new Date().toISOString(),
    contact: { firstName: f.firstName, lastName: f.lastName, email: f.email, phone: f.phone },
    message: f.message,
    page: f.page,
    job: job ? { id: job.id, title: job.title, url: `${siteUrl}${jobPath(job)}` } : f.jobId ? { id: f.jobId } : undefined,
    referral: {
      referrer: { firstName: r.firstName, lastName: r.lastName, email: r.email, phone: r.phone },
      relationship: r.relationship,
      theyKnow: true,
      role: f.role,
      linkedin,
    },
    attribution: sourceAttribution(data.source),
  }, resume && bytes ? { file: blob(), name: resume.name } : undefined);

  let filed = false;
  if (isConfigured()) {
    try {
      const candidateId = await createContact({ firstName: f.firstName, lastName: f.lastName, email: f.email || undefined, phone: f.phone, kind: 'candidate' });
      filed = true;
      const resumeSaved = resume ? await uploadResume(candidateId, blob(), resume.name).then(() => true, (e) => (log('resume upload', e), false)) : true;
      const note = [
        `Website referral from ${referrer}`,
        resumeSaved ? null : `Resume "${resume!.name}" could not be attached automatically${emailed ? '; it was emailed to the team inbox' : ''}.`,
        '',
        details,
      ].filter((l) => l !== null).join('\n');
      await addNote(candidateId, note).catch((e) => log('note', e));
    } catch (e) {
      log('Crelate candidate', e);
    }
  }

  const sent = (await ats).ok;
  if (emailed || filed || sent) return isJson ? json({ ok: true }) : back(request, 'sent');
  return fail('send-failed', 502);
};
