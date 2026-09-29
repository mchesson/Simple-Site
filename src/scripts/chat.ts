// The chat bubble (src/components/Chat.astro). Shows only when /api/chat says
// the chat is on. The conversation lives in this browser tab (sessionStorage)
// and goes to /api/chat for each answer; it reaches our team only if the
// visitor asks for a person and presses Send.
import { render, esc } from '../chat-render';

type Turn = { role: 'user' | 'assistant'; text: string };
type JobLink = { title: string; location: string; url: string };
type Handoff = { first_name?: string; last_name?: string; email?: string; phone?: string; company?: string; need?: string; looking_for_work?: boolean };

const root = document.getElementById('chat');
const KEY = 'ts-chat';
const LIMIT_TEXT = 'This chat has reached its length limit. Please start a new chat, or talk to a person.';

if (root) {
  // Ask the server once per tab whether the chat is on.
  let known: string | null = null;
  try { known = sessionStorage.getItem(KEY + '-on'); } catch {}
  if (known === '1') start(root);
  else if (known !== '0') {
    fetch('/api/chat', { headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        try { sessionStorage.setItem(KEY + '-on', s?.enabled ? '1' : '0'); } catch {}
        if (s?.enabled) start(root);
      })
      .catch(() => {});
  }
}

function start(root: HTMLElement) {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const openBtn = $<HTMLButtonElement>('chat-open');
  const panel = $<HTMLElement>('chat-panel');
  const log = $<HTMLElement>('chat-log');
  const form = $<HTMLFormElement>('chat-form');
  const input = $<HTMLTextAreaElement>('chat-text');
  const sendBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const greeting = log.innerHTML;

  let turns: Turn[] = [];
  try { turns = JSON.parse(sessionStorage.getItem(KEY) ?? '[]'); } catch {}
  const save = () => { try { sessionStorage.setItem(KEY, JSON.stringify(turns)); } catch {} };
  let busy = false;
  let handoffShown: HTMLElement | null = null;

  root.hidden = false;

  const open = (yes: boolean) => {
    panel.hidden = !yes;
    openBtn.setAttribute('aria-expanded', String(yes));
    if (yes) { input.focus(); log.scrollTop = log.scrollHeight; } else openBtn.focus();
    try { sessionStorage.setItem(KEY + '-open', yes ? '1' : ''); } catch {}
  };
  openBtn.addEventListener('click', () => open(true));
  $('chat-close').addEventListener('click', () => open(false));
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') open(false); });
  $('chat-new').addEventListener('click', () => {
    if (busy) return;
    turns = []; save(); log.innerHTML = greeting; input.focus();
  });
  root.querySelectorAll('[data-handoff]').forEach((b) => b.addEventListener('click', () => { open(true); showHandoff({}); }));

  // Earlier messages in this tab.
  for (const t of turns) addMessage(t.role, t.text);
  try { if (sessionStorage.getItem(KEY + '-open')) open(true); } catch {}

  input.addEventListener('input', grow);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  function grow() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 128)}px`; }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || busy) return;
    busy = true; sendBtn.disabled = true;
    input.value = ''; grow();
    turns.push({ role: 'user', text });
    addMessage('user', text);
    const reply = addMessage('assistant', '');
    reply.classList.add('chat-typing');
    let answer = '';
    let failed = '';
    handoffShown = null;
    try {
      const res = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: turns }) });
      if (!res.ok || !res.body) {
        const out = await res.json().catch(() => ({}));
        failed = out.error === 'limit' ? LIMIT_TEXT : out.error && res.status !== 403 && res.status !== 503 ? out.error : 'Sorry, the chat isn’t available right now. Please use our contact form.';
      } else {
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            const ev = JSON.parse(line);
            if (ev.t === 'text') { answer += ev.v; reply.innerHTML = render(answer); }
            else if (ev.t === 'jobs') addJobs(ev.v);
            else if (ev.t === 'handoff') showHandoff(ev.v);
            else if (ev.t === 'error') failed = ev.v;
            log.scrollTop = log.scrollHeight;
          }
        }
      }
    } catch {
      failed = 'Sorry, something went wrong. Please try again.';
    }
    reply.classList.remove('chat-typing');
    if (answer.trim()) {
      turns.push({ role: 'assistant', text: answer });
    } else {
      // No answer: take the visitor's message back out so the next try works.
      turns.pop();
      reply.classList.add('error');
      reply.innerHTML = `<p>${esc(failed || 'Sorry, I didn’t catch that. Please try again.')}</p>`;
    }
    save();
    busy = false; sendBtn.disabled = false;
    log.scrollTop = log.scrollHeight;
    // A form to check: show it from the top (the name fields).
    if (handoffShown) log.scrollTop += handoffShown.getBoundingClientRect().top - log.getBoundingClientRect().top - 12;
  });

  function addMessage(role: Turn['role'], text: string) {
    const el = document.createElement('div');
    el.className = `chat-msg ${role === 'user' ? 'user' : 'bot'}`;
    if (role === 'user') el.textContent = text; else el.innerHTML = render(text);
    log.append(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function addJobs(jobs: JobLink[]) {
    const ul = document.createElement('ul');
    ul.className = 'chat-jobs';
    for (const j of jobs) {
      if (!j.url.startsWith('/careers/jobs/')) continue;
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = j.url;
      a.textContent = j.title;
      if (j.location) { const s = document.createElement('small'); s.textContent = j.location; a.append(s); }
      li.append(a); ul.append(li);
    }
    const wrap = document.createElement('div');
    wrap.className = 'chat-msg bot';
    wrap.append(ul);
    log.append(wrap);
  }

  // "Talk to a person": the details for the visitor to check, then Send.
  function showHandoff(d: Handoff) {
    log.querySelector('.chat-handoff:not(.sent)')?.remove();
    const f = document.createElement('form');
    f.className = 'chat-handoff form';
    f.noValidate = false;
    f.innerHTML = `
      <h3>Send to Our Team</h3>
      <p>Check your details and press Send. We’ll include this chat so you don’t have to repeat yourself.</p>
      <div class="pair">
        <label>First Name<input name="firstName" required autocomplete="given-name" maxlength="80"></label>
        <label>Last Name<input name="lastName" required autocomplete="family-name" maxlength="80"></label>
      </div>
      <label>Email<input name="email" type="email" required autocomplete="email" maxlength="200"></label>
      <div class="pair">
        <label>Phone (optional)<input name="phone" type="tel" autocomplete="tel" maxlength="40"></label>
        <label>Company (optional)<input name="company" autocomplete="organization" maxlength="200"></label>
      </div>
      <label>How Can We Help?<textarea name="need" rows="3" required maxlength="2000"></textarea></label>
      <label class="check"><input type="checkbox" name="jobSeeker"> I’m looking for work</label>
      <div class="hp" aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off"></label></div>
      <div class="row"><button class="btn btn-primary" type="submit">Send</button><button class="chat-link" type="button" data-cancel>Cancel</button></div>
      <p class="status" role="status" hidden></p>`;
    const set = (name: string, v?: string) => { const el = f.elements.namedItem(name) as HTMLInputElement | null; if (el && v) el.value = v; };
    set('firstName', d.first_name); set('lastName', d.last_name); set('email', d.email);
    set('phone', d.phone); set('company', d.company); set('need', d.need);
    (f.elements.namedItem('jobSeeker') as HTMLInputElement).checked = Boolean(d.looking_for_work);
    f.querySelector('[data-cancel]')!.addEventListener('click', () => f.remove());
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const status = f.querySelector<HTMLElement>('.status')!;
      const btn = f.querySelector<HTMLButtonElement>('button[type="submit"]')!;
      const data = Object.fromEntries(new FormData(f)) as Record<string, string>;
      btn.disabled = true; btn.textContent = 'Sending…';
      try {
        const res = await fetch('/api/chat-handoff', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...data, jobSeeker: Boolean(data.jobSeeker), page: location.pathname, transcript: turns }),
        });
        const out = await res.json().catch(() => ({}));
        if (out.ok) {
          f.classList.add('sent');
          f.innerHTML = '<h3>Thank You</h3><p>Your message is on its way to our team. Someone will follow up by email.</p>';
          return;
        }
        status.dataset.kind = 'error';
        status.textContent = out.error && res.status === 400 ? out.error : 'Sorry, that didn’t go through. Please email info@technicalsource.com.';
        status.hidden = false;
      } catch {
        status.dataset.kind = 'error';
        status.textContent = 'Sorry, that didn’t go through. Please email info@technicalsource.com.';
        status.hidden = false;
      }
      btn.disabled = false; btn.textContent = 'Send';
    });
    log.append(f);
    handoffShown = f;
    log.scrollTop = log.scrollHeight;
    (f.querySelector('input:invalid, textarea:invalid') as HTMLElement | null)?.focus();
  }
}
