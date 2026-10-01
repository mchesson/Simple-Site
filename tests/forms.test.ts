// The form endpoints, with Crelate and the email service replaced by a fake
// fetch that records every request.
import { describe, it, expect, beforeEach, vi } from 'vitest';

type Call = { method: string; url: URL; headers: Record<string, string>; body: any };
let calls: Call[] = [];
let fail: { crelate?: boolean; email?: boolean; apply?: boolean } = {};
let sources = [{ Id: 'src-career', Name: 'CareerBuilderSearch' }, { Id: 'src-web', Name: 'Company Website' }];
const KEY = 'test-key-123';

const ok = (data: unknown) => new Response(JSON.stringify({ Data: data, Errors: [], Metadata: {} }), { status: 200 });

beforeEach(() => {
  calls = [];
  fail = {};
  sources = [{ Id: 'src-career', Name: 'CareerBuilderSearch' }, { Id: 'src-web', Name: 'Company Website' }];
  vi.resetModules();
  process.env.CRELATE_API_KEY = KEY;
  process.env.CRELATE_API_BASE = 'http://crelate.test/api3';
  process.env.RESEND_API_KEY = 're_test';
  process.env.RESEND_API_URL = 'http://mail.test/emails';
  process.env.JOBS_LIST_ENABLED = 'true';
  delete process.env.ATS_INTAKE_URL; // TS Workspace is covered in ats.test.ts
  delete process.env.ATS_INTAKE_KEY;
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {}));
    const body = init.body instanceof FormData ? init.body : init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? 'GET', url, headers, body });
    if (url.host === 'mail.test') return fail.email ? new Response('down', { status: 500 }) : new Response('{"id":"m1"}');
    if (fail.crelate) return new Response(JSON.stringify({ Errors: [{ Message: 'nope' }] }), { status: 400 });
    const path = url.pathname.replace('/api3/', '');
    if (path === 'jobs') return ok(url.searchParams.get('offset') === '0' ? [{ Id: 'job-1', OnPortal: true, PortalTitle: 'Controls Engineer', PortalDescription: '<p>Hi.</p>' }] : []);
    if (path === 'contacts' && (init.method ?? 'GET') === 'GET') return ok([]);
    if (path === 'contacts') return ok('contact-1');
    if (path === 'contactsources') return ok(sources);
    if (path === 'jobs/job-1/apply') return fail.apply ? new Response(JSON.stringify({ Errors: [{ Message: 'An unknown error occurred.' }] }), { status: 500 }) : ok('app-1');
    if (path === 'applications/app-1') return ok({ Id: 'app-1', ContactId: { Id: 'contact-7' }, JobId: { Id: 'job-1' } });
    if (path === 'workflowstatuses') return ok([{ Id: 'st-maybe', Name: 'Maybe', SortOrder: 0 }, { Id: 'st-2', Name: 'Short List', SortOrder: 1 }]);
    return ok(true);
  });
});

const post = (url: string, body: FormData | object) =>
  new Request(url, body instanceof FormData
    ? { method: 'POST', body, headers: { Accept: 'application/json' } }
    : { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });

function application(extra: Record<string, string> = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ firstName: 'Ann', lastName: 'Lee', email: 'ann@example.com', phone: '9195551234', jobId: 'job-1', ...extra })) fd.set(k, v);
  fd.set('resume', new File(['%PDF-1.4'], 'cv.pdf', { type: 'application/pdf' }));
  return fd;
}

const crelateCalls = () => calls.filter((c) => c.url.host === 'crelate.test');

describe('Crelate key safety', () => {
  it('sends the key only in the X-Api-Key header, never in a URL', async () => {
    const { POST } = await import('../src/pages/api/apply');
    await POST({ request: post('http://site/api/apply', application()) } as any);
    expect(crelateCalls().length).toBeGreaterThan(0);
    for (const c of crelateCalls()) {
      expect(c.headers['X-Api-Key']).toBe(KEY);
      expect(c.url.toString()).not.toContain(KEY);
    }
  });
});

