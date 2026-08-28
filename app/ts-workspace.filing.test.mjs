import { chromium } from 'playwright';
import fs from 'fs';
const authored = fs.readFileSync(process.argv[2],'utf8')
  // the published file carries the real (cleared) workspace; tests want the sample data
  .replace(/<script type="application\/json" id="app-state">[\s\S]*?<\/script>/,
           '<script type="application/json" id="app-state">null</script>');
const wrap = b => `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>${b}</body></html>`;
const results=[]; const ok=(n,c,x='')=>results.push([c?'PASS':'FAIL',n,x]);
const stateOf = h => { const m=h&&h.match(/<script type="application\/json" id="app-state">([\s\S]*?)<\/script>/); return m?JSON.parse(m[1]):null; };
const browser = await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--no-sandbox']});

const FOLDER_ROOT = '{"uri":"file:///b!DRV1/01ROOT","driveId":"b!DRV1","id":"01ROOT","name":"Client Agreements","webUrl":"https://ts.sharepoint.com/sites/X/Shared Documents/Client Agreements","lastModifiedDateTime":"2026-04-16T15:51:32.000Z","offset":0}{"moreResults":false,"nextOffset":1}';
// an existing Resumes child of the root, so ensure-folder must REUSE it rather than create
const FOLDER_RESUMES = '{"uri":"file:///b!DRV1/01RES","driveId":"b!DRV1","id":"01RES","name":"Resumes","webUrl":"https://ts.sharepoint.com/sites/X/Shared Documents/Client Agreements/Resumes","lastModifiedDateTime":"2026-04-16T15:51:32.000Z","offset":0}{"moreResults":false,"nextOffset":1}';
const FORBIDDEN = { code:'tool_error', message:"FORBIDDEN: this tool requires the 'Files.ReadWrite.All' delegated permission.", result:{code:'FORBIDDEN'} };

function shim(o){
  o = Object.assign({ createOk:false, uploadOk:false, resumesExists:true }, o||{});
  return `
  window.__published=null; window.__calls=[];
  const O=${JSON.stringify(o)}, ROOT=${JSON.stringify(FOLDER_ROOT)}, RES=${JSON.stringify(FOLDER_RESUMES)}, FORB=${JSON.stringify(FORBIDDEN)};
  const mcp = {
    listTools: async () => ({ servers:[{ server:'Microsoft 365', authStatus:'connected',
      tools:['sharepoint_search','sharepoint_folder_search','read_resource','sharepoint_upload_file','sharepoint_create_folder'].map(n=>({name:n,description:''})) }] }),
    callTool: async (server, tool, input) => {
      window.__calls.push({tool,input});
      if(tool==='sharepoint_folder_search'){
        if(input.name==='Client Agreements') return { payload:ROOT };
        if(input.name==='Resumes' && O.resumesExists) return { payload:RES };
        return { payload:'{"moreResults":false,"nextOffset":0}' };
      }
      if(tool==='sharepoint_create_folder'){
        if(!O.createOk) throw FORB;
        return { payload: JSON.stringify({ id:'01MADE_'+input.name.replace(/\\W/g,''), driveId:input.driveId, name:input.name,
          webUrl:'https://ts.sharepoint.com/sites/X/Shared Documents/Client Agreements/'+input.name }) };
      }
      if(tool==='sharepoint_upload_file'){
        if(!O.uploadOk) throw FORB;
        return { payload: JSON.stringify({ id:'01UP', webUrl:'https://ts.sharepoint.com/up/'+input.filename, uri:'file:///b!DRV1/01UP' }) };
      }
      if(tool==='sharepoint_search') return { payload:'{"moreResults":false,"nextOffset":0}' };
      if(tool==='read_resource') return { payload:'text' };
      throw { code:'not_in_manifest', message:'no' };
    },
    invalidate: async()=>{}, watchTool: ()=>()=>{}
  };
  window.claude = { use: n => Promise.resolve(
      n==='artifact' ? { publish: async h => { window.__published=h; return {version:'v1'}; } }
    : n==='mcp' ? mcp : n==='downloads' ? {save:async()=>{}} : null) };
  `;
}
let SER=0;
async function boot(html,o){
  const f=`${process.argv[3]}/t4_${SER++}.html`; fs.writeFileSync(f,html);
  const ctx=await browser.newContext(); const page=await ctx.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  page.on('console',m=>{ if(m.type()==='error'&&!/ERR_|Failed to load/.test(m.text())) errs.push(m.text()); });
  await page.addInitScript(shim(o));
  await page.goto('file://'+f,{waitUntil:'load'}); await page.waitForTimeout(300);
  return {page,errs};
}
const ask = async (pg,t) => {
  if(await pg.locator('#askin').count()===0){
    await pg.click('nav.tabs button[data-v="ask"]');
    await pg.waitForTimeout(150);
  }
  await pg.fill('#askin',t); await pg.press('#askin','Enter'); await pg.waitForTimeout(450);
};
const last = pg => pg.locator('.msg.as').last().innerText();
const RESUME = `Marcus Delacroix
Senior Site Reliability Engineer
Austin, TX | marcus.delacroix@example.com | (512) 555-0184
TECHNICAL SKILLS
Kubernetes, Terraform, Go, AWS
11 years of experience`;

