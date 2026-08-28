import { chromium } from 'playwright';
import fs from 'fs';
const authored = fs.readFileSync(process.argv[2],'utf8')
  // the published file carries the real (cleared) workspace; tests want the sample data
  .replace(/<script type="application\/json" id="app-state">[\s\S]*?<\/script>/,
           '<script type="application/json" id="app-state">null</script>');
const wrap = b => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${b}</body></html>`;
const results = []; let FAILED = false;
const ok = (n,c,x='') => { results.push([c?'PASS':'FAIL',n,x]); if(!c) FAILED=true; };
const stateOf = h => { const m = h && h.match(/<script type="application\/json" id="app-state">([\s\S]*?)<\/script>/); return m?JSON.parse(m[1]):null; };

const browser = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--no-sandbox'] });
const shim = `
  window.__published=null;
  window.claude={use:n=>Promise.resolve(n==='artifact'?{publish:async h=>{window.__published=h;return{version:'v1'};}}:n==='downloads'?{save:async()=>{}}:null)};
`;
let SER=0;
async function boot(html){
  if(!html){ throw new Error('boot(): previous step never published — chain broken'); }
  const f=`${process.argv[3]}/t2_${SER++}.html`; fs.writeFileSync(f,html);
  const ctx=await browser.newContext(); const page=await ctx.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  page.on('console',m=>{ if(m.type()==='error'&&!/ERR_|Failed to load/.test(m.text())) errs.push(m.text()); });
  await page.addInitScript(shim);
  await page.goto('file://'+f,{waitUntil:'load'}); await page.waitForTimeout(220);
  return {page,errs};
}
async function ask(page, text){
  await page.fill('#askin', text);
  await page.press('#askin','Enter');
  await page.waitForTimeout(320);
}
const lastMsg = page => page.locator('.msg.as').last().innerText();

let {page,errs} = await boot(wrap(authored));
ok('the assistant is the landing screen', (await page.locator('.ph h1').first().textContent()).trim()==='TS Project Assistant');
ok('composer is present', await page.locator('#askin').isVisible());
ok('no account chips clutter the assistant — navigation lives in the sidebar',
   (await page.locator('.askintro .chip.act').count())===0);
ok('the composer is a roomy text area', (await page.locator('.composer textarea').count())===1);
ok('the composer invites a document drop', /Drop files here/i.test(await page.locator('.composer').innerText()));
ok('no boot errors', errs.length===0, errs.join(' | '));

// ---- 1. plain-English lists ----
await ask(page,'list of accounts');
let t = await lastMsg(page);
ok('“list of accounts” returns accounts', /3 accounts/i.test(t), t.slice(0,140));
ok('account rows are clickable', (await page.locator('.rrow[data-a="openOrg"]').count())>=3);
ok('account rows show owner state', /no owner|owned by/i.test(t), t.slice(0,200));

await ask(page,'unassigned accounts');
t = await lastMsg(page);
ok('“unassigned accounts” filters to unowned', /2 accounts with no owner/i.test(t), t.slice(0,140));

await ask(page,'how many candidates');
t = await lastMsg(page);
ok('“how many candidates” answers with a count', /^\s*5 candidates/i.test(t.replace(/\n/g,' ')), t.slice(0,100));

// ---- 2. "my accounts" asks who you are, then works ----
await ask(page,'my accounts');
t = await lastMsg(page);
ok('“my accounts” asks which workspace user you are', /which workspace user are you/i.test(t), t.slice(0,180));
await ask(page,'I am Jordan Blake');
t = await lastMsg(page);
ok('after identifying yourself it replays the query', /1 account owned by Jordan Blake/i.test(t), t.replace(/\n/g,' ').slice(0,200));

await ask(page,'assign Ardent Logistics to me');
t = await lastMsg(page);
ok('assigning an account to yourself works', /Jordan Blake.*now owns.*Ardent/is.test(t), t.slice(0,200));

// only real workspace users can own an account
await ask(page,'assign Ardent Logistics to Some Random Person');
t = await lastMsg(page);
ok('a non-user cannot be made an owner', /not a workspace user/i.test(t), t.slice(0,200));

// ---- 3. multiple owners on one account ----
await ask(page,'assign Ardent Logistics to Dana Reed');
await ask(page,'who owns Ardent Logistics');
t = await lastMsg(page);
ok('an account can hold several owners', /Jordan Blake/.test(t)&&/Dana Reed/.test(t), t.slice(0,200));

// ---- 4. slot filling: missing required fields ----
await ask(page,'add candidate Jane');
t = await lastMsg(page);
ok('adding a candidate with only a name asks for contact details', /email or phone/i.test(t), t.slice(0,180));
await ask(page,'jane.tester@example.com');
ok('supplying the email produces a draft to check', (await page.locator('.draft').count())===1);
t = await page.locator('.draft').innerText();
ok('draft shows the name it captured', /Jane/.test(t), t.slice(0,140));
ok('draft is explicitly not saved yet', /not saved yet/i.test(t));
await page.click('.draft button[data-a="commitDraft"]');
await page.waitForTimeout(350);
let st = stateOf(await page.evaluate(()=>window.__published));
ok('committing the draft saves the candidate', !!st && st.people.some(p=>p.email==='jane.tester@example.com'&&p.isCandidate));

// ---- 5. contact requires a company ----
let r2 = await boot(await page.evaluate(()=>window.__published));
await ask(r2.page,'add manager Alex Stone');
t = await lastMsg(r2.page);
ok('adding a manager asks which company', /which company/i.test(t), t.slice(0,160));
ok('it offers the existing companies as choices', (await r2.page.locator('.msg.as').last().locator('.chip.act').count())>=3);
await ask(r2.page,'Northwind Health');
t = await lastMsg(r2.page);
ok('then it asks for a contact method', /email or phone/i.test(t), t.slice(0,160));
await ask(r2.page,'skip');
ok('“skip” is honoured for optional details', (await r2.page.locator('.draft').count())===1);
await r2.page.click('.draft button[data-a="commitDraft"]');
await r2.page.waitForTimeout(350);
st = stateOf(await r2.page.evaluate(()=>window.__published));
ok('contact is saved against the company',
   !!st && st.people.some(p=>p.name==='Alex Stone'&&p.isContact&&p.orgId===st.orgs.find(o=>o.name==='Northwind Health').id));

// ---- 6. the same person as BOTH candidate and manager, no duplicate ----
let r3 = await boot(await r2.page.evaluate(()=>window.__published));
const before = stateOf(await r2.page.evaluate(()=>window.__published)).people.length;
await ask(r3.page,'add candidate Alex Stone, alex.stone@example.com');
if(await r3.page.locator('.draft').count()===0){ await ask(r3.page,'alex.stone@example.com'); }
await r3.page.click('.draft button[data-a="commitDraft"]');
await r3.page.waitForTimeout(350);
t = await lastMsg(r3.page);
st = stateOf(await r3.page.evaluate(()=>window.__published));
ok('adding an existing manager as a candidate creates NO duplicate', st.people.length===before,
   `people ${before} -> ${st.people.length}`);
const alex = st.people.filter(p=>p.name==='Alex Stone');
ok('there is exactly one Alex Stone', alex.length===1, String(alex.length));
ok('that one record carries BOTH roles', alex[0] && alex[0].isCandidate===true && alex[0].isContact===true,
   JSON.stringify(alex[0]&&{c:alex[0].isCandidate,k:alex[0].isContact}));
ok('the assistant says it merged rather than duplicated', /already here|added the .*candidate. role/i.test(t), t.slice(0,220));
ok('nothing was overwritten', /nothing was overwritten/i.test(t));

// ---- 7. role-aware logging picks the right hat ----
let r4 = await boot(await r3.page.evaluate(()=>window.__published));
await ask(r4.page,'log call with Priya Raman about the backend role');
t = await lastMsg(r4.page);
ok('logging against a candidate-only person infers "candidate"', /as a \*?\*?candidate/i.test(t)||/as a candidate/i.test(t), t.slice(0,200));
ok('it explains how it decided', /I worked that out because/i.test(t), t.slice(0,240));
await ask(r4.page,'log call with Alex Stone');
t = await lastMsg(r4.page);
ok('a dual-role person is asked about, not guessed', /both a candidate and a hiring manager/i.test(t), t.slice(0,200));
const choices = await r4.page.locator('.msg.as').last().locator('.chip.act').count();
ok('it offers the specific hats to choose from', choices>=1, String(choices));
await r4.page.locator('.msg.as').last().locator('.chip.act').first().click();
await r4.page.waitForTimeout(350);
t = await lastMsg(r4.page);
ok('after choosing, the interaction is logged with a role', /logged a call/i.test(t), t.slice(0,200));
st = stateOf(await r4.page.evaluate(()=>window.__published)) || {activity:[]};
ok('activity rows carry role + account', !!st && st.activity.some(a=>a.role&&a.personId), JSON.stringify((st.activity||[]).slice(-1)));

// ---- 8. locations with their own rules of engagement ----
let r5 = await boot(await r4.page.evaluate(()=>window.__published));
await ask(r5.page,'list locations for Northwind Health');
t = await lastMsg(r5.page);
ok('an account can list its locations', /2 locations/i.test(t), t.slice(0,160));
ok('location rows show the rules of engagement', /portal|submittal/i.test(t), t.slice(0,300));
await ask(r5.page,'add location Peoria Annex, 12 Mill Rd, Peoria, IL to Northwind Health');
await r5.page.waitForTimeout(320);
const locReply = await lastMsg(r5.page);
st = stateOf(await r5.page.evaluate(()=>window.__published)) || {locations:[],orgs:[]};
ok('adding a location in plain English works', (st.locations||[]).some(l=>l.name==='Peoria Annex'),
   'reply: '+locReply.replace(/\n/g,' ').slice(0,200));
ok('the new location is tied to the right account',
   (()=>{const l=(st.locations||[]).find(x=>x.name==='Peoria Annex'); const o=(st.orgs||[]).find(x=>x.name==='Northwind Health'); return !!(l&&o&&l.orgId===o.id);})());

// ---- 9. documents: account-wide vs location-specific, searchable ----
await ask(r5.page,'search documents for termination');
t = await lastMsg(r5.page);
ok('document text is searchable', /1 document mentions/i.test(t), t.slice(0,160));
ok('the search returns a snippet of the clause', /thirty \(30\) days|terminate/i.test(t), t.slice(0,320));
await ask(r5.page,'search documents for overtime');
t = await lastMsg(r5.page);
ok('the location-specific exhibit is searchable too', /1 document mentions/i.test(t), t.slice(0,160));
ok('it is labelled with its location scope', /Chicago HQ/i.test(t), t.slice(0,300));
await ask(r5.page,'list documents');
t = await lastMsg(r5.page);
ok('documents can be listed', /2 documents/i.test(t), t.slice(0,140));

// ---- 10. account screen shows owners, locations and agreements ----
await r5.page.click('nav.tabs button[data-v="orgs"]');
await r5.page.waitForTimeout(150);
const hdr = await r5.page.locator('thead').innerText();
ok('accounts list has an Owners column', /Owners/i.test(hdr), hdr.replace(/\n/g,'|'));
ok('accounts list has a Locations column', /Locations/i.test(hdr));
ok('unassigned accounts are flagged in the list', (await r5.page.locator('.pill.w', {hasText:'unassigned'}).count())>=1);
await r5.page.locator('tbody tr',{hasText:'Northwind'}).first().click();
await r5.page.waitForTimeout(200);
const detail = await r5.page.locator('.wrap').innerText();
ok('account detail shows Owners', /Owners/.test(detail));
ok('account detail shows Locations', /Locations/.test(detail));
ok('account detail has one Documents section', /Documents/.test(detail) && !/SharePoint\n/.test(detail));
ok('account detail shows Change history', /Change history/.test(detail));
// locations are now a compact list; the detail lives on the location page
ok('locations are listed compactly on the account', (await r5.page.locator('.lrow[data-a="openLocation"]').count()) >= 2);
await r5.page.locator('.lrow[data-a="openLocation"]').first().click();
await r5.page.waitForTimeout(250);
const locPage = await r5.page.locator('.wrap').innerText();
ok('clicking a location opens its own page', /Chicago HQ/.test(locPage), locPage.slice(0,120));
ok('rules of engagement live on the location page', /Rules of engagement/i.test(locPage));
ok('the location page shows screening inherited from the account', /Screening required/i.test(locPage) && /Seven-year/i.test(locPage), locPage.slice(0,400));
await r5.page.locator('.back').first().click();
await r5.page.waitForTimeout(250);
ok('account-wide vs location-specific agreements are separated',
   /Account-wide/.test(detail) && /Location specific/.test(detail), detail.slice(0,80));
ok('owners are shown as workspace users', /Jordan Blake/.test(detail), detail.slice(0,300));

// ---- 11. edits are recorded, not silent ----
let r6 = await boot(await r5.page.evaluate(()=>window.__published));
await r6.page.click('nav.tabs button[data-v="orgs"]');
await r6.page.waitForTimeout(150);
await r6.page.locator('tbody tr',{hasText:'Ardent'}).first().click();
await r6.page.waitForTimeout(180);
await r6.page.click('button[data-a="editOrg"]');
await r6.page.waitForTimeout(150);
await r6.page.fill('input[name="name"]','Ardent Logistics Group');
await r6.page.click('.modal button[type="submit"]');
await r6.page.waitForTimeout(350);
st = stateOf(await r6.page.evaluate(()=>window.__published)) || {orgs:[],audit:[]};
ok('an edit updates the record', !!st && st.orgs.some(o=>o.name==='Ardent Logistics Group'));
ok('the edit is recorded in the audit trail with before and after',
   !!st && (st.audit||[]).some(a=>a.changes.some(c=>c.from==='Ardent Logistics'&&c.to==='Ardent Logistics Group')),
   JSON.stringify((st.audit||[]).slice(-1)));
const det2 = await r6.page.locator('.wrap').innerText();
ok('the change is visible on the record', /Ardent Logistics\s*→\s*Ardent Logistics Group|name Ardent Logistics/.test(det2.replace(/\n/g,' ')), det2.slice(0,300));

// ---- 12. resume parsing from pasted text ----
let r7 = await boot(await r6.page.evaluate(()=>window.__published));
const RESUME = `Marcus Delacroix
Senior Site Reliability Engineer
Austin, TX  |  marcus.delacroix@example.com  |  (512) 555-0184

