// Sends [data-form] forms to their endpoint (src/pages/api/) and shows the
// result in the form's .status element. Without JavaScript the forms still
// post normally and the endpoint redirects back with ?form=sent|error.
const messages: Record<string, string> = {
  sent: 'Thank you. We’ll be in touch soon.',
  'not-configured': 'Our online form isn’t connected yet. Please email us at info@technicalsource.com.',
  error: 'Something went wrong sending your message. Please try again or email info@technicalsource.com.',
};

function show(form: HTMLFormElement, kind: 'ok' | 'error', text: string) {
  const status = form.querySelector<HTMLElement>('.status');
  if (!status) return;
  status.hidden = false;
  status.dataset.kind = kind;
  status.textContent = text;
}

document.querySelectorAll<HTMLFormElement>('form[data-form]').forEach((form) => {
  const page = form.querySelector<HTMLInputElement>('input[name="page"]');
  if (page) page.value = location.pathname + location.search;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    const label = button?.textContent;
    if (button) { button.disabled = true; button.textContent = 'Sending…'; }
    try {
      const res = await fetch(form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      const out = await res.json().catch(() => ({}));
      if (out.ok) {
        form.reset();
        show(form, 'ok', form.dataset.success ?? messages.sent);
      } else {
        show(form, 'error', out.error === 'not-configured' ? messages['not-configured'] : out.error && res.status === 400 ? out.error : messages.error);
      }
    } catch {
      show(form, 'error', messages.error);
    } finally {
      if (button) { button.disabled = false; button.textContent = label ?? 'Send'; }
    }
  });
});

// Result of a non-JavaScript post (?form=sent|error).
const result = new URLSearchParams(location.search).get('form');
const first = document.querySelector<HTMLFormElement>('form[data-form]');
if (first && (result === 'sent' || result === 'error')) {
  show(first, result === 'sent' ? 'ok' : 'error', result === 'sent' ? (first.dataset.success ?? messages.sent) : messages.error);
}
