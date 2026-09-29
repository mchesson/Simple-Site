// Scroll motion (visual option D), on every page:
//   - banner headline words rise in one after another
//   - headings, text and content items below the fold fade up as they scroll into view
//   - numbers with data-count ("10+") count up when reached
//   - the chevron shape inside .photo blocks drifts as the page scrolls
// Content is never hidden without JavaScript, and nothing moves for visitors
// who turn on "reduce motion" in their device settings. Only opacity and
// transform change, so the layout never shifts.
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

if (!still) {
  document.documentElement.classList.add('motion');

  // Banner headline: split into words that rise in turn (keeps the green highlight).
  const h1 = document.querySelector<HTMLElement>('.banner h1');
  if (h1) {
    let i = 0;
    const wrap = (node: Node) => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === Node.TEXT_NODE) {
          const frag = document.createDocumentFragment();
          for (const part of (child.textContent ?? '').split(/(\s+)/)) {
            if (!part.trim()) { frag.append(part); continue; }
            const w = document.createElement('span');
            w.className = 'word';
            w.style.animationDelay = `${0.06 * i++}s`;
            w.textContent = part;
            frag.append(w);
          }
          child.replaceWith(frag);
        } else if (child.nodeType === Node.ELEMENT_NODE && (child as Element).tagName !== 'BR') wrap(child);
      }
    };
    wrap(h1);
  }

  // Fade up whatever is below the fold. Items in the same row stagger.
  const targets = document.querySelectorAll<HTMLElement>(
    'main .sec h2, main .sec .lede, main .sec .card, main .sec .steps > li, main .ind, main .story-grid > li, main .sec .photo, main .careers-strip .inner, main .cta .wrap > *',
  );
  const fold = innerHeight * 0.9;
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
    },
    { rootMargin: '0px 0px -8% 0px' },
  );
  targets.forEach((el) => {
    if (el.getBoundingClientRect().top < fold) return; // already on screen: leave it
    const siblings = el.parentElement ? [...el.parentElement.children] : [];
    el.style.transitionDelay = `${Math.min(siblings.indexOf(el), 4) * 0.08}s`;
    el.classList.add('reveal');
    io.observe(el);
  });

  // Count-up numbers: <p data-count="10" data-suffix="+">10+</p>
  const counters = document.querySelectorAll<HTMLElement>('[data-count]');
  const countIo = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      countIo.unobserve(e.target);
      const el = e.target as HTMLElement;
      const to = Number(el.dataset.count), suffix = el.dataset.suffix ?? '', t0 = performance.now();
      const step = (t: number) => {
        const k = Math.min(1, (t - t0) / 1400);
        el.textContent = `${Math.round(to * (1 - Math.pow(1 - k, 3)))}${suffix}`;
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
  }, { threshold: 0.6 });
  counters.forEach((el) => countIo.observe(el));

  // Photo blocks: the chevron inside drifts slightly with the scroll.
  const photos = [...document.querySelectorAll<HTMLElement>('main .sec .photo')];
  if (photos.length) {
    let queued = false;
    const drift = () => {
      queued = false;
      for (const p of photos) {
        const r = p.getBoundingClientRect();
        p.style.setProperty('--drift', ((r.top + r.height / 2) / innerHeight - 0.5).toFixed(3));
      }
    };
    addEventListener('scroll', () => { if (!queued) { queued = true; requestAnimationFrame(drift); } }, { passive: true });
    drift();
  }
}
