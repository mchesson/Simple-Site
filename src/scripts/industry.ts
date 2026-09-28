// Industry memory: remembers which industry a visitor is interested in and
// quietly tailors shared pages (homepage "Where we work" row, insight lists,
// contact form). The list of valid industries comes from <html data-industries>,
// so new industry files work without code changes. Sources, in order:
//   1. ?industry=<id> on any URL (LinkedIn posts, emails, ads, QR codes)
//   2. visiting an industry page (<body data-industry="...">)
//   3. a value remembered from an earlier visit
// Without JS or storage, pages simply show their default order.

const KEY = 'ts-industry';
const valid = (document.documentElement.dataset.industries ?? '').split(' ').filter(Boolean);
const isIndustry = (v: unknown): v is string => typeof v === 'string' && valid.includes(v);

function read(): string | null {
  try {
    const v = localStorage.getItem(KEY);
    return isIndustry(v) ? v : null;
  } catch {
    return null;
  }
}

function write(v: string | null) {
  try {
    if (v) localStorage.setItem(KEY, v);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: nothing is remembered */
  }
}

function resolve(): string | null {
  const param = new URLSearchParams(location.search).get('industry');
  if (isIndustry(param)) {
    write(param);
    return param;
  }
  const page = document.body.dataset.industry;
  if (isIndustry(page)) {
    write(page);
    return page;
  }
  return read();
}

const industry = resolve();
document.documentElement.dataset.visitorIndustry = industry ?? '';

// Highlight the visitor's industry in industry lists.
document.querySelectorAll<HTMLElement>('[data-industry-list] [data-industry]').forEach((el) => {
  el.classList.toggle('is-yours', el.dataset.industry === industry);
});

// Put the visitor's industry first in story lists, keeping the original order otherwise.
if (industry) {
  document.querySelectorAll<HTMLElement>('[data-industry-sort]').forEach((list) => {
    const items = Array.from(list.children) as HTMLElement[];
    [...items.filter((el) => el.dataset.industry === industry), ...items.filter((el) => el.dataset.industry !== industry)]
      .forEach((el) => list.appendChild(el));
  });
}
