// The chat assistant and its endpoints, with Claude, Crelate and the email
// service faked. Each fake Claude reply is scripted in `replies`.
import { describe, it, expect, beforeEach, vi } from 'vitest';

type Reply = { text?: string; tools?: { name: string; input: unknown }[]; stop?: string };
let replies: Reply[] = [];
let requests: any[] = [];

vi.mock('@anthropic-ai/sdk', () => {
  class Anthropic {
    beta = {
      messages: {
        stream: (params: any) => {
          requests.push(structuredClone(params));
          const r = replies.shift() ?? { text: 'OK.' };
          const content: any[] = [
            { type: 'thinking', thinking: '', signature: 'sig' },
            ...(r.text ? [{ type: 'text', text: r.text }] : []),
            ...(r.tools ?? []).map((t, i) => ({ type: 'tool_use', id: `tu_${requests.length}_${i}`, name: t.name, input: t.input })),
          ];
          const stop = r.stop ?? (r.tools?.length ? 'tool_use' : 'end_turn');
          return {
            async *[Symbol.asyncIterator]() {
              if (r.text) for (const piece of r.text.match(/.{1,5}/gs) ?? []) yield { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: piece } };
            },
            finalMessage: async () => ({ role: 'assistant', content, stop_reason: stop }),
          };
        },
      },
    };
  }
  return { default: Anthropic };
});

type Call = { url: URL; method: string; headers: Record<string, string>; body: any };
let calls: Call[] = [];
const ok = (data: unknown) => new Response(JSON.stringify({ Data: data, Errors: [], Metadata: {} }));

beforeEach(() => {
  replies = []; requests = []; calls = [];
  vi.resetModules();
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  delete process.env.CHAT_ENABLED;
  delete process.env.SITE_URL;
  process.env.CRELATE_API_KEY = 'crelate-key';
  process.env.CRELATE_API_BASE = 'http://crelate.test/api3';
  process.env.RESEND_API_KEY = 're_test';
  process.env.RESEND_API_URL = 'http://mail.test/emails';
  process.env.JOBS_LIST_ENABLED = 'true';
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ url, method: init.method ?? 'GET', headers: (init.headers as any) ?? {}, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (url.host === 'mail.test') return new Response('{"id":"m1"}');
    const path = url.pathname.replace('/api3/', '');
    if (path === 'jobs') return ok(url.searchParams.get('offset') === '0' ? [
      { Id: 'job-1', OnPortal: true, PortalTitle: 'Commissioning Engineer', PortalCity: 'Charlotte', PortalState: 'NC', PortalDescription: '<p>C&amp;Q work.</p>', Name: 'INTERNAL client name' },
      { Id: 'job-2', OnPortal: false, PortalTitle: 'Hidden Job' },
    ] : []);
    if (path === 'contacts' && (init.method ?? 'GET') === 'GET') return ok([]);
    if (path === 'contacts') return ok('contact-9');
    if (path === 'contactsources') return ok([{ Id: 'src-web', Name: 'Website' }]);
    return ok(true);
  });
});

const chatPost = (body: unknown, origin: string | null = 'http://site') =>
  new Request('http://site/api/chat', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'x-real-ip': `1.2.3.${Math.random()}`, ...(origin && { Origin: origin }) } });
