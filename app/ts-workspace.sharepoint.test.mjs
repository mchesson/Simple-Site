import { chromium } from 'playwright';
import fs from 'fs';
const authored = fs.readFileSync(process.argv[2],'utf8');
const wrap = b => `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>${b}</body></html>`;
const results=[]; const ok=(n,c,x='')=>results.push([c?'PASS':'FAIL',n,x]);
const stateOf = h => { const m=h&&h.match(/<script type="application\/json" id="app-state">([\s\S]*?)<\/script>/); return m?JSON.parse(m[1]):null; };
const browser = await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--no-sandbox']});

// ---- the EXACT wire shapes observed from the live Microsoft 365 connector ----
const SEARCH_PAYLOAD =
'{"uri":"file:///b!DRV1/01ITEMA","driveId":"b!DRV1","content":"<ddd/><c0>MASTER</c0> <c0>SERVICES</c0> <c0>AGREEMENT</c0> This SUBCONTRACTOR <c0>MASTER</c0> <c0>SERVICES</c0> <c0>AGREEMENT</c0> is made<ddd/>","isPartialContent":true,"id":"01ITEMA","name":"Veradigm Master Services Agreement.docx","summary":"<ddd/>msa<ddd/>","webUrl":"https://technicalsource.sharepoint.com/sites/TSWorkSpace2/Shared Documents/Client Agreements/Veradigm/Veradigm Master Services Agreement.docx","downloadUrl":null,"size":null,"lastModifiedDateTime":"2024-10-30T00:38:00.000Z","offset":0}' +
'{"uri":"file:///b!DRV1/01ITEMB","driveId":"b!DRV1","content":"<ddd/><c0>Exhibit</c0> B background and drug screening<ddd/>","isPartialContent":true,"id":"01ITEMB","name":"Veradigm Exhibit B Screening.pdf","summary":"","webUrl":"https://technicalsource.sharepoint.com/sites/TSWorkSpace2/Shared Documents/Client Agreements/Veradigm/Veradigm Exhibit B Screening.pdf","downloadUrl":null,"size":null,"lastModifiedDateTime":"2025-02-11T09:10:00.000Z","offset":1}' +
'{"moreResults":true,"nextOffset":2,"totalResultCount":890}';
const FOLDER_PAYLOAD =
'{"uri":"file:///b!DRV1/01FOLDER1","driveId":"b!DRV1","id":"01FOLDER1","name":"Client Agreements","webUrl":"https://technicalsource.sharepoint.com/sites/TSWorkSpace2/Shared Documents/Client Agreements","lastModifiedDateTime":"2026-04-16T15:51:32.000Z","offset":0}' +
'{"moreResults":false,"nextOffset":1,"totalResultCount":1}';
const READ_PAYLOAD = 'MASTER SERVICES AGREEMENT  Termination: either party may terminate for convenience upon thirty (30) days written notice. Payment terms are net forty-five (45) days.\n\n[pages 1–6 of 6]';
const FORBIDDEN = { code:'tool_error', message:"FORBIDDEN: Graph denied access; this tool requires the 'Files.ReadWrite.All' delegated permission.", result:{ code:'FORBIDDEN', details:{ graphErrorCode:'accessDenied', graphStatusCode:403 } } };

