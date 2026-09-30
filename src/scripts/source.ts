// "How they found us": remembers where a visitor came from, so the forms and
// the chat's "talk to a person" can tell the team (email + Crelate note).
// Kept only in the visitor's own browser; it leaves the browser only inside a
// form the visitor sends. Nothing is tracked or sent otherwise.
//   - first visit (localStorage, 90 days): how they first found the site
//   - this visit (sessionStorage): how they arrived today
// Each holds: the referring site, campaign tags (utm_*), ad click markers
// (gclid, fbclid, li_fat_id, msclkid), the landing page, and the date.
// Read by src/scripts/forms.ts and src/scripts/chat.ts via readSource().
export type Touch = { ref: string; utm: Record<string, string>; ad: string; landing: string; at: string };
export type Source = { first: Touch | null; visit: Touch | null; pages: number; industry: string };

const FIRST = 'ts-source-first', VISIT = 'ts-source-visit', PAGES = 'ts-source-pages';
const DAYS_90 = 90 * 24 * 60 * 60 * 1000;
const cut = (s: string, n: number) => s.slice(0, n);

function touch(): Touch {
  const q = new URLSearchParams(location.search);
  const utm: Record<string, string> = {};
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) {
    const v = q.get(k);
    if (v) utm[k.slice(4)] = cut(v, 100);
  }
  const ad = q.has('gclid') ? 'Google Ads' : q.has('msclkid') ? 'Microsoft Ads' : q.has('li_fat_id') ? 'LinkedIn Ads' : q.has('fbclid') ? 'Facebook' : '';
  let ref = '';
  try {
    const r = new URL(document.referrer);
    if (r.host !== location.host) ref = cut(r.host + (r.pathname === '/' ? '' : r.pathname), 150);
  } catch { /* no referrer: typed in, bookmark, app or email */ }
  // Landing page without ad click IDs and campaign tags (already kept above).
  for (const k of ['gclid', 'msclkid', 'li_fat_id', 'fbclid', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) q.delete(k);
  const qs = q.toString();
  return { ref, utm, ad, landing: cut(location.pathname + (qs ? `?${qs}` : ''), 200), at: new Date().toISOString().slice(0, 10) };
}

const get = (store: Storage, key: string) => { try { return JSON.parse(store.getItem(key) ?? 'null'); } catch { return null; } };
const set = (store: Storage, key: string, v: unknown) => { try { store.setItem(key, JSON.stringify(v)); } catch { /* storage off: nothing kept */ } };

// Record on every page load: the first page of a visit starts a new "visit".
(() => {
  const visit = get(sessionStorage, VISIT);
  if (!visit) {
    const t = touch();
    set(sessionStorage, VISIT, t);
    const first = get(localStorage, FIRST);
    if (!first || Date.now() - Date.parse(first.at) > DAYS_90) set(localStorage, FIRST, t);
  }
  set(sessionStorage, PAGES, (Number(get(sessionStorage, PAGES)) || 0) + 1);
})();

export function readSource(): Source {
  return {
    first: get(localStorage, FIRST),
    visit: get(sessionStorage, VISIT),
    pages: Number(get(sessionStorage, PAGES)) || 0,
    industry: document.documentElement.dataset.visitorIndustry ?? '',
  };
}
