// Site check: opens every page in a real browser (desktop and phone) and
// reports anything broken. Part of `npm test`; also runs against the live site.
//
//   npm test                         unit tests + this check on a local build
//   npm run check:site               this check only (builds and serves locally)
//   BASE=https://simple-site-gules.vercel.app npm run check:site   the live site
//
// Checks on every page reachable from the homepage:
//   - loads (200), no script errors, no broken links or missing files
//   - nothing wider than the screen at 390px (phone) and 1366px (desktop)
//   - a unique <title>, a meta description, one <h1>, a canonical link
//   - images have alt text; no serious accessibility problems (axe-core)
//   - scroll motion finishes (nothing left hidden)
//   - site rules from CLAUDE.md: no phone numbers, no Raleigh/headquarters,
//     no "Your industry" tag, no "To be confirmed"
// Live only: /api/jobs returns jobs, a job page shows the facts row and the
// application form, /api/chat answers (and refuses other sites), and
// robots.txt answers.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const live = Boolean(process.env.BASE);
const BASE = (process.env.BASE || 'http://localhost:4322').replace(/\/$/, '');
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const problems = [];
const problem = (page, what) => problems.push(`${page}: ${what}`);

// Site rules (CLAUDE.md). Text only, not markup.
// The Raleigh rule is about our own wording: a job that is located in Raleigh
// may say so (job list items, and a job page's banner, facts and posting).
const RULES = [
  [/\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/, 'shows a phone number'],
  [/\bRaleigh\b|\bheadquarter/i, 'mentions Raleigh or a headquarters', 'ownText'],
  [/To be confirmed/i, 'shows "To be confirmed"'],
  [/The Right People\. The Right Opportunity/i, 'uses the retired tagline'],
];

async function serveLocally() {
  const server = spawn('npx', ['serve', '.vercel/output/static', '-l', '4322', '--no-clipboard'], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE)).ok) return server; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  server.kill();
  throw new Error('Local server did not start. Run `npm run build` first.');
}