// ---- 1. the folder scheme ----
let {page,errs} = await boot(wrap(authored), {});
ok('boots clean', errs.length===0, errs.join(' | '));
const plan = await page.evaluate(()=>({
  resume: spPlannedPath('Resume', 'Northwind Health'),
  msa: spPlannedPath('MSA', 'Northwind Health'),
  sow: spPlannedPath('SOW', 'Ardent Logistics'),
  ex: spPlannedPath('Exhibit', 'Northwind Health'),
  nda: spPlannedPath('NDA', 'Acme'),
  rtr: spPlannedPath('RTR', 'Acme'),
  rate: spPlannedPath('Rate sheet', 'Acme'),
  po: spPlannedPath('PO', 'Acme'),
  other: spPlannedPath('Other', 'Acme'),
  folders: Object.keys(SP_FOLDER).map(k=>SP_FOLDER[k])
}));
ok('resumes get their own folder, with no account subfolder', plan.resume==='Resumes', plan.resume);
ok('MSAs go to MSAs/<account>', plan.msa==='MSAs/Northwind Health', plan.msa);
ok('SOWs go to SOWs/<account>', plan.sow==='SOWs/Ardent Logistics', plan.sow);
ok('exhibits get their own folder', plan.ex==='Exhibits/Northwind Health', plan.ex);
ok('NDAs get their own folder', plan.nda==='NDAs/Acme', plan.nda);
ok('right-to-represent gets its own folder', plan.rtr==='Right to Represent/Acme', plan.rtr);
ok('rate sheets get their own folder', plan.rate==='Rate Sheets/Acme', plan.rate);
ok('purchase orders get their own folder', plan.po==='Purchase Orders/Acme', plan.po);
ok('anything else lands in Other Documents', plan.other==='Other Documents/Acme', plan.other);
ok('every document type has a distinct folder', new Set(plan.folders).size===9, JSON.stringify(plan.folders));

// ---- 2. the Documents library groups by type ----
await page.click('nav.tabs button[data-v="docs"]');
await page.waitForTimeout(200);
let t = await page.locator('.wrap').innerText();
ok('there is a Documents screen', /Documents/.test(t));
ok('it lists the seeded MSA and Exhibit', /Northwind-MSA-2026\.pdf/.test(t) && /Exhibit-A-Chicago-Rates\.pdf/.test(t), t.slice(0,300));
ok('it shows the folder each document belongs in', /MSAs\/Northwind Health/.test(t), t.slice(0,600));
ok('type filter chips are offered with counts', (await page.locator('.chip.act[data-a="docKind"]').count())>=3);
await page.locator('.chip.act[data-a="docKind"][data-v="MSA"]').click();
await page.waitForTimeout(150);
t = await page.locator('.wrap').innerText();
ok('filtering by type narrows the list', /Northwind-MSA/.test(t) && !/Exhibit-A-Chicago/.test(t), t.slice(0,300));