function shim(opts){
  const o = Object.assign({ tools:['sharepoint_search','sharepoint_folder_search','read_resource','sharepoint_upload_file'], authStatus:'connected', present:true, mcp:true, uploadOk:false, listErr:null, searchErr:null }, opts||{});
  return `
  window.__published=null; window.__calls=[];
  const OPTS = ${JSON.stringify(o)};
  const SEARCH=${JSON.stringify(SEARCH_PAYLOAD)}, FOLDERS=${JSON.stringify(FOLDER_PAYLOAD)}, READ=${JSON.stringify(READ_PAYLOAD)}, FORB=${JSON.stringify(FORBIDDEN)};
  const mcp = {
    listTools: async () => {
      if(OPTS.listErr) throw OPTS.listErr;
      return { servers: OPTS.present ? [{ server:'Microsoft 365', authStatus:OPTS.authStatus, tools:OPTS.tools.map(n=>({name:n,description:''})) }] : [] };
    },
    callTool: async (server, tool, input) => {
      window.__calls.push({server,tool,input});
      if(OPTS.searchErr && tool==='sharepoint_search') throw OPTS.searchErr;
      if(tool==='sharepoint_search') return { content:[{type:'text',text:SEARCH}], payload:SEARCH };
      if(tool==='sharepoint_folder_search') return { content:[{type:'text',text:FOLDERS}], payload:FOLDERS };
      if(tool==='read_resource') return { content:[{type:'text',text:READ}], payload:READ };
      if(tool==='sharepoint_upload_file'){
        if(!OPTS.uploadOk) throw FORB;
        return { payload: JSON.stringify({ id:'01NEW', webUrl:'https://technicalsource.sharepoint.com/sites/TSWorkSpace2/Shared Documents/Client Agreements/new.pdf', uri:'file:///b!DRV1/01NEW' }) };
      }
      throw { code:'not_in_manifest', message:'nope' };
    },
    invalidate: async () => {}, watchTool: () => () => {}
  };
  window.claude = { use: n => Promise.resolve(
      n==='artifact' ? { publish: async h => { window.__published=h; return {version:'v1'}; } }
    : n==='mcp' ? (OPTS.mcp ? mcp : null)
    : n==='downloads' ? { save: async()=>{} } : null) };
  `;
}
let SER=0;
async function boot(html, opts){
  const f=`${process.argv[3]}/t3_${SER++}.html`; fs.writeFileSync(f,html);
  const ctx=await browser.newContext(); const page=await ctx.newPage();
  const errs=[]; page.on('pageerror',e=>errs.push(e.message));
  page.on('console',m=>{ if(m.type()==='error'&&!/ERR_|Failed to load/.test(m.text())) errs.push(m.text()); });
  await page.addInitScript(shim(opts));
  await page.goto('file://'+f,{waitUntil:'load'}); await page.waitForTimeout(300);
  return {page,errs};
}
const ask = async (pg,t) => { await pg.fill('#askin',t); await pg.press('#askin','Enter'); await pg.waitForTimeout(400); };
const last = pg => pg.locator('.msg.as').last().innerText();

// ---- 1. connected: status + search + attach + index ----
let {page,errs} = await boot(wrap(authored), {});
ok('page boots with the connector present', errs.length===0, errs.join(' | '));
await ask(page,'sharepoint status');
let t = await last(page);
ok('reports the connector as connected', /connected/i.test(t), t.slice(0,160));
ok('it does not claim saving works before trying it', /not been tried yet/i.test(t) && /Files\.ReadWrite\.All/i.test(t), t.slice(0,300));

await ask(page,'search sharepoint for master services agreement');
t = await last(page);
ok('search returns results from the concatenated-JSON payload', /2 files in SharePoint/i.test(t), t.slice(0,200));
ok('the pagination object is not treated as a result', !/moreResults|totalResultCount/i.test(t));
ok('filenames are shown', /Veradigm Master Services Agreement\.docx/.test(t), t.slice(0,300));
ok('highlight markup is stripped from snippets', !/<c0>|<ddd\/>/.test(t), t.slice(0,300));
ok('the folder path is shown', /Client Agreements/.test(t), t.slice(0,300));
ok('an Open in SharePoint link is offered', (await page.locator('.sprow a[href*="sharepoint.com"]').count())>=2);
const calls1 = await page.evaluate(()=>window.__calls);
ok('it called sharepoint_search with the query', calls1.some(c=>c.tool==='sharepoint_search'&&c.input.query==='master services agreement'), JSON.stringify(calls1[0]));

