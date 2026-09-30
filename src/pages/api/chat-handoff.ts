// POST /api/chat-handoff: "talk to a person" from the chat assistant. Sent only
// when the visitor checks the details and presses Send.
// 1. Emails the details and the chat transcript to the team inbox.
// 2. Also files it in Crelate, when the key is set: a contact (candidate for
//    job seekers, client contact otherwise) with a note.
// The visitor sees success if either one worked.
import type { APIRoute } from 'astro';
import { isConfigured, createContact, addNote, CrelateError } from '../../crelate';
import { mailConfigured, sendMail } from '../../mail';
import { LIMITS } from '../../assistant';
import { json, clean, validEmail, sameOrigin, visitor, rateLimiter } from './_shared';

export const prerender = false;

const perHour = rateLimiter(3, 60);
const log = (step: string, e: unknown) => console.error(`[chat-handoff] ${step} failed`, e instanceof CrelateError ? `${e.status} ${e.detail}` : e);

export const POST: APIRoute = async ({ request }) => {
  if (!sameOrigin(request)) return json({ ok: false, error: 'forbidden' }, 403);
  const data = await request.json().catch(() => ({}));
  if (clean(data.website)) return json({ ok: true });

  const f = {
    firstName: clean(data.firstName, 80),
    lastName: clean(data.lastName, 80),
    email: clean(data.email, 200),
    phone: clean(data.phone, 40),
    company: clean(data.company, 200),
    need: clean(data.need, 2000),
    jobSeeker: data.jobSeeker === true || data.jobSeeker === 'true',
    page: clean(data.page, 300),
  };
  if (!f.firstName || !f.lastName || !validEmail(f.email)) return json({ ok: false, error: 'Please add your name and a valid email.' }, 400);
  if (!f.need) return json({ ok: false, error: 'Please tell us briefly what you need.' }, 400);
  if (!perHour(visitor(request))) return json({ ok: false, error: 'Too many requests. Please email info@technicalsource.com instead.' }, 429);
  if (!mailConfigured() && !isConfigured()) return json({ ok: false, error: 'not-configured' }, 503);

  const transcript = (Array.isArray(data.transcript) ? data.transcript : [])
    .slice(-LIMITS.userTurns * 2)
    .map((m: any) => `${m?.role === 'user' ? 'Visitor' : 'Assistant'}: ${clean(m?.text, 6000)}`)
    .join('\n\n');
  const what = f.jobSeeker ? 'Job seeker' : 'Project or general inquiry';
  const details = [
    `Website chat: ${what}`,
    `Name: ${f.firstName} ${f.lastName}`,
    `Email: ${f.email}`,
    `Phone: ${f.phone || 'not given'}`,
    `Company: ${f.company || 'not given'}`,
    f.page ? `Page: ${f.page}` : null,
    '',
    `What they need: ${f.need}`,
  ].filter((l) => l !== null).join('\n');
  const full = `${details}\n\n--- Chat transcript (answers are AI-generated) ---\n\n${transcript || '(none)'}`;

  const emailed = mailConfigured()
    ? await sendMail({ subject: `Website chat: ${f.firstName} ${f.lastName}${f.company ? `, ${f.company}` : ''} (${what})`, text: full, replyTo: f.email })
        .then(() => true, (e) => (log('email', e), false))
    : false;

  let filed = false;
  if (isConfigured()) {
    try {
      const id = await createContact({ firstName: f.firstName, lastName: f.lastName, email: f.email, phone: f.phone, kind: f.jobSeeker ? 'candidate' : 'client' });
      filed = true;
      await addNote(id, full).catch((e) => log('note', e));
    } catch (e) {
      log('Crelate contact', e);
    }
  }

  if (emailed || filed) return json({ ok: true });
  return json({ ok: false, error: 'send-failed' }, 502);
};