async function main() {
  const server = live ? null : await serveLocally();
  const browser = await chromium.launch();
  const titles = new Map();
  try {
    const desk = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
    const page = await desk.newPage();
    const small = await phone.newPage();

    const queue = ['/'];
    const seen = new Set(queue);
    while (queue.length) {
      const path = queue.shift();
      const errors = [];
      const failed = [];
      page.removeAllListeners('pageerror');
      page.removeAllListeners('requestfailed');
      page.removeAllListeners('response');
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('requestfailed', (r) => { if (r.url().startsWith(BASE)) failed.push(r.url()); });
      page.on('response', (r) => { if (r.url().startsWith(BASE) && r.status() >= 400 && !r.url().includes('/api/')) failed.push(`${r.status()} ${r.url()}`); });

      const res = await page.goto(BASE + path, { waitUntil: 'load', timeout: 60000 });
      if (!res || res.status() !== 200) { problem(path, `status ${res?.status()}`); continue; }
      await page.waitForTimeout(300);
      errors.forEach((e) => problem(path, `script error: ${e}`));
      failed.forEach((u) => problem(path, `failed to load ${u}`));

      const info = await page.evaluate(() => {
        // Page text without job details from Crelate (see RULES).
        const ownText = () => {
          const body = /** @type {HTMLElement} */ (document.body.cloneNode(true));
          const job = location.pathname.startsWith('/careers/jobs/') ? ', .banner' : '';
          body.querySelectorAll(`#job-list, .facts, .posting${job}`).forEach((el) => el.remove());
          return body.textContent ?? '';
        };
        return {
        title: document.title,
        description: document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '',
        h1: document.querySelectorAll('h1').length,
        canonical: Boolean(document.querySelector('link[rel="canonical"]')),
        noAlt: [...document.images].filter((i) => !i.hasAttribute('alt')).length,
        wide: document.documentElement.scrollWidth > window.innerWidth + 1,
        text: document.body.innerText,
        ownText: ownText(),
        links: [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')),
        industryTag: [...document.querySelectorAll('body *')].some((el) => el.children.length === 0 && /^your industry$/i.test(el.textContent?.trim() ?? '')),
      };
      });
      if (!info.title) problem(path, 'no <title>');
      else if (titles.has(info.title)) problem(path, `same <title> as ${titles.get(info.title)}`);
      else titles.set(info.title, path);
      if (!info.description) problem(path, 'no meta description');
      if (info.h1 !== 1) problem(path, `${info.h1} <h1> headings (should be 1)`);
      if (!info.canonical) problem(path, 'no canonical link');
      if (info.noAlt) problem(path, `${info.noAlt} image(s) without alt text`);
      if (info.wide) problem(path, 'wider than the screen on desktop');
      for (const [re, what, where = 'text'] of RULES) if (re.test(info[where])) problem(path, what);
      if (info.industryTag) problem(path, 'shows the "Your industry" tag');

      // Let scroll motion finish (src/scripts/motion.ts): scroll through the
      // page so every fade-in runs, then check nothing stayed hidden.
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 400) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 50)); }
        scrollTo(0, 0);
      });
      await page.waitForTimeout(1500);
      const stuck = await page.evaluate(() => document.querySelectorAll('.reveal:not(.in)').length);
      if (stuck) problem(path, `${stuck} item(s) never finished fading in`);

      await page.addScriptTag({ content: axeSource });
      const axe = await page.evaluate(async () => {
        // @ts-ignore
        const r = await window.axe.run(document, { resultTypes: ['violations'] });
        return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id} (${v.nodes.length})`);
      });
      axe.forEach((v) => problem(path, `accessibility: ${v}`));

      await small.goto(BASE + path, { waitUntil: 'load', timeout: 60000 });
      if (await small.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) problem(path, 'wider than the screen on a phone (390px)');

      for (const href of info.links) {
        if (!href || !href.startsWith('/') || href.startsWith('//') || href.startsWith('/api/') || /\.(xml|txt|png|svg|pdf)$/.test(href)) continue;
        const clean = href.split('#')[0].split('?')[0] || '/';
        // Job pages are rendered on request: only the live site has them.
        if (!live && clean.startsWith('/careers/jobs/')) continue;
        if (!seen.has(clean)) { seen.add(clean); queue.push(clean); }
      }
    }

    if (live) await liveChecks(page);
    console.log(`Checked ${seen.size} pages on ${BASE}`);
  } finally {
    await browser.close();
    server?.kill();
  }

  if (problems.length) {
    console.log(`\n${problems.length} problem(s):`);
    problems.forEach((p) => console.log(`  ✗ ${p}`));
    process.exit(1);
  }
  console.log('✓ No problems found');
}

async function liveChecks(page) {
  const jobs = await (await fetch(`${BASE}/api/jobs`)).json().catch(() => ({}));
  if (!jobs.jobs?.length) return problem('/api/jobs', 'returned no jobs');
  const allowed = ['distance', 'location', 'remote', 'summary', 'title', 'url'];
  if (Object.keys(jobs.jobs[0]).some((k) => !allowed.includes(k))) problem('/api/jobs', 'returns fields beyond the public allowlist');
  for (const job of jobs.jobs.slice(0, 5)) {
    await page.goto(BASE + job.url, { waitUntil: 'load', timeout: 60000 });
    const labels = await page.$$eval('.facts dt', (els) => els.map((e) => e.textContent?.trim()));
    if (labels.join('|') !== 'Location|Job Type|Duration') problem(job.url, `facts row is "${labels.join(', ')}"`);
    if (!(await page.$('#apply form'))) problem(job.url, 'no application form');
    const text = await page.evaluate(() => document.body.innerText);
    for (const [re, what, where] of RULES) if (!where && re.test(text)) problem(job.url, what);
  }
  // Chat assistant: answers whether it's on, and turns away other sites.
  const chat = await (await fetch(`${BASE}/api/chat`)).json().catch(() => null);
  if (typeof chat?.enabled !== 'boolean') problem('/api/chat', 'does not report whether the chat is on');
  const foreign = await fetch(`${BASE}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' }, body: '{"messages":[{"role":"user","text":"hi"}]}' });
  if (foreign.status !== 403) problem('/api/chat', `accepted a post from another site (status ${foreign.status})`);
  const robots = await fetch(`${BASE}/robots.txt`);
  if (!robots.ok) problem('/robots.txt', `status ${robots.status}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
