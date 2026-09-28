// Runtime for the single-file preview (scripts/preview-bundle.py): a hash router
// plus plain-JS ports of the site's page scripts (pillar memory, news filter,
// LinkedIn copy button, contact preselect). Keep in sync with src/scripts/pillar.ts.
(function () {
  const PAGES = JSON.parse(document.getElementById('pages').textContent);
  const main = document.getElementById('main');
  const KEY = 'ts-pillar';
  const PILLARS = ['life-sciences', 'data-centers', 'enterprise-technology'];
  const isPillar = (v) => PILLARS.includes(v);
  let memory = null; // fallback when storage is blocked

  function read() {
    try { const v = localStorage.getItem(KEY); return isPillar(v) ? v : null; } catch { return memory; }
  }
  function write(v) {
    memory = v;
    try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch {}
  }

  function applyPillar(pillar) {
    document.documentElement.dataset.visitorPillar = pillar || '';
    document.querySelectorAll('[data-for-pillar]').forEach((el) => {
      el.classList.toggle('is-active', el.dataset.forPillar === (pillar || 'none'));
    });
    document.querySelectorAll('[data-pillar-sort]').forEach((list) => {
      const items = Array.from(list.children);
      const original = items.slice().sort((a, b) => Number(a.dataset.order || 0) - Number(b.dataset.order || 0));
      const sorted = pillar
        ? [...original.filter((el) => el.dataset.pillar === pillar), ...original.filter((el) => el.dataset.pillar !== pillar)]
        : original;
      sorted.forEach((el) => list.appendChild(el));
      items.forEach((el) => el.classList.toggle('is-yours', !!pillar && el.dataset.pillar === pillar));
    });
  }

  function initNews(q) {
    const buttons = Array.from(main.querySelectorAll('[data-filter]'));
    if (!buttons.length) return;
    const cards = Array.from(main.querySelectorAll('#stories > li'));
    const empty = main.querySelector('.empty');
    const show = (f) => {
      let n = 0;
      cards.forEach((c) => { const on = f === 'all' || c.dataset.pillar === f; c.classList.toggle('is-hidden', !on); if (on) n++; });
      buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === f)));
      if (empty) empty.hidden = n > 0;
    };
    buttons.forEach((b) => b.addEventListener('click', () => show(b.dataset.filter)));
    const p = q.get('pillar');
    if (p && buttons.some((b) => b.dataset.filter === p)) show(p);
  }

  function initCopy() {
    main.querySelectorAll('[data-copy]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const label = btn.textContent;
        try { await navigator.clipboard.writeText(btn.dataset.copy || ''); btn.textContent = 'Copied. Paste into LinkedIn'; }
        catch { btn.textContent = 'Copy is blocked in this preview'; }
        setTimeout(() => (btn.textContent = label), 2500);
      });
    });
  }

  function initContact(q) {
    const sel = main.querySelector('#pillar-select');
    const p = q.get('pillar') || document.documentElement.dataset.visitorPillar;
    if (sel && p && Array.from(sel.options).some((o) => o.value === p)) sel.value = p;
  }

  function parse() {
    const h = location.hash.slice(1) || '/';
    if (!h.startsWith('/')) return null; // in-page anchor like #programs
    const [path, query = ''] = h.split('?');
    return { path: path.replace(/\/$/, '') || '/', q: new URLSearchParams(query) };
  }

  function render() {
    const r = parse();
    if (!r) return;
    const page = PAGES[r.path] || PAGES['/404'];
    main.innerHTML = page.html;
    document.title = page.title;
    if (page.pillar) document.body.dataset.pillar = page.pillar; else delete document.body.dataset.pillar;
    document.getElementById('preview-route').textContent = r.path;
    document.querySelectorAll('.site-header a[href^="#/"]').forEach((a) => {
      const target = a.getAttribute('href').slice(1);
      if (target !== '/' && r.path.startsWith(target)) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    document.querySelectorAll('details.menu').forEach((d) => (d.open = false));

    const param = r.q.get('pillar');
    let pillar;
    if (isPillar(param)) { write(param); pillar = param; }
    else if (isPillar(page.pillar)) { write(page.pillar); pillar = page.pillar; }
    else pillar = read();
    applyPillar(pillar);
    initNews(r.q);
    initCopy();
    initContact(r.q);
    window.scrollTo(0, 0);
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-set-pillar]');
    if (t) {
      const v = t.dataset.setPillar;
      write(isPillar(v) ? v : null);
      if (t.tagName === 'BUTTON') applyPillar(read());
    }
    const off = e.target.closest('[data-preview-disabled]');
    if (off) e.preventDefault();
  });
  document.getElementById('preview-reset').addEventListener('click', () => { write(null); applyPillar(null); });

  window.addEventListener('hashchange', render);
  render();
})();