describe('POST /api/apply', () => {
  it('emails the resume and applies through Crelate\'s "apply to job"', async () => {
    const { POST } = await import('../src/pages/api/apply');
    const res = await POST({ request: post('http://site/api/apply', application()) } as any);
    expect(await res.json()).toEqual({ ok: true });

    const mail = calls.find((c) => c.url.host === 'mail.test')!;
    expect(mail.body.to).toEqual(['info@technicalsource.com']);
    expect(mail.body.attachments[0].filename).toBe('cv.pdf');

    // The shape the live Crelate account accepts: applicant as JSON text, file as resumeFile.
    const apply = crelateCalls().find((c) => c.url.pathname.endsWith('/jobs/job-1/apply'))!;
    expect(apply.method).toBe('POST');
    const form = apply.body as FormData;
    expect(JSON.parse(String(form.get('applicant')))).toEqual({ FirstName: 'Ann', LastName: 'Lee', Email_Personal: 'ann@example.com', Phone_Mobile: '+19195551234', ContactSourceId: { Id: 'src-web' } });
    expect((form.get('resumeFile') as File).name).toBe('cv.pdf');

    // Crelate made it a contact: the visitor's details go on as a note about the job.
    const note = crelateCalls().find((c) => c.url.pathname.endsWith('/notes'))!;
    expect(note.body.entity.ParentId).toEqual({ Id: 'contact-7', EntityName: 'Contacts' });
    expect(note.body.entity.RegardingId).toEqual({ Id: 'job-1' });
    expect(note.body.entity.Display).toContain('app-1');
    // No separate candidate, upload or pipeline step.
    expect(crelateCalls().some((c) => c.method === 'POST' && c.url.pathname.endsWith('/contacts'))).toBe(false);
    expect(crelateCalls().some((c) => c.url.pathname.endsWith('/jobs/job-1/contacts'))).toBe(false);
  });
  it('falls back to candidate + resume + Maybe pipeline + note when "apply to job" fails', async () => {
    fail.apply = true;
    const { POST } = await import('../src/pages/api/apply');
    expect(await (await POST({ request: post('http://site/api/apply', application()) } as any)).json()).toEqual({ ok: true });
    const create = crelateCalls().find((c) => c.method === 'POST' && c.url.pathname.endsWith('/contacts'))!;
    expect(create.body.entity).toMatchObject({ FirstName: 'Ann', RecordType: 1, EmailAddresses_Personal: { Value: 'ann@example.com' }, ContactSourceId: { Id: 'src-web' } });
    expect(crelateCalls().some((c) => c.url.pathname.endsWith('/artifacts/primary') && c.url.searchParams.get('target_record_id') === 'contact-1')).toBe(true);
    const pipeline = crelateCalls().find((c) => c.url.pathname.endsWith('/jobs/job-1/contacts'))!;
    expect(pipeline.body).toEqual({ statusId: 'st-maybe' });
    expect(crelateCalls().some((c) => c.url.pathname.endsWith('/notes'))).toBe(true);
  });
  it('files a general resume as candidate + resume + note, with no job', async () => {
    const { POST } = await import('../src/pages/api/apply');
    const fd = application({ jobId: '' });
    expect(await (await POST({ request: post('http://site/api/apply', fd) } as any)).json()).toEqual({ ok: true });
    expect(crelateCalls().some((c) => c.url.pathname.includes('/apply'))).toBe(false);
    expect(crelateCalls().find((c) => c.method === 'POST' && c.url.pathname.endsWith('/contacts'))!.body.entity.RecordType).toBe(1);
    expect(crelateCalls().some((c) => c.url.pathname.endsWith('/artifacts/primary'))).toBe(true);
    const note = crelateCalls().find((c) => c.url.pathname.endsWith('/notes'))!;
    expect(note.body.entity.Display).toContain('general consideration');
    expect(note.body.entity.RegardingId).toBeUndefined();
  });
  it('never tags website people with an unrelated source such as CareerBuilderSearch', async () => {
    sources = [{ Id: 'src-career', Name: 'CareerBuilderSearch' }, { Id: 'src-portal', Name: 'Portal' }];
    const { POST } = await import('../src/pages/api/apply');
    await POST({ request: post('http://site/api/apply', application()) } as any);
    const form = crelateCalls().find((c) => c.url.pathname.endsWith('/jobs/job-1/apply'))!.body as FormData;
    expect(JSON.parse(String(form.get('applicant'))).ContactSourceId).toBeUndefined();
  });
  it('still succeeds when Crelate is down but the email went out', async () => {
    fail.crelate = true;
    const { POST } = await import('../src/pages/api/apply');
    expect((await (await POST({ request: post('http://site/api/apply', application()) } as any)).json()).ok).toBe(true);
  });
  it('fails when both email and Crelate fail', async () => {
    fail.crelate = true; fail.email = true;
    const { POST } = await import('../src/pages/api/apply');
    const res = await POST({ request: post('http://site/api/apply', application()) } as any);
    expect(res.status).toBe(502);
  });
  it('asks for a resume, a valid email and a supported file type', async () => {
    const { POST } = await import('../src/pages/api/apply');
    const noResume = application(); noResume.delete('resume');
    expect((await POST({ request: post('http://site/api/apply', noResume) } as any)).status).toBe(400);
    expect((await POST({ request: post('http://site/api/apply', application({ email: 'bad' })) } as any)).status).toBe(400);
    const exe = application(); exe.set('resume', new File(['x'], 'cv.exe'));
    expect((await POST({ request: post('http://site/api/apply', exe) } as any)).status).toBe(400);
  });
  it('quietly ignores bots that fill the hidden field', async () => {
    const { POST } = await import('../src/pages/api/apply');
    const res = await POST({ request: post('http://site/api/apply', application({ website: 'spam.example' })) } as any);
    expect((await res.json()).ok).toBe(true);
    expect(calls.length).toBe(0);
  });
});