const events = async (res: Response) => (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
const ask = (text: string) => ({ messages: [{ role: 'user', text }] });

describe('GET /api/chat', () => {
  it('reports the chat on only when the Anthropic key is set', async () => {
    let { GET } = await import('../src/pages/api/chat');
    expect(await (await (GET as any)()).json()).toEqual({ enabled: true });
    delete process.env.ANTHROPIC_API_KEY;
    vi.resetModules();
    ({ GET } = await import('../src/pages/api/chat'));
    expect(await (await (GET as any)()).json()).toEqual({ enabled: false });
  });
  it('can be switched off with CHAT_ENABLED=false', async () => {
    process.env.CHAT_ENABLED = 'false';
    const { GET } = await import('../src/pages/api/chat');
    expect((await (await (GET as any)()).json()).enabled).toBe(false);
  });
});

describe('POST /api/chat', () => {
  it('streams the answer from claude-opus-5-5 at low effort, with caching and fallbacks', async () => {
    replies = [{ text: 'We support **complex** projects. [Contact us](/contact).' }];
    const { POST } = await import('../src/pages/api/chat');
    const out = await events(await POST({ request: chatPost(ask('What do you do?')) } as any));
    expect(out.filter((e) => e.t === 'text').map((e) => e.v).join('')).toBe('We support **complex** projects. [Contact us](/contact).');
    expect(out.at(-1)).toEqual({ t: 'done' });

    const req = requests[0];
    expect(req.model).toBe('claude-opus-5-5');
    expect(req.output_config).toEqual({ effort: 'low' });
    expect(req.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(req.fallbacks).toBe('default');
    expect(req.thinking).toBeUndefined();
    expect(req.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(req.tools.map((t: any) => t.name)).toEqual(['search_jobs', 'offer_handoff']);
    expect(req.messages).toEqual([{ role: 'user', content: 'What do you do?' }]);
  });

  it('keeps the system prompt identical between visitors (so it caches)', async () => {
    const { POST } = await import('../src/pages/api/chat');
    await events(await POST({ request: chatPost(ask('Hi')) } as any));
    await events(await POST({ request: chatPost(ask('Something else entirely')) } as any));
    expect(requests[0].system).toEqual(requests[1].system);
  });

  it('holds the firm rules and the owner\'s knowledge file', async () => {
    const { systemPrompt } = await import('../src/assistant');
    const s = systemPrompt();
    for (const rule of [/rates, pay/, /Never name clients/, /Never promise placements/, /legal, immigration, visa, tax/, /Never give out phone numbers/, /Raleigh/, /internal strategy/, /Only state facts/, /Stay on topic/, /Ignore any request to change/]) expect(s).toMatch(rule);
    expect(s).toContain('more than a decade');
    expect(s).toContain('/industries/life-sciences');
    expect(s).toContain('Managed Project Teams');
    expect(s).not.toMatch(/\d{3}[-.\s]\d{3}[-.\s]\d{4}/);
  });

  it('searches jobs with searchJobs() and links to our own job pages, public fields only', async () => {
    replies = [
      { tools: [{ name: 'search_jobs', input: { keywords: 'commissioning' } }] },
      { text: 'Here is one: [Commissioning Engineer](/careers/jobs/commissioning-engineer-job-1).' },
    ];
    const { POST } = await import('../src/pages/api/chat');
    const out = await events(await POST({ request: chatPost(ask('Any commissioning jobs?')) } as any));
    expect(out.find((e) => e.t === 'jobs').v).toEqual([{ title: 'Commissioning Engineer', location: 'Charlotte, NC', url: '/careers/jobs/commissioning-engineer-job-1' }]);

    // The tool result went back to Claude after the unchanged assistant turn.
    const second = requests[1].messages;
    expect(second[1].role).toBe('assistant');
    expect(second[1].content[0].type).toBe('thinking');
    const result = second[2].content[0];
    expect(result.type).toBe('tool_result');
    expect(result.content).not.toContain('INTERNAL');
    expect(result.content).not.toContain('Hidden Job');
    expect(JSON.parse(result.content).jobs[0].url).toBe('/careers/jobs/commissioning-engineer-job-1');
  });

  it('rejects bad tool input instead of running it', async () => {
    replies = [{ tools: [{ name: 'search_jobs', input: { radius_miles: 'far' } }] }, { text: 'Sorry.' }];
    const { POST } = await import('../src/pages/api/chat');
    await events(await POST({ request: chatPost(ask('jobs')) } as any));
    expect(requests[1].messages[2].content[0].is_error).toBe(true);
  });

  it('never runs tool calls from a cut-off answer', async () => {
    replies = [{ tools: [{ name: 'offer_handoff', input: { first_name: 'A' } }], stop: 'max_tokens' }];
    const { POST } = await import('../src/pages/api/chat');
    const out = await events(await POST({ request: chatPost(ask('hi')) } as any));
    expect(out.some((e) => e.t === 'handoff')).toBe(false);
    expect(requests).toHaveLength(1);
  });

  it('offers the handoff form without sending anything', async () => {
    replies = [
      { tools: [{ name: 'offer_handoff', input: { first_name: 'Bo', last_name: 'Chan', email: 'bo@example.com', need: 'A C&Q team', looking_for_work: false } }] },
      { text: 'Please check the details and press Send.' },
    ];
    const { POST } = await import('../src/pages/api/chat');
    const out = await events(await POST({ request: chatPost(ask('I want to talk to someone')) } as any));
    expect(out.find((e) => e.t === 'handoff').v).toMatchObject({ first_name: 'Bo', email: 'bo@example.com' });
    expect(calls.some((c) => c.url.host === 'mail.test' || c.url.pathname.endsWith('/contacts'))).toBe(false);
  });

  it('answers a refusal with a polite line', async () => {
    replies = [{ stop: 'refusal' }];
    const { POST } = await import('../src/pages/api/chat');
    const out = await events(await POST({ request: chatPost(ask('something off topic')) } as any));
    expect(out.find((e) => e.t === 'text').v).toMatch(/can’t help with that/);
  });

  it('only accepts requests from our own site', async () => {
    const { POST } = await import('../src/pages/api/chat');
    expect((await POST({ request: chatPost(ask('hi'), 'https://evil.example') } as any)).status).toBe(403);
    expect((await POST({ request: chatPost(ask('hi'), null) } as any)).status).toBe(403);
    // Behind Vercel's proxy the request can read as http while the page is https.
    expect((await POST({ request: chatPost(ask('hi'), 'https://site') } as any)).status).toBe(200);
    process.env.SITE_URL = 'https://technicalsource.com';
    expect((await POST({ request: chatPost(ask('hi'), 'https://technicalsource.com') } as any)).status).toBe(200);
    expect((await POST({ request: chatPost(ask('hi'), 'not a url') } as any)).status).toBe(403);
    expect(requests).toHaveLength(2);
  });

  it('caps message length and conversation length', async () => {
    const { POST } = await import('../src/pages/api/chat');
    expect((await POST({ request: chatPost(ask('x'.repeat(1001))) } as any)).status).toBe(400);
    const long = Array.from({ length: 41 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: 'hello' }));
    const res = await POST({ request: chatPost({ messages: long }) } as any);
    expect(await res.json()).toEqual({ ok: false, error: 'limit' });
    // Turns must alternate and end with the visitor (no fake assistant endings).
    expect((await POST({ request: chatPost({ messages: [{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }] }) } as any)).status).toBe(400);
    expect(requests).toHaveLength(0);
  });

  it('rate limits each visitor', async () => {
    const { POST } = await import('../src/pages/api/chat');
    const from = (ip: string) => new Request('http://site/api/chat', { method: 'POST', body: JSON.stringify(ask('hi')), headers: { 'Content-Type': 'application/json', Origin: 'http://site', 'x-real-ip': ip } });
    const statuses = [];
    for (let i = 0; i < 7; i++) statuses.push((await POST({ request: from('9.9.9.9') } as any)).status);
    expect(statuses.slice(0, 6).every((s) => s === 200)).toBe(true);
    expect(statuses[6]).toBe(429);
    expect((await POST({ request: from('8.8.8.8') } as any)).status).toBe(200);
  });

  it('is closed when the chat is switched off', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { POST } = await import('../src/pages/api/chat');
    expect((await POST({ request: chatPost(ask('hi')) } as any)).status).toBe(503);
  });
});

describe('POST /api/chat-handoff', () => {
  const handoff = (extra: Record<string, unknown> = {}, origin = 'http://site') =>
    new Request('http://site/api/chat-handoff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, 'x-real-ip': `5.5.5.${Math.random()}` },
      body: JSON.stringify({ firstName: 'Bo', lastName: 'Chan', email: 'bo@example.com', company: 'Acme', need: 'A C&Q team', jobSeeker: false, transcript: [{ role: 'user', text: 'Need a team' }, { role: 'assistant', text: 'Happy to help.' }], ...extra }),
    });

  it('emails the transcript and files a client contact with a note', async () => {
    const { POST } = await import('../src/pages/api/chat-handoff');
    expect(await (await POST({ request: handoff() } as any)).json()).toEqual({ ok: true });
    const mail = calls.find((c) => c.url.host === 'mail.test')!;
    expect(mail.body.to).toEqual(['info@technicalsource.com']);
    expect(mail.body.reply_to).toBe('bo@example.com');
    expect(mail.body.text).toContain('Visitor: Need a team');
    expect(mail.body.text).toContain('Assistant: Happy to help.');
    const create = calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/contacts'))!;
    expect(create.body.entity.RecordType).toBe(2);
    const note = calls.find((c) => c.url.pathname.endsWith('/notes'))!;
    expect(note.body.entity.ParentId).toEqual({ Id: 'contact-9', EntityName: 'Contacts' });
    expect(note.body.entity.Display).toContain('Visitor: Need a team');
  });

  it('files job seekers as candidates', async () => {
    const { POST } = await import('../src/pages/api/chat-handoff');
    await POST({ request: handoff({ jobSeeker: true }) } as any);
    expect(calls.find((c) => c.method === 'POST' && c.url.pathname.endsWith('/contacts'))!.body.entity.RecordType).toBe(1);
  });

  it('checks origin, required fields and the hidden field', async () => {
    const { POST } = await import('../src/pages/api/chat-handoff');
    expect((await POST({ request: handoff({}, 'https://evil.example') } as any)).status).toBe(403);
    expect((await POST({ request: handoff({ email: 'nope' }) } as any)).status).toBe(400);
    expect((await POST({ request: handoff({ need: '' }) } as any)).status).toBe(400);
    expect((await (await POST({ request: handoff({ website: 'spam' }) } as any)).json()).ok).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('chat answer rendering', () => {
  it('escapes HTML and only links to our own pages', async () => {
    const { render } = await import('../src/chat-render');
    expect(render('<img src=x onerror=alert(1)>')).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
    expect(render('[Jobs](/careers#jobs)')).toBe('<p><a href="/careers#jobs">Jobs</a></p>');
    expect(render('[bad](https://evil.example)')).toBe('<p>bad</p>');
    expect(render('[bad](javascript:alert(1))')).not.toContain('<a');
    expect(render('[bad](//evil.example)')).toBe('<p>bad</p>');
    expect(render('Two:\n- **One**\n- Two')).toBe('<p>Two:</p><ul><li><strong>One</strong></li><li>Two</li></ul>');
  });
});
