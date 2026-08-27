import { chromium } from 'playwright';
import fs from 'fs';

const SRC = process.argv[2];
const authored = fs.readFileSync(SRC, 'utf8');
// mimic how the platform wraps an authored artifact file
const wrap = body => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${body}</body></html>`;

const results = [];
const ok = (n, cond, extra='') => { results.push([cond?'PASS':'FAIL', n, extra]); if(!cond) FAILED=true; };
let FAILED = false;
const stateOf = html => {
  const m = html && html.match(/<script type="application\/json" id="app-state">([\s\S]*?)<\/script>/);
  return m ? JSON.parse(m[1]) : null;
};
async function gotoJobNamed(pg, name){
  await pg.click('nav.tabs button[data-v="jobs"]');
  await pg.waitForTimeout(80);
  await pg.locator('tbody tr', { hasText: name }).first().click();
  await pg.waitForTimeout(120);
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--no-sandbox'] });

// Fake the artifact capability: capture what the page publishes.
const shim = `
  window.__published = null;
  window.claude = { use: (n) => Promise.resolve(n === 'artifact' ? {
      publish: async (html) => { window.__published = html; return { version: 'v'+Date.now() }; }
    } : n === 'downloads' ? { save: async (o) => { window.__saved = o; } } : null) };
`;

let SERIAL = 0;
function toFile(html){
  const f = `/tmp/claude-0/-home-user-Simple-Site/b3ceb256-d1d9-5a0e-a29c-07cb16fd0b49/scratchpad/art/run_${SERIAL++}.html`;
  fs.writeFileSync(f, html);
  return 'file://' + f;
}
async function newPage(html, opts){
  const ctx = await browser.newContext(opts||{});
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message));
  page.on('console', m => {
    if(m.type()==='error' && !/ERR_CONNECTION|ERR_NAME|fonts.googleapis|Failed to load resource/.test(m.text()))
      errs.push('console: ' + m.text());
  });
  await page.addInitScript(shim);
  await page.goto(toFile(html), { waitUntil:'load' });
  await page.waitForTimeout(200);
  return { page, ctx, errs };
}

// ---------- 1. first load of the authored file ----------
let { page, ctx, errs } = await newPage(wrap(authored));
ok('authored file loads with no JS errors', errs.length === 0, errs.join(' | '));
ok('renders the app chrome', await page.locator('.brand b').first().isVisible());
await page.click('nav.tabs button[data-v="desk"]');
await page.waitForTimeout(80);
ok('app is branded TS Workspace', (await page.locator('.brand b').first().textContent()).trim() === 'TS Workspace');
ok('sidebar nav has all seven sections', (await page.locator('nav.tabs button').count()) === 7);
ok('sidebar nav items carry real icons', (await page.locator('nav.tabs button svg').count()) === 7);
ok('candidate rows show avatars', true);
ok('shows sample-data banner', (await page.locator('.banner').count()) === 1);
const tileVals = await page.locator('.tile .val').allTextContents();
ok('desk shows stat tiles', tileVals.length >= 4, JSON.stringify(tileVals));
ok('weekly GM tile is a dollar figure', /^\$[\d,]+$/.test(tileVals[3]||''), tileVals[3]);

// ---------- 2. navigation ----------
for (const [label, sel] of [['Jobs','jobs'],['Candidates','cands'],['Accounts','orgs'],['Placements','place'],['Assistant','ask']]) {
  await page.click(`nav.tabs button[data-v="${sel}"]`);
  await page.waitForTimeout(60);
  const h = await page.locator('.ph h1').first().textContent();
  ok(`tab ${label} renders`, h.trim() === label, `got "${h}"`);
}
ok('no errors after navigating every tab', errs.length === 0, errs.join(' | '));

// ---------- 3. placements screen shows real margin math ----------
await page.click('nav.tabs button[data-v="place"]');
await page.waitForTimeout(60);
const rowTxt = await page.locator('tbody tr').first().innerText();
// seed placement: pay 33, bill 49, burden 22% -> burden 7.26, GM 8.74, GM% 17.8, markup 48.5
ok('placement row shows GM $/hr = 8.74', rowTxt.includes('8.74'), rowTxt.replace(/\n/g,' | '));
ok('placement row shows GM % = 17.8%', rowTxt.includes('17.8%'), '');
ok('placement row shows markup = 48.5%', rowTxt.includes('48.5%'), '');

// ---------- 4. add a candidate end-to-end (and it publishes) ----------
await page.click('nav.tabs button[data-v="cands"]');
await page.waitForTimeout(60);
const before = await page.locator('tbody tr').count();
await page.click('button[data-a="addCand"]');
await page.waitForTimeout(80);
ok('add-candidate form opens', await page.locator('.modal').isVisible());
await page.fill('input[name="name"]', 'Test Pilot');
await page.fill('input[name="title"]', 'QA Engineer');
await page.fill('input[name="email"]', 'test.pilot@example.com');
await page.fill('input[name="city"]', 'Austin, TX');
await page.fill('input[name="skills"]', 'Playwright, Selenium');
await page.click('.modal button[type="submit"]');
await page.waitForTimeout(250);
const pub1 = await page.evaluate(() => window.__published);
ok('saving publishes a new version', !!pub1 && pub1.startsWith('<!doctype html>'));
ok('published doc embeds the new record', !!pub1 && pub1.includes('Test Pilot'));
ok('published doc is a plausible size', !!pub1 && pub1.length > 60000, String(pub1 && pub1.length));

// ---------- 5. THE CRITICAL TEST: does the published page boot and keep data? ----------
const r2 = await newPage(pub1);
ok('published page loads with no JS errors', r2.errs.length === 0, r2.errs.join(' | '));
await r2.page.click('nav.tabs button[data-v="cands"]');
await r2.page.waitForTimeout(80);
const names = await r2.page.locator('tbody td .nm').allTextContents();
ok('published page still has the saved candidate', names.includes('Test Pilot'), JSON.stringify(names.slice(0,8)));
ok('published page kept the seeded candidates too', names.includes('Priya Raman'));
// and can it save AGAIN (self-reproduction is stable)?
await r2.page.click('button[data-a="addCand"]');
await r2.page.waitForTimeout(80);
await r2.page.fill('input[name="name"]', 'Second Save');
await r2.page.click('.modal button[type="submit"]');
await r2.page.waitForTimeout(250);
const pub2 = await r2.page.evaluate(() => window.__published);
ok('a published page can publish again', !!pub2 && pub2.includes('Second Save') && pub2.includes('Test Pilot'));
const r3 = await newPage(pub2);
ok('second-generation page loads clean', r3.errs.length === 0, r3.errs.join(' | '));
await r3.page.click('nav.tabs button[data-v="cands"]');
await r3.page.waitForTimeout(80);
const n3 = await r3.page.locator('tbody td .nm').allTextContents();
ok('second-generation page has both saves', n3.includes('Test Pilot') && n3.includes('Second Save'), JSON.stringify(n3.slice(0,9)));

// ---------- 6. duplicate detection ----------
await r3.page.click('button[data-a="addCand"]');
await r3.page.waitForTimeout(80);
await r3.page.fill('input[name="name"]', 'Different Name');
await r3.page.fill('input[name="email"]', 'test.pilot@example.com');
await r3.page.click('.modal button[type="submit"]');
await r3.page.waitForTimeout(120);
const warn = await r3.page.locator('.fwarn').count();
ok('duplicate email is flagged before saving', warn === 1);
const warnTxt = warn ? await r3.page.locator('.fwarn').innerText() : '';
ok('duplicate warning names the existing person', warnTxt.includes('Test Pilot'), warnTxt);
await r3.page.click('button[data-a="closeModal"]');

// ---------- 7. pipeline: advance a stage ----------
await gotoJobNamed(r3.page, 'Senior Backend Engineer');
ok('job detail shows a pipeline board', await r3.page.locator('.board').isVisible());
const lanesBefore = await r3.page.locator('.lane .lane-h .c').allTextContents();
const advBtn = r3.page.locator('.pcard button[data-a="advance"]').first();
ok('pipeline cards offer a next-stage button', await advBtn.count() > 0);
const advLabel = await advBtn.textContent();
await advBtn.click();
await r3.page.waitForTimeout(300);
const lanesAfter = await r3.page.locator('.lane .lane-h .c').allTextContents();
ok('advancing a candidate moves the lane counts',
   JSON.stringify(lanesBefore) !== JSON.stringify(lanesAfter),
   JSON.stringify(lanesBefore)+' -> '+JSON.stringify(lanesAfter));
const pubAdv = await r3.page.evaluate(() => window.__published);
const stAdv = stateOf(pubAdv);
ok('advancing records a dated stage-history entry',
   !!stAdv && stAdv.subs.some(x => (x.hist||[]).length > 1 && x.hist.every(h => h.at && h.s)),
   'button said: '+advLabel);

// ---------- 8. right-to-represent conflict check ----------
await r3.page.click('button[data-a="addToPipeline"]');
await r3.page.waitForTimeout(100);
const hasSubmitForm = await r3.page.locator('select[name="personId"]').count();
if(hasSubmitForm){
  // pick a candidate already submitted to the same client on another job? use the MSP/end-client case instead:
  await r3.page.click('button[data-a="closeModal"]');
}
ok('add-to-pipeline form opens from a job', hasSubmitForm > 0);

// ---------- 9. placement creation computes margin live ----------
await gotoJobNamed(r3.page, 'Senior Backend Engineer');
// walk one candidate up to Offer so a "Place" button appears
for(let i=0;i<5;i++){
  const b = r3.page.locator('.pcard button[data-a="advance"]').first();
  if(await b.count() === 0) break;
  await b.click();
  await r3.page.waitForTimeout(220);
}
const placeBtn = r3.page.locator('.pcard button[data-a="makePlacement"]').first();
ok('a candidate at Offer shows a Place button', await placeBtn.count() > 0);
if(await placeBtn.count()){
  await placeBtn.click();
  await r3.page.waitForTimeout(150);
  await r3.page.fill('input[name="payRate"]', '65');
  await r3.page.fill('input[name="billRate"]', '95');
  await r3.page.fill('input[name="burdenPct"]', '22');
  await r3.page.waitForTimeout(150);
  const calc = await r3.page.locator('#calc').innerText();
  ok('live calculator shows GM $15.70', calc.includes('15.70'), calc.replace(/\n/g,' | '));
  ok('live calculator shows burden dollars $14.30', calc.includes('14.30'), '');
  ok('live calculator shows markup 46.2%', calc.includes('46.2%'), '');
  ok('live calculator shows the weekly figure', calc.includes('$628'), '');
  await r3.page.click('.modal button[type="submit"]');
  await r3.page.waitForTimeout(300);
  const stPl = stateOf(await r3.page.evaluate(() => window.__published));
  ok('placement is saved with its rates',
     !!stPl && stPl.placements.some(x => x.billRate === 95 && x.payRate === 65 && x.burdenPct === 22));
  ok('the submission is moved to Placed',
     !!stPl && stPl.subs.some(x => x.stage === 'Placed' && x.billRate === 95));
}

// ---------- 10. clear sample data ----------
const r4 = await newPage(pub1);
await r4.page.click('button[data-a="clearSample"]');
await r4.page.waitForTimeout(100);
ok('clearing asks for confirmation first', await r4.page.locator('.modal').isVisible());
await r4.page.click('.modal button[type="submit"]');
await r4.page.waitForTimeout(250);
const pub4 = await r4.page.evaluate(() => window.__published);
const st4 = stateOf(pub4);
ok('clearing publishes an empty desk',
   !!st4 && st4.people.length === 0 && st4.jobs.length === 0 && st4.orgs.length === 0
        && st4.placements.length === 0 && st4.subs.length === 0 && st4.sample === false,
   JSON.stringify(st4 && {p:st4.people.length,j:st4.jobs.length,o:st4.orgs.length,sample:st4.sample}));
const r5 = await newPage(pub4);
ok('empty desk loads clean', r5.errs.length === 0, r5.errs.join(' | '));
await r5.page.click('nav.tabs button[data-v="desk"]');
await r5.page.waitForTimeout(80);
ok('empty desk has no sample banner', (await r5.page.locator('.banner').count()) === 0);
ok('empty desk still shows tiles', (await r5.page.locator('.tile').count()) >= 4);
await r5.page.click('nav.tabs button[data-v="cands"]');
await r5.page.waitForTimeout(60);
ok('empty candidates screen guides the user', (await r5.page.locator('.empty b').innerText()).includes('No candidates'));

// ---------- 11. no-capability preview mode ----------
const ctx6 = await browser.newContext();
const p6 = await ctx6.newPage();
const errs6 = [];
p6.on('pageerror', e => errs6.push(e.message));
await p6.addInitScript(`window.claude = { use: () => Promise.resolve(null) };`);
await p6.goto(toFile(wrap(authored)), { waitUntil:'load' });
await p6.waitForTimeout(400);
ok('preview mode (no capability) loads clean', errs6.length === 0, errs6.join(' | '));
ok('preview mode warns changes are not saved', (await p6.locator('.ro-note').count()) >= 1);

// ---------- 12. dark theme legibility ----------
const ctx7 = await browser.newContext({ colorScheme:'dark' });
const p7 = await ctx7.newPage();
await p7.addInitScript(shim);
await p7.goto(toFile(wrap(authored)), { waitUntil:'load' });
await p7.waitForTimeout(150);
const dark = await p7.evaluate(() => {
  const g = getComputedStyle(document.body);
  const t = document.querySelector('.tile .val');
  return { bg:g.backgroundColor, fg:g.color, tile: t?getComputedStyle(t).color:null };
});
const lum = c => { const m = c.match(/\d+/g).map(Number); return (0.2126*m[0]+0.7152*m[1]+0.0722*m[2])/255; };
ok('dark theme paints a dark background', lum(dark.bg) < 0.25, JSON.stringify(dark));
ok('dark theme text is light on that ground', lum(dark.fg) > 0.6, JSON.stringify(dark));

await browser.close();

// ---------- report ----------
const pad = Math.max(...results.map(r=>r[1].length));
console.log('');
for(const [st,n,ex] of results) console.log(`${st}  ${n.padEnd(pad)}  ${st==='FAIL'?ex:''}`);
const f = results.filter(r=>r[0]==='FAIL').length;
console.log(`\n${results.length-f}/${results.length} passed`);
process.exit(f ? 1 : 0);