describe('POST /api/contact', () => {
  const inquiry = { firstName: 'Bo', lastName: 'Chan', email: 'bo@example.com', company: 'Acme', message: 'We need help.' };
  it('emails the team and files a client contact with a note', async () => {
    const { POST } = await import('../src/pages/api/contact');
    expect((await (await POST({ request: post('http://site/api/contact', inquiry) } as any)).json()).ok).toBe(true);
    expect(calls.find((c) => c.url.host === 'mail.test')!.body.reply_to).toBe('bo@example.com');
    expect(crelateCalls().find((c) => c.method === 'POST' && c.url.pathname.endsWith('/contacts'))!.body.entity.RecordType).toBe(2);
    expect(crelateCalls().find((c) => c.url.pathname.endsWith('/notes'))!.body.entity.ParentId).toEqual({ Id: 'contact-1', EntityName: 'Contacts' });
  });
  it('adds "how they found us" to the email and the Crelate note', async () => {
    const { POST } = await import('../src/pages/api/contact');
    const source = JSON.stringify({ first: { ref: 'www.linkedin.com', utm: {}, ad: '', landing: '/industries/data-centers', at: '2026-09-28' }, visit: null, pages: 2, industry: 'data-centers' });
    await POST({ request: post('http://site/api/contact', { ...inquiry, source }) } as any);
    const line = 'How they found us: LinkedIn (first visit 2026-09-28, landed on /industries/data-centers)';
    expect(calls.find((c) => c.url.host === 'mail.test')!.body.text).toContain(line);
    expect(crelateCalls().find((c) => c.url.pathname.endsWith('/notes'))!.body.entity.Display).toContain(line);
  });
  it('rejects a missing name or bad email', async () => {
    const { POST } = await import('../src/pages/api/contact');
    expect((await POST({ request: post('http://site/api/contact', { ...inquiry, email: 'x' }) } as any)).status).toBe(400);
  });
});

