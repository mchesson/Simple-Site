// TS Workspace intake (src/ats.ts): what each form sends, and that a missing
// setting, a network error or a refused key never reaches the visitor.
// Crelate, the email service and TS Workspace are all a fake fetch.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type Call = { method: string; url: URL; headers: Record<string, string>; body: any };
let calls: Call[] = [];
let ats: 'ok' | 'duplicate' | '401' | 'down' | 'hang' = 'ok';
const ATS_KEY = 'ats-test-key-0123456789abcdef0123456789';

const ok = (data: unknown) => new Response(JSON.stringify({ Data: data, Errors: [], Metadata: {} }), { status: 200 });
const source = JSON.stringify({
  first: { ref: 'www.linkedin.com/feed', utm: { source: 'linkedin', medium: 'social', campaign: 'cq-post' }, ad: '', landing: '/industries/life-sciences', at: '2026-09-28' },
  visit: { ref: 'www.google.com', utm: {}, ad: '', landing: '/careers', at: '2026-09-30' },
  pages: 3,
  industry: 'life-sciences',
});
const attribution = {
  channel: 'social', source: 'LinkedIn', medium: 'social', campaign: 'cq-post', firstVisit: '2026-09-28',
  landingPage: '/industries/life-sciences', referrer: 'www.linkedin.com/feed', industryOfInterest: 'Life Sciences',
};

beforeEach(() => {
  calls = [];
  ats = 'ok';
  vi.resetModules();
  process.env.CRELATE_API_KEY = 'crelate-key';
  process.env.CRELATE_API_BASE = 'http://crelate.test/api3';
  process.env.RESEND_API_KEY = 're_test';
  process.env.RESEND_API_URL = 'http://mail.test/emails';
  process.env.ATS_INTAKE_URL = 'http://ats.test/api/intake';
  process.env.ATS_INTAKE_KEY = ATS_KEY;
  process.env.SITE_URL = 'https://site.test';
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {}));
    const body = init.body instanceof FormData ? init.body : init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method ?? 'GET', url, headers, body });
    if (url.host === 'ats.test') {
      if (ats === 'down') throw new TypeError('fetch failed');
      if (ats === 'hang') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      if (ats === '401') return new Response('{"ok":false,"error":"unauthorized"}', { status: 401 });
      return new Response(JSON.stringify({ ok: true, id: 'lead-1', duplicate: ats === 'duplicate' }), { status: ats === 'duplicate' ? 200 : 201 });
    }
    if (url.host === 'mail.test') return new Response('{"id":"m1"}');
    const path = url.pathname.replace('/api3/', '');
    if (path === 'jobs') return ok(url.searchParams.get('offset') === '0' ? [{ Id: 'job-1', OnPortal: true, PortalTitle: 'CQV Lead', PortalDescription: '<p>Hi.</p>' }] : []);
    if (path === 'contacts' && (init.method ?? 'GET') === 'GET') return ok([]);
    if (path === 'contacts') return ok('contact-1');
    if (path === 'contactsources') return ok([]);
    if (path === 'jobs/job-1/apply') return ok('app-1');
    if (path === 'applications/app-1') return ok({ Id: 'app-1', ContactId: { Id: 'contact-7' } });
    return ok(true);
  });
});
afterEach(() => vi.restoreAllMocks());

const post = (url: string, body: FormData | object) =>
  new Request(url, body instanceof FormData
    ? { method: 'POST', body, headers: { Accept: 'application/json' } }
    : { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });

function application(extra: Record<string, string> = {}) {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ firstName: 'Ann', lastName: 'Lee', email: 'ann@example.com', phone: '9195551234', location: 'Durham, NC', message: 'Free in November.', jobId: 'job-1', page: '/careers/jobs/cqv-lead-job-1', source, ...extra })) fd.set(k, v);
  fd.set('resume', new File(['%PDF-1.4'], 'cv.pdf', { type: 'application/pdf' }));
  return fd;
}

const atsCall = () => calls.find((c) => c.url.host === 'ats.test')!;
/** The JSON sent to TS Workspace, from a JSON body or the multipart "data" field. */
const sent = () => {
  const b = atsCall().body;
  return b instanceof FormData ? JSON.parse(String(b.get('data'))) : b;
};

