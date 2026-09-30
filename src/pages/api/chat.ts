// /api/chat: the website chat assistant (src/assistant.ts).
//   GET   { enabled }: the chat bubble shows only when this says true
//   GET   ?check=1: which key name, environment and switch it sees (no values)
//   GET   ?check=2: one short test question to Claude; its answer or error
//   POST  { messages: [{ role, text }...] } → the answer, streamed as one JSON
//         object per line: text pieces, job links, a handoff form, done.
// Protections: same-site requests only (Origin), a per-visitor rate limit,
// and caps on message and conversation length (LIMITS). Conversations are
// never stored or logged here.
import type { APIRoute } from 'astro';
import { chatEnabled, keyName, describeError, runChat, LIMITS, type ChatEvent, type ChatTurn } from '../../assistant';
import { json, sameOrigin, visitor, rateLimiter } from './_shared';

export const prerender = false;

const perMinute = rateLimiter(6, 1);
const perDay = rateLimiter(80, 24 * 60);

export const GET: APIRoute = async ({ url, request } = {} as any) => {
  // ?check=1: which settings the chat sees (names only, never the key).
  if (url?.searchParams.get('check') === '1') {
    const similar = Object.keys(process.env).filter((k) => /anthropic/i.test(k));
    return json({ enabled: chatEnabled(), keyFoundAs: keyName(), similarNames: similar, chatEnabledSetting: process.env.CHAT_ENABLED ?? null, vercelEnvironment: process.env.VERCEL_ENV ?? null }, 200, { 'Cache-Control': 'no-store' });
  }
  // ?check=2: sends Claude one short test question and reports whether it
  // answered, or Claude's own error message (e.g. a bad key or no credit).
  if (url?.searchParams.get('check') === '2') {
    if (!chatEnabled()) return json({ ok: false, error: 'disabled' }, 200, { 'Cache-Control': 'no-store' });
    if (!perMinute(`check:${visitor(request)}`)) return json({ ok: false, error: 'Too many checks. Wait a minute.' }, 429);
    let answer = '';
    try {
      await runChat([{ role: 'user', text: 'In one short sentence, what does Technical Source do?' }], (e) => { if (e.t === 'text') answer += e.v; });
      return json({ ok: true, answer }, 200, { 'Cache-Control': 'no-store' });
    } catch (e) {
      return json({ ok: false, claudeError: describeError(e) }, 200, { 'Cache-Control': 'no-store' });
    }
  }
  return json({ enabled: chatEnabled() }, 200, { 'Cache-Control': 'no-store' });
};

/** Checks the conversation the browser sent; returns it clean, or an error. */
export function readConversation(body: unknown): ChatTurn[] | string {
  const list = (body as any)?.messages;
  if (!Array.isArray(list) || !list.length) return 'Please type a message.';
  const turns: ChatTurn[] = [];
  for (const m of list) {
    const role = m?.role, text = typeof m?.text === 'string' ? m.text.trim() : '';
    if ((role !== 'user' && role !== 'assistant') || !text) return 'That conversation can’t be read. Please start a new chat.';
    if (role === 'user' && text.length > LIMITS.messageChars) return `Please keep messages under ${LIMITS.messageChars} characters.`;
    turns.push({ role, text: text.slice(0, 6000) });
  }
  // Turns alternate, starting and ending with the visitor.
  if (turns.some((t, i) => t.role !== (i % 2 ? 'assistant' : 'user')) || turns.at(-1)!.role !== 'user') return 'That conversation can’t be read. Please start a new chat.';
  if (turns.filter((t) => t.role === 'user').length > LIMITS.userTurns || turns.reduce((n, t) => n + t.text.length, 0) > LIMITS.totalChars) return 'limit';
  return turns;
}

export const POST: APIRoute = async ({ request }) => {
  if (!sameOrigin(request)) return json({ ok: false, error: 'forbidden' }, 403);
  if (!chatEnabled()) return json({ ok: false, error: 'disabled' }, 503);
  const who = visitor(request);
  if (!perMinute(who) || !perDay(who)) return json({ ok: false, error: 'Too many messages. Please wait a moment and try again.' }, 429);

  const turns = readConversation(await request.json().catch(() => null));
  if (turns === 'limit') return json({ ok: false, error: 'limit' }, 400);
  if (typeof turns === 'string') return json({ ok: false, error: turns }, 400);

  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      const emit = (e: ChatEvent) => controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
      try {
        await runChat(turns, emit);
        emit({ t: 'done' });
      } catch (e) {
        // The error type and status only: never the conversation.
        console.error('[chat] failed', JSON.stringify(describeError(e)));
        emit({ t: 'error', v: 'Sorry, something went wrong. Please try again, or use our contact form.' });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(body, { headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' } });
};
