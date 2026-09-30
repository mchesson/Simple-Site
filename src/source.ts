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

/** One arrival, in plain words. */
function describeTouch(t: any): { how: string; landing: string; at: string } | null {
  if (!t || typeof t !== 'object') return null;
  const ref = text(t.ref, 150);
  const host = ref.split('/')[0].toLowerCase();
  const utm = t.utm && typeof t.utm === 'object' ? t.utm : {};
  const source = text(utm.source, 100), medium = text(utm.medium, 100), campaign = text(utm.campaign, 100);
  const ad = text(t.ad, 40);
  const site = SITES.find(([re]) => re.test(host))?.[1];
  // A campaign tag like "linkedin" reads as the site's usual name.
  const named = source && (SITES.find(([re]) => re.test(`${source.toLowerCase()}.com`))?.[1]?.replace(/ search$/, '') ?? `${source.charAt(0).toUpperCase()}${source.slice(1)}`);
  let how = source
    ? `${named}${medium ? ` (${medium})` : ''}`
    : ad || site || (ref ? ref : 'Direct (typed the address, a bookmark, or an app/email link)');
  if (campaign) how += `, campaign "${campaign}"`;
  if (ad && source && !how.includes(ad)) how += `, ${ad} click`;
  if (source && ref && !site) how += `, from ${ref}`;
  const landing = text(t.landing, 200);
  const at = /^\d{4}-\d{2}-\d{2}$/.test(text(t.at, 10)) ? text(t.at, 10) : '';
  return { how, landing: landing.startsWith('/') ? landing : '', at };
}

/** Lines for the email and the Crelate note ([] when nothing was sent). */
export function describeSource(raw: unknown): string[] {
  let s: any = raw;
  if (typeof raw === 'string') { try { s = JSON.parse(raw.slice(0, 4000)); } catch { return []; } }
  if (!s || typeof s !== 'object') return [];
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