describe('TS Workspace payloads', () => {
  it('contact form → inquiry', async () => {
    const { POST } = await import('../src/pages/api/contact');
    const res = await POST({ request: post('http://site/api/contact', { firstName: 'Bo', lastName: 'Chan', email: 'bo@example.com', company: 'Acme', industry: 'Life Sciences', service: 'Project Support', message: 'We need help.', page: '/contact', source }) } as any);
    expect(await res.json()).toEqual({ ok: true });
    const c = atsCall();
    expect(c.method).toBe('POST');
    expect(c.headers.Authorization).toBe(`Bearer ${ATS_KEY}`);
    expect(c.headers['Content-Type']).toBe('application/json');
    expect(c.url.toString()).not.toContain(ATS_KEY);
    const p = sent();
    expect(p.externalId).toMatch(/^web-[0-9a-f-]{36}$/);
    expect(Date.parse(p.submittedAt)).not.toBeNaN();
    const { externalId, submittedAt, ...rest } = p;
    expect(rest).toEqual({
      type: 'inquiry',
      contact: { firstName: 'Bo', lastName: 'Chan', email: 'bo@example.com', company: 'Acme' },
      industry: 'Life Sciences', service: 'Project Support', message: 'We need help.', page: '/contact', attribution,
    });
  });

  it('job application → application with the job and the resume (multipart)', async () => {
    const { POST } = await import('../src/pages/api/apply');
    expect(await (await POST({ request: post('http://site/api/apply', application()) } as any)).json()).toEqual({ ok: true });
    const form = atsCall().body as FormData;
    expect((form.get('resume') as File).name).toBe('cv.pdf');
    expect(atsCall().headers['Content-Type']).toBeUndefined(); // fetch sets the multipart boundary
    const { externalId, submittedAt, ...rest } = sent();
    expect(rest).toEqual({
      type: 'application',
      contact: { firstName: 'Ann', lastName: 'Lee', email: 'ann@example.com', phone: '9195551234', location: 'Durham, NC' },
      message: 'Free in November.',
      job: { id: 'job-1', title: 'CQV Lead', url: 'https://site.test/careers/jobs/cqv-lead-job-1' },
      page: '/careers/jobs/cqv-lead-job-1',
      attribution,
    });
  });

  it('Refer Someone → referral with the referrer, as JSON without a resume', async () => {
    const { POST } = await import('../src/pages/api/refer');
    const res = await POST({ request: post('http://site/api/refer', {
      refFirstName: 'Jane', refLastName: 'Doe', refEmail: 'jane@example.com', refPhone: '9195550199', relationship: 'former_contractor',
      firstName: 'Dana', lastName: 'Whitfield', email: '', phone: '919-555-0100', linkedin: 'linkedin.com/in/dana', role: 'CQV Engineer',
      message: 'Great on fill-finish.', theyKnow: 'on', page: '/refer', source,
    }) } as any);
    expect(await res.json()).toEqual({ ok: true });
    expect(atsCall().headers['Content-Type']).toBe('application/json');
    const { externalId, submittedAt, ...rest } = sent();
    expect(externalId).toMatch(/^web-/);
    expect(rest).toEqual({
      type: 'referral',
      contact: { firstName: 'Dana', lastName: 'Whitfield', phone: '919-555-0100' },
      message: 'Great on fill-finish.',
      page: '/refer',
      referral: {
        referrer: { firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com', phone: '9195550199' },
        relationship: 'former_contractor', theyKnow: true, role: 'CQV Engineer', linkedin: 'https://linkedin.com/in/dana',
      },
      attribution,
    });
  });

  it('Refer Them from a job page → referral carries the published job (id, title, link)', async () => {
    const { POST } = await import('../src/pages/api/refer');
    await POST({ request: post('http://site/api/refer', {
      refFirstName: 'Jane', refLastName: 'Doe', refEmail: 'jane@example.com', relationship: 'contractor',
      firstName: 'Dana', lastName: 'Whitfield', email: 'dana@example.com', role: 'CQV Lead', theyKnow: 'on', page: '/refer', jobId: 'job-1',
    }) } as any);
    expect(sent().job).toEqual({ id: 'job-1', title: 'CQV Lead', url: 'https://site.test/careers/jobs/cqv-lead-job-1' });
  });

  it('Refer Someone with an unknown job id → the id only; no job id → no job', async () => {
    const { POST } = await import('../src/pages/api/refer');
    const base = { refFirstName: 'Jane', refLastName: 'Doe', refEmail: 'jane@example.com', relationship: 'client', firstName: 'Dana', lastName: 'Whitfield', email: 'dana@example.com', theyKnow: 'on' };
    await POST({ request: post('http://site/api/refer', { ...base, jobId: 'gone-9' }) } as any);
    expect(sent().job).toEqual({ id: 'gone-9' });
    calls.length = 0;
    await POST({ request: post('http://site/api/refer', base) } as any);
    expect(sent().job).toBeUndefined();
  });

  it('Refer Someone with a resume → referral as multipart', async () => {
    const { POST } = await import('../src/pages/api/refer');
    const fd = new FormData();
    for (const [k, v] of Object.entries({ refFirstName: 'Jane', refLastName: 'Doe', refEmail: 'jane@example.com', relationship: 'client', firstName: 'Dana', lastName: 'Whitfield', email: 'dana@example.com', theyKnow: 'on' })) fd.set(k, v);
    fd.set('resume', new File(['%PDF-1.4'], 'dana.pdf', { type: 'application/pdf' }));
    expect(await (await POST({ request: post('http://site/api/refer', fd) } as any)).json()).toEqual({ ok: true });
    expect(((atsCall().body as FormData).get('resume') as File).name).toBe('dana.pdf');
    expect(sent().type).toBe('referral');
    expect(sent().referral.relationship).toBe('client');
  });

  it('"Not Looking Right Now?" → resume, no job', async () => {
    const { POST } = await import('../src/pages/api/apply');
    await POST({ request: post('http://site/api/apply', application({ jobId: '', page: '/careers' })) } as any);
    const p = sent();
    expect(p.type).toBe('resume');
    expect(p.job).toBeUndefined();
    expect(((atsCall().body as FormData).get('resume') as File).name).toBe('cv.pdf');
  });

  it('chat "talk to a person" → chat with jobSeeker and the transcript', async () => {
    const { POST } = await import('../src/pages/api/chat-handoff');
    const req = new Request('http://site/api/chat-handoff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://site' },
      body: JSON.stringify({
        firstName: 'Cy', lastName: 'Diaz', email: 'cy@example.com', phone: '', company: '', need: 'Looking for CQV work.', jobSeeker: true, page: '/careers', source,
        transcript: [{ role: 'user', text: 'Any CQV jobs?' }, { role: 'assistant', text: 'Here are some.' }, { role: 'user', text: '' }],
      }),
    });
    expect(await (await POST({ request: req } as any)).json()).toEqual({ ok: true });
    const { externalId, submittedAt, ...rest } = sent();
    expect(rest).toEqual({
      type: 'chat',
      contact: { firstName: 'Cy', lastName: 'Diaz', email: 'cy@example.com' },
      message: 'Looking for CQV work.',
      jobSeeker: true,
      transcript: [{ role: 'user', text: 'Any CQV jobs?' }, { role: 'assistant', text: 'Here are some.' }],
      page: '/careers',
      attribution,
    });
  });

  it('gives every submission its own externalId', async () => {
    const { POST } = await import('../src/pages/api/contact');
    const body = { firstName: 'Bo', lastName: 'Chan', email: 'bo@example.com' };
    await POST({ request: post('http://site/api/contact', body) } as any);
    await POST({ request: post('http://site/api/contact', body) } as any);
    const ids = calls.filter((c) => c.url.host === 'ats.test').map((c) => c.body.externalId);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('sendToAts never gets in the visitor\'s way', () => {
  const payload = { type: 'inquiry' as const, externalId: 'web-1', submittedAt: '2026-09-30T14:05:00Z', contact: { firstName: 'Bo', lastName: 'Chan', email: 'bo@example.com' } };

  it('skips quietly when a setting is missing', async () => {
    delete process.env.ATS_INTAKE_KEY;
    const { sendToAts } = await import('../src/ats');
    expect(await sendToAts(payload)).toMatchObject({ ok: false, skipped: true });
    expect(await sendToAts(payload)).toMatchObject({ ok: false, skipped: true });
    expect(calls).toHaveLength(0);
    expect(console.warn).toHaveBeenCalledTimes(1); // logged once
    process.env.ATS_INTAKE_KEY = ATS_KEY;
    delete process.env.ATS_INTAKE_URL;
    expect((await sendToAts(payload)).skipped).toBe(true);
  });

  it('returns the lead id, and reports a duplicate', async () => {
    const { sendToAts } = await import('../src/ats');
    expect(await sendToAts(payload)).toEqual({ ok: true, id: 'lead-1', duplicate: false });
    ats = 'duplicate';
    expect(await sendToAts(payload)).toEqual({ ok: true, id: 'lead-1', duplicate: true });
  });

  it.each([['down', 'network error'], ['hang', 'timeout'], ['401', 'unauthorized']] as const)('does not throw when TS Workspace is %s', async (mode, error) => {
    ats = mode;
    const { sendToAts } = await import('../src/ats');
    expect(await sendToAts(payload)).toEqual({ ok: false, error });
    // Never logs the key or the visitor's details.
    const logged = JSON.stringify((console.error as any).mock.calls);
    expect(logged).not.toContain(ATS_KEY);
    expect(logged).not.toContain('bo@example.com');
  });

  it('the forms still succeed when TS Workspace refuses or is down', async () => {
    for (const mode of ['401', 'down'] as const) {
      ats = mode;
      const contact = await import('../src/pages/api/contact');
      expect((await (await contact.POST({ request: post('http://site/api/contact', { firstName: 'Bo', lastName: 'Chan', email: 'bo@example.com' }) } as any)).json()).ok).toBe(true);
      const apply = await import('../src/pages/api/apply');
      expect((await (await apply.POST({ request: post('http://site/api/apply', application()) } as any)).json()).ok).toBe(true);
    }
  });

  it('still delivers through TS Workspace when email and Crelate are not set', async () => {
    delete process.env.RESEND_API_KEY;
    delete process.env.CRELATE_API_KEY;
    const { POST } = await import('../src/pages/api/contact');
    expect((await (await POST({ request: post('http://site/api/contact', { firstName: 'Bo', lastName: 'Chan', email: 'bo@example.com' }) } as any)).json()).ok).toBe(true);
    expect(sent().type).toBe('inquiry');
  });
});

describe('GET /api/apply?check', () => {
  it('check=1 says whether the settings are there, never their values', async () => {
    delete process.env.CRELATE_API_KEY;
    delete process.env.ATS_INTAKE_URL;
    const { GET } = await import('../src/pages/api/apply');
    const text = await (await GET({ url: new URL('http://site/api/apply?check=1') } as any)).text();
    expect(JSON.parse(text).tsWorkspace).toEqual({ url: false, key: true });
    expect(text).not.toContain(ATS_KEY);
  });
  it('check=2 tests the connection with the key', async () => {
    const { GET } = await import('../src/pages/api/apply');
    const out = await (await GET({ url: new URL('http://site/api/apply?check=2') } as any)).json();
    expect(out.tsWorkspace).toEqual({ url: true, key: true, connection: { ok: true, status: 201 } });
    expect(atsCall().method).toBe('GET');
    expect(atsCall().headers.Authorization).toBe(`Bearer ${ATS_KEY}`);
  });
});

describe('sourceAttribution', () => {
  it('reads plain referrers and direct visits', async () => {
    const { sourceAttribution } = await import('../src/source');
    expect(sourceAttribution({ first: { ref: 'www.google.com', utm: {}, ad: '', landing: '/', at: '2026-09-01' } })).toEqual({ source: 'Google search', channel: 'search', firstVisit: '2026-09-01', landingPage: '/', referrer: 'www.google.com' });
    expect(sourceAttribution({ first: { ref: '', utm: {}, ad: 'Google Ads', landing: '/x', at: '2026-09-01' } })).toMatchObject({ source: 'Google Ads', channel: 'paid' });
    expect(sourceAttribution({ visit: { ref: '', utm: {}, ad: '', landing: '/', at: '2026-09-01' } })).toEqual({ source: 'Direct', channel: 'direct', landingPage: '/' });
    expect(sourceAttribution('junk')).toEqual({});
  });
});
