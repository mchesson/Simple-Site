// POST /api/apply: job applications and general resume submissions from the
// site's own forms (job pages and Careers "Not Looking Right Now?").
// 1. Emails the application, resume attached, to the team inbox (src/mail.ts).
// 2. Also files it in Crelate, when the key is set: candidate, resume upload,
//    link to the job, and a note saying where it came from.
// The visitor sees success if either one worked.
//
// Diagnostics (no candidate data):
//   GET /api/apply?check=1  endpoints for contacts, notes, files and job
//                           pipelines, from Crelate's public API description
//   GET /api/apply?check=2  the record fields those create calls expect
//   GET /api/apply?check=3  file types set up in Crelate (e.g. Resume)
//   GET /api/apply?check=4&q=email  search the API description's fields
//   GET /api/apply?check=5  contact field settings (RecordType values) and source names
import type { APIRoute } from 'astro';
import { crelate, isConfigured, listOf, createContact, addNote, uploadResume, addToJob, CrelateError } from '../../crelate';
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
  if (!['1', '2', '3', '4', '5'].includes(check ?? '')) return json({ ok: false, error: 'unknown-check', got: check }, 404);
  const base = (process.env.CRELATE_API_BASE || 'https://app.crelate.com/api3').replace(/\/$/, '');
  try {
    if (check === '5') {
      // Crelate's field settings for contacts (RecordType values, email/phone
      // format) and the contact source names. Settings only, no contact data.
      if (!isConfigured()) return json({ ok: false, error: 'not-configured' });
      const info: any = await crelate('contacts/info').catch((e) => ({ error: e instanceof CrelateError ? `${e.status} ${e.detail}` : String(e) }));
      const want = /^(RecordType|ContactSourceId|EmailAddresses_Personal|PhoneNumbers_Mobile)$/;
      const walk = (o: any, out: any[] = [], depth = 0): any[] => {
        if (!o || typeof o !== 'object' || depth > 6) return out;
        if (want.test(String(o.Name ?? o.name ?? o.FieldName ?? ''))) out.push(o);
        for (const v of Object.values(o)) walk(v, out, depth + 1);
        return out;
      };
      const sources = listOf(await crelate('contactsources', { params: { limit: 200 } }).catch(() => []));
      return json({
        ok: true,
        fields: walk(info).slice(0, 10),
        infoKeys: info && typeof info === 'object' ? Object.keys(info).slice(0, 20) : typeof info,
        infoError: info?.error,
        contactSources: sources.map((s: any) => ({ id: s?.Id, name: s?.Name ?? s?.Title ?? s?.Display })),
      }, 200, { 'Cache-Control': 'no-store' });
    }
    if (check === '3') {
      // File types set up in Crelate (e.g. "Resume"): names and Ids only.
      if (!isConfigured()) return json({ ok: false, error: 'not-configured' });
      const types = listOf(await crelate('artifacttypes', { params: { limit: 100 } }));
      return json({ ok: true, artifactTypes: types.map((x: any) => ({ id: x?.Id, name: x?.Name ?? x?.Title ?? x?.Display, entities: x?.AllowedEntityNames ?? null })) });
    }
    const res = await fetch(`${base}/docs/v3/crelate-openapi.json`);
    const spec: any = await res.json();
    const ref = (s: any): any => (s?.$ref ? s.$ref.split('/').slice(1).reduce((o: any, k: string) => o?.[k], spec) : s);
    if (check === '4') {
      // Search the API description: every schema property whose name matches
      // ?q= (e.g. email, phone, recordtype), with its type or enum values and
      // description, plus the raw shape of the contact record.
      const q = new RegExp(url.searchParams.get('q') || 'email|phone|recordtype', 'i');
      const schemas = spec.components?.schemas ?? {};
      const hits: any[] = [];
      for (const [name, s] of Object.entries<any>(schemas)) {
        const parts = [s, ...(s.allOf ?? []), ...(s.oneOf ?? [])].map(ref);
        for (const part of parts)
          for (const [prop, v] of Object.entries<any>(part?.properties ?? {}))
            if (q.test(prop)) {
              const r = ref(v);
              hits.push({ schema: name, prop, type: r?.type ?? v?.$ref?.split('/').pop(), enum: r?.enum ?? r?.['x-enumNames'] ?? undefined, about: String(r?.description ?? v?.description ?? '').slice(0, 200), fields: r?.properties ? Object.keys(r.properties) : undefined });
            }
        if (q.test(name) && s.enum) hits.push({ schema: name, enum: s.enum, names: s['x-enumNames'] ?? s['x-enum-varnames'], about: String(s.description ?? '').slice(0, 300) });
      }
      const contactEntity = ref(ref(spec.paths?.['/contacts']?.post?.requestBody?.content?.['application/json']?.schema)?.properties?.entity);
      const shape = (s: any) => ({ keys: Object.keys(s ?? {}), allOf: (s?.allOf ?? []).map((x: any) => x.$ref ?? Object.keys(ref(x)?.properties ?? {})), additionalProperties: s?.additionalProperties ? (s.additionalProperties.$ref ?? typeof s.additionalProperties) : null });
      return json({ ok: true, hits: hits.slice(0, 150), contactEntity: shape(contactEntity) });
    }
    if (check === '2') {
      // The record fields each create call expects (from the public API description).
      const describe = (s: any, depth = 0): any => {
        const r = ref(s);
        if (!r) return null;
        if (r.items) return [describe(r.items, depth)];
        if (r.enum) return { enum: r.enum.slice(0, 30) };
        if (r.properties) {
          if (depth > 1) return Object.keys(r.properties);
          return Object.fromEntries(Object.entries(r.properties).map(([k, v]: [string, any]) => [k, describe(v, depth + 1)]));
        }
        return r.type ?? (r.allOf || r.oneOf || r.anyOf ? describe((r.allOf || r.oneOf || r.anyOf)[0], depth) : null);
      };
      const want: [string, string][] = [['/contacts', 'post'], ['/notes', 'post'], ['/artifacts/primary', 'post'], ['/artifacts', 'post'], ['/jobs/{jobId}/contacts', 'post'], ['/activities/withattachments', 'post']];
      const out = want.map(([p, m]) => {
        const op = spec.paths?.[p]?.[m];
        return {
          path: p,
          params: (op?.parameters ?? []).map((x: any) => ref(x)).map((x: any) => ({ name: x?.name, in: x?.in, required: x?.required ?? false, type: describe(x?.schema, 2), about: String(x?.description ?? '').slice(0, 200) })),
          body: Object.fromEntries(Object.entries(op?.requestBody?.content ?? {}).map(([ct, c]: [string, any]) => [ct, describe(c.schema)])),
        };
      });
      return json({ ok: true, calls: out });
    }
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
