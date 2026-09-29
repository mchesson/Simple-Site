// Runtime for the single-file preview (scripts/preview-bundle.py): a hash router
// plus plain-JS ports of the site's page scripts (industry memory, insights
// filter, LinkedIn copy button, form preselect). Keep in sync with
// src/scripts/industry.ts and the <script> blocks in src/pages.
(function () {
  const PAGES = JSON.parse(document.getElementById('pages').textContent);
  const main = document.getElementById('main');
  const KEY = 'ts-industry';
  const valid = (document.documentElement.dataset.industries || '').split(' ').filter(Boolean);
  const isIndustry = (v) => valid.includes(v);
  let memory = null; // fallback when storage is blocked

  function read() {
    try { const v = localStorage.getItem(KEY); return isIndustry(v) ? v : null; } catch { return memory; }
  }
  function write(v) {
    memory = v;
    try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch {}
  }

  function applyIndustry(industry) {
    document.documentElement.dataset.visitorIndustry = industry || '';
    main.querySelectorAll('[data-industry-list] [data-industry]').forEach((el) => {
      el.classList.toggle('is-yours', el.dataset.industry === industry);
    });
    if (!industry) return;
    main.querySelectorAll('[data-industry-sort]').forEach((list) => {
      const items = Array.from(list.children);
      [...items.filter((el) => el.dataset.industry === industry), ...items.filter((el) => el.dataset.industry !== industry)]
        .forEach((el) => list.appendChild(el));
    });
  }

  function initFilters(q) {
    const buttons = Array.from(main.querySelectorAll('[data-filter]'));
    if (!buttons.length) return;
    const cards = Array.from(main.querySelectorAll('#stories > li'));
    const empty = main.querySelector('.empty');
    const show = (f) => {
      let n = 0;
      cards.forEach((c) => { const on = f === 'all' || c.dataset.industry === f; c.classList.toggle('is-hidden', !on); if (on) n++; });
      buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.filter === f)));
      if (empty) empty.hidden = n > 0;
    };
    buttons.forEach((b) => b.addEventListener('click', () => show(b.dataset.filter)));
    const p = q.get('industry');
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

  function initSelect(q) {
    const sel = main.querySelector('#industry-select');
    const p = q.get('industry') || document.documentElement.dataset.visitorIndustry;
    const opt = sel && p ? Array.from(sel.options).find((o) => o.dataset.id === p || o.value === p) : null;
    if (opt) sel.value = opt.value;
  }

  // Forms need the live site; explain that in the preview.
  function initPreviewOnly() {
    main.querySelectorAll('form[data-form]').forEach((form) => {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const st = form.querySelector('.status');
        if (st) { st.hidden = false; st.dataset.kind = 'ok'; st.textContent = 'Preview only: forms send to Crelate on the live site.'; }
      });
    });
  }

  function parse() {
    const h = location.hash.slice(1) || '/';
    if (!h.startsWith('/')) return null; // in-page anchor like #jobs
    const [pathAndAnchor, query = ''] = h.split('?');
    const [path, anchor] = pathAndAnchor.split('#');
    return { path: path.replace(/\/$/, '') || '/', anchor, q: new URLSearchParams(query) };
  }

  function render() {
    const r = parse();
    if (!r) return;
    const page = PAGES[r.path] || PAGES['/404'];
    main.innerHTML = page.html;
    document.title = page.title;
    if (page.industry) document.body.dataset.industry = page.industry; else delete document.body.dataset.industry;
    document.getElementById('preview-route').textContent = r.path;
    document.querySelectorAll('.nav-desktop a[href^="#/"]').forEach((a) => {
      const target = a.getAttribute('href').slice(1).split('#')[0];
      if (target !== '/' && r.path.startsWith(target)) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    document.querySelectorAll('details.nav-mobile').forEach((d) => (d.open = false));

    const param = r.q.get('industry');
    let industry;
    if (isIndustry(param)) { write(param); industry = param; }
    else if (isIndustry(page.industry)) { write(page.industry); industry = page.industry; }
    else industry = read();
    applyIndustry(industry);
    initFilters(r.q);
    initCopy();
    initSelect(r.q);
    initPreviewOnly();
    const target = r.anchor && document.getElementById(r.anchor);
    if (target) target.scrollIntoView(); else window.scrollTo(0, 0);
  }

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-preview-disabled]')) e.preventDefault();
  });
  document.getElementById('preview-reset').addEventListener('click', () => { write(null); render(); });

  window.addEventListener('hashchange', render);
  render();
})();
