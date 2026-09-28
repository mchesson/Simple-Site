// Pillar memory: remembers which program pillar a visitor cares about and
// tailors shared pages (home, news) to it. Sources, in priority order:
//   1. ?pillar=<id> on any URL (campaign links, LinkedIn posts, QR codes)
//   2. visiting a pillar page (<body data-pillar="...">)
//   3. a value remembered from an earlier visit
// Everything degrades gracefully: without JS or storage the page shows the
// umbrella (all-pillar) version.

const KEY = 'ts-pillar';
const PILLARS = ['life-sciences', 'data-centers', 'enterprise-technology'] as const;
type Pillar = (typeof PILLARS)[number];

const isPillar = (v: unknown): v is Pillar => PILLARS.includes(v as Pillar);

function read(): Pillar | null {
  try {
    const v = localStorage.getItem(KEY);
    return isPillar(v) ? v : null;
  } catch {
    return null;
  }
}

function write(v: Pillar | null) {
  try {
    if (v) localStorage.setItem(KEY, v);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: personalization just won't persist */
  }
}

function resolve(): Pillar | null {
  const param = new URLSearchParams(location.search).get('pillar');
  if (isPillar(param)) {
    write(param);
    return param;
  }
  const page = document.body.dataset.pillar;
  if (isPillar(page)) {
    write(page);
    return page;
  }
  return read();
}

function apply(pillar: Pillar | null) {
  document.documentElement.dataset.visitorPillar = pillar ?? '';

  // Blocks that exist per pillar (e.g. the "welcome back" band on home).
  document.querySelectorAll<HTMLElement>('[data-for-pillar]').forEach((el) => {
    el.classList.toggle('is-active', el.dataset.forPillar === (pillar ?? 'none'));
  });

  // Lists whose items should put the visitor's pillar first.
  document.querySelectorAll<HTMLElement>('[data-pillar-sort]').forEach((list) => {
    const items = Array.from(list.children) as HTMLElement[];
    const original = items
      .slice()
      .sort((a, b) => Number(a.dataset.order ?? 0) - Number(b.dataset.order ?? 0));
    const sorted = pillar
      ? [
          ...original.filter((el) => el.dataset.pillar === pillar),
          ...original.filter((el) => el.dataset.pillar !== pillar),
        ]
      : original;
    sorted.forEach((el) => list.appendChild(el));
    items.forEach((el) => el.classList.toggle('is-yours', !!pillar && el.dataset.pillar === pillar));
  });
}

let current = resolve();
apply(current);

document.addEventListener('click', (e) => {
  const target = (e.target as HTMLElement).closest<HTMLElement>('[data-set-pillar]');
  if (!target) return;
  const v = target.dataset.setPillar;
  current = isPillar(v) ? v : null;
  write(current);
  if (target.tagName === 'BUTTON') apply(current);
});

// Let other scripts (news filter) read the resolved pillar.
window.dispatchEvent(new CustomEvent('ts:pillar', { detail: current }));
(window as unknown as { tsPillar: Pillar | null }).tsPillar = current;
