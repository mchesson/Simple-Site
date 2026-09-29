// POST /api/contact: "Tell us about your project" form → Crelate contact + note.
import type { APIRoute } from 'astro';
import { crelate, idOf, isConfigured, CrelateError } from '../../crelate';
import { json, readForm, clean, validEmail, back } from './_shared';

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
  if (!isConfigured()) {
    console.warn('[contact] CRELATE_API_KEY is not set; submission not sent', { email: f.email });
    return isJson ? json({ ok: false, error: 'not-configured' }, 503) : back(request, 'error');
  }

  try {
    const contact = await crelate('contacts', {
      method: 'POST',
      body: { firstName: f.firstName, lastName: f.lastName, email: f.email, ...(f.company && { companyName: f.company }) },
    });
    const contactId = idOf(contact);
    const note = [
      'Website inquiry (technicalsource.com contact form)',
      `Industry: ${f.industry || 'not given'}`,
      `How can we help: ${f.service || 'not given'}`,
      f.company ? `Company: ${f.company}` : null,
      f.page ? `Page: ${f.page}` : null,
      '',
      f.message || '(no message)',
    ].filter((l) => l !== null).join('\n');
    if (contactId) {
      await crelate('notes', { method: 'POST', body: { body: note, contactId } }).catch((e) =>
        console.error('[contact] note failed', e instanceof CrelateError ? e.detail : e),
      );
    }
    return isJson ? json({ ok: true }) : back(request, 'sent');
  } catch (e) {
    console.error('[contact] Crelate error', e instanceof CrelateError ? `${e.status} ${e.detail}` : e);
    return isJson ? json({ ok: false, error: 'send-failed' }, 502) : back(request, 'error');
  }
};
