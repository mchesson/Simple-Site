// "How they found us" for the team: turns what src/scripts/source.ts sent
// with a form into short lines for the email and the Crelate note, e.g.
//   How they found us: LinkedIn, campaign "pharma-q4" (first visit 2026-09-28, landed on /industries/life-sciences)
//   This visit: Google search (landed on /careers, 4 pages viewed)
// Everything the browser sends is checked and shortened; bad input is ignored.

// Referring sites people recognise, by host.
const SITES: [RegExp, string][] = [
  [/(^|\.)google\./, 'Google search'],
  [/(^|\.)bing\.com$/, 'Bing search'],
  [/(^|\.)duckduckgo\.com$/, 'DuckDuckGo search'],
  [/(^|\.)yahoo\.com$/, 'Yahoo search'],
  [/(^|\.)(linkedin\.com|lnkd\.in)$/, 'LinkedIn'],
  [/(^|\.)(facebook\.com|fb\.com|m\.facebook\.com)$/, 'Facebook'],
  [/(^|\.)instagram\.com$/, 'Instagram'],
  [/(^|\.)(twitter\.com|x\.com|t\.co)$/, 'X (Twitter)'],
  [/(^|\.)youtube\.com$/, 'YouTube'],
  [/(^|\.)indeed\.com$/, 'Indeed'],
  [/(^|\.)glassdoor\.com$/, 'Glassdoor'],
  [/(^|\.)ziprecruiter\.com$/, 'ZipRecruiter'],
  [/(^|\.)(chatgpt\.com|openai\.com)$/, 'ChatGPT'],
  [/(^|\.)claude\.ai$/, 'Claude'],
  [/(^|\.)perplexity\.ai$/, 'Perplexity'],
  [/(^|\.)(outlook\.|mail\.|office\.com)/, 'Email link'],
];

const text = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n) : '');

/** The checked pieces of one arrival. */
function touchParts(t: any) {
  if (!t || typeof t !== 'object') return null;
  const ref = text(t.ref, 150);
  const host = ref.split('/')[0].toLowerCase();
  const utm = t.utm && typeof t.utm === 'object' ? t.utm : {};
  const source = text(utm.source, 100), medium = text(utm.medium, 100), campaign = text(utm.campaign, 100);
  const ad = text(t.ad, 40);
  const site = SITES.find(([re]) => re.test(host))?.[1];
  // A campaign tag like "linkedin" reads as the site's usual name.
  const named = source && (SITES.find(([re]) => re.test(`${source.toLowerCase()}.com`))?.[1]?.replace(/ search$/, '') ?? `${source.charAt(0).toUpperCase()}${source.slice(1)}`);
  const landing = text(t.landing, 200);
  const at = /^\d{4}-\d{2}-\d{2}$/.test(text(t.at, 10)) ? text(t.at, 10) : '';
  return { ref, source, medium, campaign, ad, site, named, landing: landing.startsWith('/') ? landing : '', at };
}

/** One arrival, in plain words. */
function describeTouch(t: any): { how: string; landing: string; at: string } | null {
  const p = touchParts(t);
  if (!p) return null;
  const { ref, source, medium, campaign, ad, site, named, landing, at } = p;
  let how = source
    ? `${named}${medium ? ` (${medium})` : ''}`
    : ad || site || (ref ? ref : 'Direct (typed the address, a bookmark, or an app/email link)');
  if (campaign) how += `, campaign "${campaign}"`;
  if (ad && source && !how.includes(ad)) how += `, ${ad} click`;
  if (source && ref && !site) how += `, from ${ref}`;
  return { how, landing, at };
}

const parse = (raw: unknown): any => {
  if (typeof raw === 'string') { try { return JSON.parse(raw.slice(0, 4000)); } catch { return null; } }
  return raw && typeof raw === 'object' ? raw : null;
};

/** Lines for the email and the Crelate note ([] when nothing was sent). */
export function describeSource(raw: unknown): string[] {
  const s = parse(raw);
  if (!s) return [];
  const first = describeTouch(s.first), visit = describeTouch(s.visit);
  const pages = Math.max(0, Math.min(999, Math.floor(Number(s.pages) || 0)));
  const industry = text(s.industry, 60).replace(/[^a-z0-9-]/gi, '');
  const lines: string[] = [];
  const same = first && visit && first.how === visit.how && first.at === visit.at && first.landing === visit.landing;
  if (first) lines.push(`How they found us: ${first.how}${first.at || first.landing ? ` (first visit${first.at ? ` ${first.at}` : ''}${first.landing ? `, landed on ${first.landing}` : ''})` : ''}`);
  if (visit && !same) lines.push(`This visit: ${visit.how}${visit.landing ? ` (landed on ${visit.landing}${pages ? `, ${pages} page${pages === 1 ? '' : 's'} viewed` : ''})` : ''}`);
  else if (pages) lines.push(`Pages viewed this visit: ${pages}`);
  if (industry) lines.push(`Industry of interest: ${industry}`);
  return lines;
}

/** "How they found us" as TS Workspace's intake fields (docs/website-intake.md
 *  in the ts-ats repo), from the first visit (or this visit if there's no
 *  first). The browser keeps only a page count, not the list of pages, so
 *  pagesViewed is never sent. Empty values are left out. */
export type Attribution = {
  channel?: string; source?: string; medium?: string; campaign?: string; firstVisit?: string;
  landingPage?: string; referrer?: string; industryOfInterest?: string;
};
const SOCIAL = new Set(['LinkedIn', 'Facebook', 'Instagram', 'X (Twitter)', 'YouTube']);
const JOB_BOARDS = new Set(['Indeed', 'Glassdoor', 'ZipRecruiter']);
const AI = new Set(['ChatGPT', 'Claude', 'Perplexity']);

export function sourceAttribution(raw: unknown): Attribution {
  const s = parse(raw);
  if (!s) return {};
  const p = touchParts(s.first) ?? touchParts(s.visit);
  const industry = text(s.industry, 60).replace(/[^a-z0-9-]/gi, '');
  const out: Attribution = {};
  if (p) {
    const { ref, source, medium, campaign, ad, site, named, landing, at } = p;
    out.source = source ? named : ad || site || (ref ? ref.split('/')[0] : 'Direct');
    out.channel = medium ? medium.toLowerCase()
      : ad ? 'paid'
      : site?.endsWith(' search') ? 'search'
      : site && SOCIAL.has(site) ? 'social'
      : site && JOB_BOARDS.has(site) ? 'job board'
      : site && AI.has(site) ? 'ai assistant'
      : site === 'Email link' ? 'email'
      : ref ? 'referral' : source ? 'campaign' : 'direct';
    if (medium) out.medium = medium;
    if (campaign) out.campaign = campaign;
    if (at && s.first) out.firstVisit = at;
    if (landing) out.landingPage = landing;
    if (ref) out.referrer = ref;
  }
  // The industry id ("life-sciences") in words ("Life Sciences").
  if (industry) out.industryOfInterest = industry.split('-').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return out;
}