// attach → asks which account, then files it and indexes the text
await page.locator('.sprow button[data-a="spAttach"]').first().click();
await page.waitForTimeout(300);
t = await last(page);
ok('attaching asks which account to file against', /which account/i.test(t), t.slice(0,160));
await ask(page,'Veradigm');
await page.waitForTimeout(400);
t = await last(page);
ok('the file is filed against the account', /Filed \*?\*?Veradigm Master Services Agreement/i.test(t), t.slice(0,240));
ok('a new account was created for it', /created that account/i.test(t), t.slice(0,260));
ok('it reports the full text as indexed', /full text is indexed/i.test(t), t.slice(0,260));
const calls2 = await page.evaluate(()=>window.__calls);
ok('it called read_resource with the file uri', calls2.some(c=>c.tool==='read_resource'&&c.input.uri==='file:///b!DRV1/01ITEMA'), JSON.stringify(calls2.filter(c=>c.tool==='read_resource')[0]));
let st = stateOf(await page.evaluate(()=>window.__published));
const vdoc = (st.docs||[]).find(d=>d.name==='Veradigm Master Services Agreement.docx');
ok('the document record stores the SharePoint link', !!vdoc && /sharepoint\.com/.test(vdoc.link||''), JSON.stringify(vdoc&&{l:vdoc.link}));
ok('it stores the drive and item ids', !!vdoc && vdoc.spDriveId==='b!DRV1' && vdoc.spItemId==='01ITEMA');
ok('it stores the indexed text, not the snippet', !!vdoc && /thirty \(30\) days/.test(vdoc.text||''), (vdoc&&vdoc.text||'').slice(0,80));
ok('the page-count footer is stripped from the text', !!vdoc && !/\[pages/.test(vdoc.text||''));
ok('the kind was detected as MSA', !!vdoc && vdoc.kind==='MSA', vdoc&&vdoc.kind);

// the indexed text is now searchable in the workspace
let r2 = await boot(await page.evaluate(()=>window.__published), {});
await ask(r2.page,'search documents for thirty days written notice');
t = await last(r2.page);
ok('SharePoint text is searchable inside the workspace',
   /Veradigm Master Services Agreement\.docx/.test(t), t.slice(0,260));

// attaching the same file twice is refused
await ask(r2.page,'search sharepoint for master services agreement');
await r2.page.waitForTimeout(200);
const alreadyPill = await r2.page.locator('.sprow .pill.g', {hasText:'already filed'}).count();
ok('a file already filed is marked as such, not offered twice', alreadyPill>=1, String(alreadyPill));

// ---- 2. account screen SharePoint card ----
await r2.page.click('nav.tabs button[data-v="orgs"]'); await r2.page.waitForTimeout(200);
await r2.page.locator('tbody tr',{hasText:'Veradigm'}).first().click(); await r2.page.waitForTimeout(250);
let detail = await r2.page.locator('.wrap').innerText();
ok('the account screen has a SharePoint card', /SharePoint/.test(detail));
ok('it shows the connector as connected', /connected/i.test(detail));
ok('it counts what is linked from SharePoint', /1 linked from SharePoint/i.test(detail), detail.slice(0,400));
ok('it offers a per-account search', (await r2.page.locator('button[data-a="spFind"]').count())===1);
ok('the document row offers Open original', (await r2.page.locator('.docrow a.btn', {hasText:'Open original'}).count())>=1);
await r2.page.locator('button[data-a="spFind"]').click();
await r2.page.waitForTimeout(450);
ok('the per-account button runs a SharePoint search', /files in SharePoint/i.test(await last(r2.page)));

// ---- 3. upload blocked: the FORBIDDEN branch must name the real fix ----
let r3 = await boot(wrap(authored), {});
await ask(r3.page,'set the sharepoint folder to Client Agreements');
t = await last(r3.page);
ok('folder search offers a destination to pick', /Pick where originals/i.test(t), t.slice(0,160));
await r3.page.locator('.rrow[data-a="spSetFolder"]').first().click();
await r3.page.waitForTimeout(350);
t = await last(r3.page);
ok('choosing a destination is confirmed', /Originals will be saved to/i.test(t), t.slice(0,200));
ok('it is honest that saving is unproven', /not been tried yet/i.test(t), t.slice(0,300));
st = stateOf(await r3.page.evaluate(()=>window.__published));
ok('the destination is stored for the team', !!st && st.sharepoint && st.sharepoint.driveId==='b!DRV1', JSON.stringify(st&&st.sharepoint));

// with the upload tool present but Graph refusing, the error must be specific
const forb = await r3.page.evaluate(async () => {
  try{ await window.claude.use('mcp').then(m=>m.callTool('Microsoft 365','sharepoint_upload_file',{})); }
  catch(e){ return spErr(e); }
});
ok('a FORBIDDEN upload is explained, not swallowed', /Files\.ReadWrite\.All/.test(forb.d), JSON.stringify(forb));
ok('it says reading still works', /searching and reading work/i.test(forb.d), forb.d.slice(0,160));

// ---- 4. every distinct failure code gets its own fix, not one banner ----
let r4 = await boot(wrap(authored), {});
const copies = await r4.page.evaluate(() => {
  const codes = ['needs_reauth','server_not_connected','selection_required','blocked_by_policy',
                 'approval_required','server_unavailable','not_in_manifest','rate_limited',
                 'not_granted','cancelled','server_not_found','weird_future_code'];
  const out = {};
  codes.forEach(c => { const r = spErr({code:c, message:'m'}); out[c] = r.t + ' :: ' + r.d; });
  return out;
});
const distinct = new Set(Object.values(copies));
ok('each error code produces distinct guidance', distinct.size >= 10, `${distinct.size} distinct of ${Object.keys(copies).length}`);
ok('needs_reauth tells you to reconnect', /reconnect/i.test(copies.needs_reauth), copies.needs_reauth);
ok('server_not_connected tells you to add the connector', /add the microsoft 365 connector/i.test(copies.server_not_connected), copies.server_not_connected);
ok('selection_required tells you to pick an account', /pick one/i.test(copies.selection_required), copies.selection_required);
ok('blocked_by_policy names the administrator', /administrator/i.test(copies.blocked_by_policy), copies.blocked_by_policy);
ok('an unknown future code falls back gracefully', /failed/i.test(copies.weird_future_code), copies.weird_future_code);

// ---- 5. degraded states ----
let r5 = await boot(wrap(authored), { present:false });
await ask(r5.page,'sharepoint status');
t = await last(r5.page);
ok('a missing connector is reported as not connected', /not connected/i.test(t), t.slice(0,160));
await ask(r5.page,'search sharepoint for anything');
t = await last(r5.page);
ok('searching without a connector explains how to add it', /Settings → Connectors/i.test(t), t.slice(0,200));
await r5.page.click('nav.tabs button[data-v="orgs"]'); await r5.page.waitForTimeout(150);
await r5.page.locator('tbody tr').first().click(); await r5.page.waitForTimeout(250);
detail = await r5.page.locator('.wrap').innerText();
ok('the account card degrades with a fix, not an error', /not connected/i.test(detail) && /Settings → Connectors/.test(detail), detail.slice(0,300));

let r6 = await boot(wrap(authored), { authStatus:'needs_reauth' });
await ask(r6.page,'sharepoint status');
ok('a lapsed sign-in is reported as such', /lapsed|reconnect/i.test(await last(r6.page)));

let r7 = await boot(wrap(authored), { mcp:false });
ok('no MCP capability at all still boots cleanly', r7.errs.length===0, r7.errs.join(' | '));
await ask(r7.page,'sharepoint status');
ok('without connectors it says so plainly', /not available in this view/i.test(await last(r7.page)));
await r7.page.click('nav.tabs button[data-v="cands"]'); await r7.page.waitForTimeout(120);
ok('the rest of the app is unaffected without connectors', (await r7.page.locator('tbody tr').count())>=5);

let r8 = await boot(wrap(authored), { searchErr:{code:'server_unavailable',message:'timeout',retryable:true} });
await ask(r8.page,'search sharepoint for anything');
await r8.page.waitForTimeout(1600);   // the single retry sleeps 600-1000ms first
t = await last(r8.page);
ok('a transient failure is reported as temporary', /temporary|did not answer/i.test(t), t.slice(0,200));
const tries = (await r8.page.evaluate(()=>window.__calls)).filter(c=>c.tool==='sharepoint_search').length;
ok('a retryable error is retried exactly once', tries===2, `${tries} attempts`);

let r9 = await boot(wrap(authored), { searchErr:{code:'needs_reauth',message:'expired'} });
await ask(r9.page,'search sharepoint for anything');
await r9.page.waitForTimeout(1600);
const tries9 = (await r9.page.evaluate(()=>window.__calls)).filter(c=>c.tool==='sharepoint_search').length;
ok('a non-retryable auth error is NOT retried', tries9===1, `${tries9} attempts`);

await browser.close();
const pad=Math.max(...results.map(r=>r[1].length));
console.log('');
for(const [s2,n,x] of results) console.log(`${s2}  ${n.padEnd(pad)}  ${s2==='FAIL'?x:''}`);
const f=results.filter(r=>r[0]==='FAIL').length;
console.log(`\n${results.length-f}/${results.length} passed`);
process.exit(f?1:0);
