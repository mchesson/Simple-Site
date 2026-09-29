// POST /api/talent: careers "Stay in touch" form → Crelate candidate + note.
import type { APIRoute } from 'astro';
import { crelate, idOf, isConfigured, CrelateError } from '../../crelate';
import { json, readForm, clean, validEmail, back } from './_shared';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const { data, isJson } = await readForm(request);
  if (clean(data.website)) return isJson ? json({ ok: true }) : back(request, 'sent');

  const f = {
    firstName: clean(data.firstName, 80),
    lastName: clean(data.lastName, 80),
    email: clean(data.email, 200),
    industry: clean(data.industry, 80),
    specialty: clean(data.specialty, 200),
  };
  if (!f.firstName || !f.lastName || !validEmail(f.email)) {
    return isJson ? json({ ok: false, error: 'Please add your name and a valid email.' }, 400) : back(request, 'error');
  }
  if (!isConfigured()) {
    console.warn('[talent] CRELATE_API_KEY is not set; submission not sent', { email: f.email });
    return isJson ? json({ ok: false, error: 'not-configured' }, 503) : back(request, 'error');
  }

  try {
    const candidate = await crelate('candidates', {
      method: 'POST',
      body: { firstName: f.firstName, lastName: f.lastName, email: f.email, ...(f.specialty && { currentTitle: f.specialty }) },
    });
    const candidateId = idOf(candidate);
    if (candidateId) {
      const note = `Website talent network signup\nIndustry: ${f.industry || 'not given'}\nSpecialty: ${f.specialty || 'not given'}`;
      await crelate('notes', { method: 'POST', body: { body: note, candidateId } }).catch((e) =>
        console.error('[talent] note failed', e instanceof CrelateError ? e.detail : e),
      );
    }
    return isJson ? json({ ok: true }) : back(request, 'sent');
  } catch (e) {
    console.error('[talent] Crelate error', e instanceof CrelateError ? `${e.status} ${e.detail}` : e);
    return isJson ? json({ ok: false, error: 'send-failed' }, 502) : back(request, 'error');
  }
};