// ---- 3. a dropped resume is stored as a document against the candidate ----
let r2 = await boot(wrap(authored), {});
await r2.page.click('button[data-a="pasteResume"]'); await r2.page.waitForTimeout(150);
await r2.page.fill('input[name="name"]','marcus-delacroix-resume.pdf');
await r2.page.fill('textarea[name="text"]', RESUME);
await r2.page.click('.modal button[type="submit"]');
await r2.page.waitForTimeout(500);
ok('a pasted resume produces a draft', (await r2.page.locator('.draft').count())===1);
await r2.page.click('.draft button[data-a="commitDraft"]');
await r2.page.waitForTimeout(600);
t = await last(r2.page);
ok('it says the resume was filed under Resumes', /filed under \*?\*?Resumes/i.test(t), t.slice(0,300));
let st = stateOf(await r2.page.evaluate(()=>window.__published));
const rdoc = (st.docs||[]).find(d=>d.kind==='Resume');
ok('the resume itself is stored as a document', !!rdoc, JSON.stringify((st.docs||[]).map(d=>d.kind)));
ok('it is attached to the candidate, not an account', !!rdoc && !!rdoc.personId && !rdoc.orgId, JSON.stringify(rdoc&&{p:rdoc.personId,o:rdoc.orgId}));
const marcus = st.people.find(p=>p.name==='Marcus Delacroix');
ok('the document points at the right person', !!rdoc && !!marcus && rdoc.personId===marcus.id);
ok('the resume text is kept for searching', !!rdoc && /Kubernetes/.test(rdoc.text||''));
await r2.page.click('nav.tabs button[data-v="docs"]'); await r2.page.waitForTimeout(200);
t = await r2.page.locator('.wrap').innerText();
ok('the resume appears in the Documents library', /marcus-delacroix-resume\.pdf/.test(t), t.slice(0,300));
ok('filed against the candidate by name', /Marcus Delacroix/.test(t), t.slice(0,400));
ok('and shows Resumes as its folder', /Resumes/.test(t));
await ask(r2.page,'search documents for kubernetes');
ok('the resume text is searchable', /marcus-delacroix-resume/i.test(await last(r2.page)));

// ---- 4. folder setup when creation is BLOCKED (this tenant, today) ----
let r3 = await boot(wrap(authored), { createOk:false });
await ask(r3.page,'set the sharepoint folder to Client Agreements');
await r3.page.locator('.rrow[data-a="spSetFolder"]').first().click();
await r3.page.waitForTimeout(400);
await ask(r3.page,'set up the folders');
await r3.page.waitForTimeout(1200);
t = await last(r3.page);
ok('it reuses a folder that already exists instead of creating it', /Already there:.*Resumes/is.test(t), t.slice(0,300));
ok('it reports how many folders it could not create', /could not create \d+ folders?/i.test(t), t.slice(0,400));
ok('it names the exact permission needed', /Files\.ReadWrite\.All/.test(t), t.slice(0,500));
ok('it lists the folders you can create by hand', /· MSAs/.test(t) && /· Right to Represent/.test(t), t.slice(0,700));
ok('it says the scheme still applies in the workspace', /scheme still applies/i.test(t), t.slice(0,600));
const created = (await r3.page.evaluate(()=>window.__calls)).filter(c=>c.tool==='sharepoint_create_folder');
ok('it did not try to create the folder that already existed',
   !created.some(c=>c.input.name==='Resumes'), JSON.stringify(created.map(c=>c.input.name)));
