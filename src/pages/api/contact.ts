// POST /api/contact: "Tell us about your project" form.
// 1. Emails the inquiry to the team inbox (src/mail.ts): the main delivery.
// 2. Also files it in Crelate as a contact + note, when the key is set, and
//    sends it to TS Workspace (src/ats.ts) at the same time.
// The visitor sees success if any one of them worked.
import type { APIRoute } from 'astro';
import { isConfigured, createContact, addNote, CrelateError } from '../../crelate';
import { mailConfigured, sendMail } from '../../mail';
import { json, readForm, clean, validEmail, back } from './_shared';
import { describeSource, sourceAttribution } from '../../source';
import { atsConfigured, sendToAts, newExternalId } from '../../ats';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const { data, isJson } = await readForm(request);
  // Honeypot: real visitors never fill the hidden "website" field.
  if (clean(data.website)) return isJson ? json({ ok: true }) : back(request, 'sent');

  const f = {
    firstName: clean(data.firstName, 80),
    lastName: clean(data.lastName, 80),
    email: clean(data.email, 200),
    company: clean(data.company, 200),
    industry: clean(data.industry, 80),
    service: clean(data.service, 80),
    message: clean(data.message, 4000),
    page: clean(data.page, 300),
  };
  if (!f.firstName || !f.lastName || !validEmail(f.email)) {
    return isJson ? json({ ok: false, error: 'Please add your name and a valid email.' }, 400) : back(request, 'error');
  }
  if (!mailConfigured() && !isConfigured() && !atsConfigured()) {
    console.warn('[contact] none of RESEND_API_KEY, CRELATE_API_KEY or ATS_INTAKE_KEY is set; submission not sent', { email: f.email });
    return isJson ? json({ ok: false, error: 'not-configured' }, 503) : back(request, 'error');
  }

  const details = [
    `Name: ${f.firstName} ${f.lastName}`,
    `Email: ${f.email}`,
    `Company: ${f.company || 'not given'}`,
    `Industry: ${f.industry || 'not given'}`,
    `How can we help: ${f.service || 'not given'}`,
    f.page ? `Page: ${f.page}` : null,
    ...describeSource(data.source),
    '',
    f.message || '(no message)',
  ].filter((l) => l !== null).join('\n');

  const emailed = mailConfigured()
    ? await sendMail({ subject: `Website inquiry: ${f.firstName} ${f.lastName}${f.company ? `, ${f.company}` : ''}`, text: details, replyTo: f.email })
        .then(() => true, (e) => (console.error('[contact] email failed', e), false))
    : false;

  // TS Workspace runs alongside Crelate, so it adds no waiting time.
  const ats = sendToAts({
    type: 'inquiry',
    externalId: newExternalId(),
    submittedAt: new Date().toISOString(),
    contact: { firstName: f.firstName, lastName: f.lastName, email: f.email, company: f.company },
    industry: f.industry,
    service: f.service,
    message: f.message,
    page: f.page,
    attribution: sourceAttribution(data.source),
  });

  let filed = false;
  if (isConfigured()) {
    try {
      const contactId = await createContact({ firstName: f.firstName, lastName: f.lastName, email: f.email, kind: 'client' });
      await addNote(contactId, `Website inquiry (contact form)\n${details}`).catch((e) =>
        console.error('[contact] Crelate note failed', e instanceof CrelateError ? `${e.status} ${e.detail}` : e),
      );
      filed = true;
    } catch (e) {
      console.error('[contact] Crelate error', e instanceof CrelateError ? `${e.status} ${e.detail}` : e);
    }
  }

  const sent = (await ats).ok;
  if (emailed || filed || sent) return isJson ? json({ ok: true }) : back(request, 'sent');
  return isJson ? json({ ok: false, error: 'send-failed' }, 502) : back(request, 'error');
};