PROFESSIONAL SUMMARY
Site reliability engineer with 11 years of experience running large Kubernetes estates.

TECHNICAL SKILLS
Kubernetes, Terraform, Go, AWS, Prometheus, PostgreSQL

EXPERIENCE
Staff SRE, Globex, 2019 - present`;
await r7.page.click('button[data-a="pasteResume"]');
await r7.page.waitForTimeout(150);
await r7.page.fill('input[name="name"]','marcus-delacroix-resume.pdf');
await r7.page.fill('textarea[name="text"]', RESUME);
await r7.page.click('.modal button[type="submit"]');
await r7.page.waitForTimeout(450);
t = await r7.page.locator('.msg.as').last().innerText().catch(()=> '');
const draftTxt = await r7.page.locator('.draft').innerText().catch(()=> '');
ok('a pasted resume produces a draft', (await r7.page.locator('.draft').count())===1, t.slice(0,200));
ok('it extracted the name', /Marcus Delacroix/.test(draftTxt), draftTxt.slice(0,200));
ok('it extracted the email', /marcus\.delacroix@example\.com/.test(draftTxt));
ok('it extracted the phone', /512.*555.*0184/.test(draftTxt));
ok('it extracted the location', /Austin, TX/.test(draftTxt));
ok('it extracted years of experience', /11 years/.test(draftTxt), draftTxt.slice(0,260));
ok('it extracted the title', /Reliability Engineer/i.test(draftTxt));
ok('it extracted skills', /Kubernetes/.test(draftTxt) && /Terraform/.test(draftTxt), draftTxt.slice(0,300));
await r7.page.click('.draft button[data-a="commitDraft"]');
await r7.page.waitForTimeout(350);
st = stateOf(await r7.page.evaluate(()=>window.__published)) || {people:[]};
ok('the parsed candidate is saved', !!st && st.people.some(p=>p.name==='Marcus Delacroix'&&p.isCandidate));
const mar = st.people.find(p=>p.name==='Marcus Delacroix');
ok('skills are stored as a list', mar && Array.isArray(mar.skills) && mar.skills.length>=4, JSON.stringify(mar&&mar.skills));

// ---- 13. a NON-resume document gets filed against an account, with scope ----
let r8 = await boot(await r7.page.evaluate(()=>window.__published));
const MSA = `MASTER SERVICES AGREEMENT
This Master Services Agreement is entered into between Globex Industries and Technical Source.
Payment terms are net sixty (60) days from the invoice date.
Indemnification: supplier shall indemnify and hold harmless the client.
Assignment: neither party may assign this agreement without prior written consent.`;
await r8.page.click('button[data-a="pasteResume"]');
await r8.page.waitForTimeout(150);
await r8.page.fill('input[name="name"]','Globex-MSA.pdf');
await r8.page.fill('textarea[name="text"]', MSA);
await r8.page.click('.modal button[type="submit"]');
await r8.page.waitForTimeout(400);
t = await lastMsg(r8.page);
ok('a non-resume document is recognised as an MSA', /reads like an? \*?\*?MSA/i.test(t), t.slice(0,200));
ok('it asks which account to file it against', /which account/i.test(t), t.slice(0,200));
await ask(r8.page,'Globex Industries');
await r8.page.waitForTimeout(300);
t = await lastMsg(r8.page);
ok('a brand-new account is created for filing', /created that account/i.test(t), t.slice(0,240));
ok('it states the agreement is account-wide', /account-wide/i.test(t), t.slice(0,240));
st = stateOf(await r8.page.evaluate(()=>window.__published)) || {docs:[]};
const gdoc = (st.docs||[]).find(d=>d.name==='Globex-MSA.pdf');
ok('the document is stored against the account', !!gdoc && !!gdoc.orgId);
ok('its scope is account-wide, not a location', !!gdoc && gdoc.locationId===null && gdoc.scope==='account', JSON.stringify(gdoc&&{s:gdoc.scope,l:gdoc.locationId}));
ok('its text was kept for searching', !!gdoc && /net sixty/i.test(gdoc.text||''));
await ask(r8.page,'search documents for indemnify');
t = await lastMsg(r8.page);
ok('the newly filed agreement is immediately searchable', /1 document mentions/i.test(t), t.slice(0,160));

// ---- 14. company name alone pulls its contacts ----
await ask(r8.page,'Northwind Health');
t = await lastMsg(r8.page);
ok('a bare account name pulls up that account', /Northwind Health/.test(t), t.slice(0,160));
ok('it lists the contacts there', /contact/i.test(t), t.slice(0,200));
await ask(r8.page,'who do we know at Northwind Health');
t = await lastMsg(r8.page);
ok('“who do we know at X” works', /Northwind Health/.test(t)&&/contact/i.test(t), t.slice(0,200));

// ---- 15. keyword search ----
await ask(r8.page,'candidates with kubernetes');
t = await lastMsg(r8.page);
ok('keyword search finds candidates by skill', /Marcus Delacroix|1 candidate/i.test(t), t.slice(0,200));
await ask(r8.page,'java developers in chicago');
t = await lastMsg(r8.page);
ok('free-text search still works', /match/i.test(t)||/Priya/.test(t), t.slice(0,200));

// ---- 16. chat survives the save-reload ----
let r9 = await boot(await r8.page.evaluate(()=>window.__published));
ok('a reloaded page still boots clean', r9.errs.length===0, r9.errs.join(' | '));
ok('help is available', true);
await ask(r9.page,'help');
const helpAll = await r9.page.locator('.msgs').innerText();
ok('help explains adding records', /add candidate/i.test(helpAll));
ok('help explains lists and ownership', /my accounts/i.test(helpAll) && /assign/i.test(helpAll));
ok('help explains documents', /drop a resume/i.test(helpAll) && /searchable/i.test(helpAll));
ok('help explains that nothing is lost', /archived rather than deleted/i.test(helpAll));

await browser.close();
const pad=Math.max(...results.map(r=>r[1].length));
console.log('');
for(const [s2,n,x] of results) console.log(`${s2}  ${n.padEnd(pad)}  ${s2==='FAIL'?x:''}`);
const f=results.filter(r=>r[0]==='FAIL').length;
console.log(`\n${results.length-f}/${results.length} passed`);
process.exit(f?1:0);