ok('it stops after one refusal instead of hammering the API', created.length===1, String(created.length)+' attempts');
st = stateOf(await r3.page.evaluate(()=>window.__published)) || {};
ok('the blocked write access is remembered', st.sharepoint && st.sharepoint.writeState==='blocked', JSON.stringify(st.sharepoint));

// ---- 5. folder setup when creation WORKS (after admin consent) ----
let r4 = await boot(wrap(authored), { createOk:true, uploadOk:true });
await ask(r4.page,'set the sharepoint folder to Client Agreements');
await r4.page.locator('.rrow[data-a="spSetFolder"]').first().click();
await r4.page.waitForTimeout(400);
await ask(r4.page,'set up the folders');
await r4.page.waitForTimeout(1500);
t = await last(r4.page);
ok('with consent it creates the missing folders', /Created/i.test(t), t.slice(0,300));
ok('and still reuses the existing Resumes folder', /Already there/i.test(t), t.slice(0,300));
ok('nothing is reported as blocked', !/could not create/i.test(t), t.slice(0,300));
const made = (await r4.page.evaluate(()=>window.__calls)).filter(c=>c.tool==='sharepoint_create_folder').map(c=>c.input.name);
ok('it created every type folder that was missing',
   ['MSAs','SOWs','Exhibits','NDAs','Right to Represent','Rate Sheets','Purchase Orders','Other Documents'].every(n=>made.includes(n)),
   JSON.stringify(made));
st = stateOf(await r4.page.evaluate(()=>window.__published)) || {};
ok('working write access is remembered', st.sharepoint && st.sharepoint.writeState==='ok', JSON.stringify(st.sharepoint));

// a resume now uploads into Resumes/ — via a REAL file drop
let r5 = await boot(await r4.page.evaluate(()=>window.__published), { createOk:true, uploadOk:true });
await r5.page.setInputFiles('#filein', process.argv[3]+'/marcus-resume.txt');
await r5.page.waitForTimeout(900);
ok('a dropped resume produces a draft', (await r5.page.locator('.draft').count())===1, await last(r5.page));
await r5.page.click('.draft button[data-a="commitDraft"]');
await r5.page.waitForTimeout(900);
t = await last(r5.page);
const upcalls = (await r5.page.evaluate(()=>window.__calls)).filter(c=>c.tool==='sharepoint_upload_file');
ok('a resume is uploaded once consent exists', upcalls.length===1, JSON.stringify(upcalls.map(c=>c.input.filename)));
ok('it is uploaded into the Resumes folder', upcalls[0] && upcalls[0].input.parentItemId==='01RES',
   JSON.stringify(upcalls[0]&&{parent:upcalls[0].input.parentItemId}));
ok('the file content is sent as base64', upcalls[0] && typeof upcalls[0].input.contentBase64==='string' && upcalls[0].input.contentBase64.length>0);
ok('it reports where the resume went', /Resumes\*?\*? in SharePoint/i.test(t), t.slice(0,300));
st = stateOf(await r5.page.evaluate(()=>window.__published)) || {docs:[]};
const rdoc2 = (st.docs||[]).find(d=>d.name==='marcus-resume.txt');
ok('the resume record links to the uploaded original', !!rdoc2 && /sharepoint\.com/.test(rdoc2.link||''), JSON.stringify(rdoc2&&{l:rdoc2.link}));