describe('POST /api/refer', () => {
  const referral = (extra: Record<string, string> = {}) => ({
    refFirstName: 'Jane', refLastName: 'Doe', refEmail: 'jane@example.com', relationship: 'contractor',
    firstName: 'Dana', lastName: 'Whitfield', email: 'dana@example.com', phone: '', role: 'CQV Engineer', theyKnow: 'on', ...extra,
  });

  it('emails the team and files the referred person as a Crelate candidate with a note naming the referrer', async () => {
    const { POST } = await import('../src/pages/api/refer');
    const res = await POST({ request: post('http://site/api/refer', referral()) } as any);
    expect(await res.json()).toEqual({ ok: true });
    const mail = calls.find((c) => c.url.host === 'mail.test')!;
    expect(mail.body.subject).toBe('Referral: Dana Whitfield (from Jane Doe)');
    expect(mail.body.reply_to ?? mail.body.replyTo).toBe('jane@example.com');
    expect(mail.body.text).toContain('Referred by: Jane Doe');
    const created = crelateCalls().find((c) => c.method === 'POST' && c.url.pathname.endsWith('/contacts'))!;
    expect(created.body.entity.FirstName).toBe('Dana');
    expect(created.body.entity.RecordType).toBe(1);
    const note = crelateCalls().find((c) => c.url.pathname.endsWith('/notes'))!;
    expect(note.body.entity.Display).toContain('Website referral from Jane Doe');
    expect(note.body.entity.Display).toContain('How they know us: I work with Technical Source now (contractor)');
  });

  it('accepts a phone instead of an email for the person, and makes a new Crelate contact without one', async () => {
    const { POST } = await import('../src/pages/api/refer');
    const res = await POST({ request: post('http://site/api/refer', referral({ email: '', phone: '(919) 555-0100' })) } as any);
    expect(await res.json()).toEqual({ ok: true });
    expect(crelateCalls().some((c) => c.method === 'GET' && c.url.pathname.endsWith('/contacts'))).toBe(false);
    const created = crelateCalls().find((c) => c.method === 'POST' && c.url.pathname.endsWith('/contacts'))!;
    expect(created.body.entity.EmailAddresses_Personal).toBeUndefined();
    expect(created.body.entity.PhoneNumbers_Mobile.Value).toBe('+19195550100');
  });

  it('requires the referrer, how they know us, a way to reach the person and the "they know" tick', async () => {
    const { POST } = await import('../src/pages/api/refer');
    const status = async (extra: Record<string, string>) => (await POST({ request: post('http://site/api/refer', referral(extra)) } as any)).status;
    expect(await status({ refEmail: 'nope' })).toBe(400);
    expect(await status({ refFirstName: '' })).toBe(400);
    expect(await status({ relationship: 'friend' })).toBe(400);
    expect(await status({ relationship: 'toString' })).toBe(400);
    expect(await status({ firstName: '' })).toBe(400);
    expect(await status({ email: '', phone: '' })).toBe(400);
    expect(await status({ email: 'jane@example.com' })).toBe(400);
    expect(await status({ theyKnow: '' })).toBe(400);
    expect(await status({ linkedin: 'https://evil.example/x' })).toBe(400);
    expect(calls.length).toBe(0);
  });

  it('quietly ignores bots that fill the hidden field', async () => {
    const { POST } = await import('../src/pages/api/refer');
    const res = await POST({ request: post('http://site/api/refer', referral({ website: 'spam.example' })) } as any);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls.length).toBe(0);
  });
});

describe('GET /api/jobs', () => {
  it('returns only public fields and links to our own job pages', async () => {
    const { GET } = await import('../src/pages/api/jobs');
    const out = await (await GET({ url: new URL('http://site/api/jobs') } as any)).json();
    expect(out.jobs).toHaveLength(1);
    expect(Object.keys(out.jobs[0]).sort()).toEqual(['distance', 'location', 'remote', 'summary', 'title', 'url']);
    expect(out.jobs[0].url).toBe('/careers/jobs/controls-engineer-job-1');
  });
  it('shows nothing when the job list is switched off', async () => {
    process.env.JOBS_LIST_ENABLED = '';
    const { GET } = await import('../src/pages/api/jobs');
    expect((await (await GET({ url: new URL('http://site/api/jobs') } as any)).json()).jobs).toEqual([]);
  });
});