// ---- 6. an MSA routes to MSAs/<account> ----
let r6 = await boot(await r4.page.evaluate(()=>window.__published), { createOk:true, uploadOk:true });
await r6.page.setInputFiles('#filein', process.argv[3]+'/Globex-MSA.txt');
await r6.page.waitForTimeout(900);
t = await last(r6.page);
ok('a dropped MSA is recognised and asks for the account', /which account/i.test(t), t.slice(0,220));
await ask(r6.page,'Globex Industries');
await r6.page.waitForTimeout(1200);
t = await last(r6.page);
st = stateOf(await r6.page.evaluate(()=>window.__published)) || {docs:[]};
const gdoc = (st.docs||[]).find(d=>d.name==='Globex-MSA.txt');
ok('the MSA is filed against the account', !!gdoc && !!gdoc.orgId);
ok('it went to MSAs/<account>', !!gdoc && gdoc.spPath==='MSAs/Globex Industries', JSON.stringify({p:gdoc&&gdoc.spPath}));
ok('the message names that folder', /MSAs\/Globex Industries/.test(t), t.slice(0,300));
const gmade = (await r6.page.evaluate(()=>window.__calls)).filter(c=>c.tool==='sharepoint_create_folder').map(c=>c.input.name);
ok('the per-account subfolder is created under MSAs', gmade.includes('Globex Industries'), JSON.stringify(gmade));
const gup = (await r6.page.evaluate(()=>window.__calls)).filter(c=>c.tool==='sharepoint_upload_file');
ok('the MSA original is uploaded into that subfolder', gup[0] && gup[0].input.parentItemId==='01MADE_GlobexIndustries',
   JSON.stringify(gup[0]&&{p:gup[0].input.parentItemId}));

// ---- 7. no destination set: says where it belongs anyway ----
let r7 = await boot(wrap(authored), { createOk:true, uploadOk:true });
await r7.page.click('button[data-a="pasteResume"]'); await r7.page.waitForTimeout(150);
await r7.page.fill('input[name="name"]','Acme-SOW.pdf');
await r7.page.fill('textarea[name="text"]','STATEMENT OF WORK for Acme. Deliverables and milestones are listed below.');
await r7.page.click('.modal button[type="submit"]');
await r7.page.waitForTimeout(450);
await ask(r7.page,'Northwind Health');
await r7.page.waitForTimeout(400);
t = await last(r7.page);
ok('an account with locations is asked about scope', /all of Northwind Health, or just one location/i.test(t), t.slice(0,200));
await ask(r7.page,'All of Northwind Health');
await r7.page.waitForTimeout(600);
t = await last(r7.page);
ok('a pasted document still names the folder it belongs in', /SOWs\/Northwind Health/.test(t), t.slice(0,300));
ok('it is recorded as account-wide', /account-wide/i.test(t), t.slice(0,300));

// and a location-scoped one
let r8 = await boot(wrap(authored), {});
await r8.page.click('button[data-a="pasteResume"]'); await r8.page.waitForTimeout(150);
await r8.page.fill('input[name="name"]','Chicago-Exhibit-C.pdf');
await r8.page.fill('textarea[name="text"]','EXHIBIT C rate schedule for the Chicago site. Overtime billed at 1.5x.');
await r8.page.click('.modal button[type="submit"]');
await r8.page.waitForTimeout(450);
await ask(r8.page,'Northwind Health');
await r8.page.waitForTimeout(400);
await ask(r8.page,'Chicago HQ');
await r8.page.waitForTimeout(600);
t = await last(r8.page);
ok('an exhibit can be scoped to one location', /scoped to the \*?\*?Chicago HQ/i.test(t), t.slice(0,300));
ok('and is filed under the Exhibits folder', /Exhibits\/Northwind Health/.test(t), t.slice(0,300));
st = stateOf(await r8.page.evaluate(()=>window.__published)) || {docs:[]};
const xdoc = (st.docs||[]).find(d=>d.name==='Chicago-Exhibit-C.pdf');
ok('the location scope is stored on the record', !!xdoc && xdoc.scope==='location' && !!xdoc.locationId, JSON.stringify(xdoc&&{s:xdoc.scope}));

await browser.close();
const pad=Math.max(...results.map(r=>r[1].length));
console.log('');
for(const [s2,n,x] of results) console.log(`${s2}  ${n.padEnd(pad)}  ${s2==='FAIL'?x:''}`);
const f=results.filter(r=>r[0]==='FAIL').length;
console.log(`\n${results.length-f}/${results.length} passed`);
process.exit(f?1:0);
