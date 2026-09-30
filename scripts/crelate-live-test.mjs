// Live end-to-end check of the website's Crelate writes, against the REAL
// Crelate account, using only a hidden test job and fake test people.
//
//   npm run crelate:live-test            run every check, then delete the test records
//   npm run crelate:live-test -- cleanup delete whatever an interrupted run left behind
//   npm run crelate:live-test -- sources list Crelate's contact source names
//
// What it does:
//   1. Creates ONE job named "TEST – Website Check, do not apply". The API has
//      no portal or job-board fields, so it is never posted anywhere; the
//      script stops if Crelate ever reports it as on the portal.
//   2. Applies to it through POST /jobs/{id}/apply (applicant + resume), the
//      way src/pages/api/apply.ts does, and checks the application: right job,
//      resume attached, contact source "Website".
//   3. General resume ("Not Looking Right Now?"): candidate + resume + note.
//   4. Contact form: client contact (RecordType 2) + note.
//   5. Deletes everything it created. Crelate has no "delete application", so
//      test applications are rejected instead (and named as tests).
// Test people are "Website Test" with website-test+<time>@example.com.
// Created record IDs are kept in .crelate-test-state.json until cleaned up.
//
// Needs CRELATE_API_KEY. The key goes only in the X-Api-Key header and is
// never printed.
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';

const BASE = (process.env.CRELATE_API_BASE || 'https://app.crelate.com/api3').replace(/\/$/, '');
const KEY = process.env.CRELATE_API_KEY;
const JOB_NAME = 'TEST – Website Check, do not apply';
const RECRUITING_WORKFLOW = 'F6EF012F-998D-4132-B38B-A17A00B2B958';
const STATE = new URL('../.crelate-test-state.json', import.meta.url);

if (!KEY) { console.error('CRELATE_API_KEY is not set.'); process.exit(1); }

const results = [];
const pass = (what, detail = '') => { results.push(['✓', what, detail]); console.log(`✓ ${what}${detail ? `: ${detail}` : ''}`); };
const fail = (what, detail = '') => { results.push(['✗', what, detail]); console.log(`✗ ${what}${detail ? `: ${detail}` : ''}`); };

const redact = (s) => String(s).split(KEY).join('[key]');
async function cr(path, { method = 'GET', params, body } = {}) {
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, String(v));
  const form = body instanceof FormData;
  const res = await fetch(url, {
    method,
    headers: { Accept: 'application/json', 'X-Api-Key': KEY, ...(body && !form ? { 'Content-Type': 'application/json' } : {}) },
    body: form ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data, errors: redact(JSON.stringify(data?.Errors ?? data ?? '')).slice(0, 300) };
}
const list = (r) => (Array.isArray(r.data?.Data) ? r.data.Data : []);

// Everything created, so cleanup can find it even after a crash.
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { jobs: [], applications: [], contacts: [], notes: [], artifacts: [], emails: [] };
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
const remember = (kind, id) => { if (id && !state[kind].includes(id)) { state[kind].push(id); save(); } };

// A small but complete PDF (with a cross-reference table and one line of
// text), so Crelate can read it like a real resume.
function makePdf(text) {
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>',
    null,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
  ];
  const stream = `BT /F1 14 Tf 72 720 Td (${text}) Tj ET`;
  objs[3] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const PDF = makePdf('Website Test - test resume for the website check. Delete.');
const resume = (name) => new File([PDF], name, { type: 'application/pdf' });

async function websiteSource() {
  const all = list(await cr('contactsources', { params: { limit: 100 } }));
  const name = (s) => String(s?.Name ?? '').trim();
  return all.find((s) => /^(company )?web ?site$/i.test(name(s))) ?? all.find((s) => /\bweb ?site\b/i.test(name(s))) ?? null;
}

// ---------------------------------------------------------------------------

async function createTestJob() {
  const r = await cr('jobs', { method: 'POST', body: { entity: { Name: JOB_NAME, WorkflowTypeId: { Id: RECRUITING_WORKFLOW }, NumberOfOpenings: 0 } } });
  const id = typeof r.data?.Data === 'string' ? r.data.Data : null;
  if (!id) throw new Error(`could not create the test job (${r.status} ${r.errors})`);
  remember('jobs', id);
  const job = (await cr(`jobs/${id}`)).data?.Data ?? {};
  if (job.OnPortal === true || job.IsPublishedToFreeBoards === true) {
    await cr(`jobs/${id}`, { method: 'DELETE' });
    throw new Error('Crelate reported the test job as posted; it was deleted immediately and the run stopped');
  }
  pass('Hidden test job created', `not on the portal (OnPortal ${job.OnPortal ?? 'unset'}), not on job boards`);
  return id;
}

// The multipart shape the website sends (src/crelate.ts applyToJob):
// "applicant" as a JSON text field and the resume as "resumeFile".
// (A JSON part answers 500; other file field names answer "A resume is required".)
const RESUME_FIELDS = ['resumeFile'];
function applyForm(applicant, file, field) {
  const f = new FormData();
  f.append('applicant', JSON.stringify(applicant));
  f.append(field, file);
  return f;
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
/** Files Crelate keeps for a record (contact or application). Uploads are
 *  processed in the background, so this waits up to about 30 seconds. */
async function filesOf(...ids) {
  for (let i = 0; i < 10; i++) {
    for (const id of ids.filter(Boolean)) {
      const found = list(await cr('artifacts', { params: { parent_ids: id, limit: 10 } }));
      if (found.length) return found;
    }
    await pause(3000);
  }
  return [];
}
async function testApply(jobId, source, stamp) {
  const email = `website-test+apply${stamp}@example.com`;
  state.emails.push(email); save();
  const applicant = { FirstName: 'Website', LastName: `Test Apply ${stamp}`, Email_Personal: email, Phone_Mobile: '', ...(source && { ContactSourceId: { Id: source.Id } }) };
  if (!applicant.Phone_Mobile) delete applicant.Phone_Mobile;

  for (const field of RESUME_FIELDS) {
    const r = await cr(`jobs/${jobId}/apply`, { method: 'POST', body: applyForm(applicant, resume(`website-test-${stamp}.pdf`), field) });
    const appId = typeof r.data?.Data === 'string' ? r.data.Data : null;
    if (!r.ok || !appId) { console.log(`  · resume as "${field}": ${r.status} ${r.errors}`); continue; }
    remember('applications', appId);
    // Crelate may attach the file a moment after answering.
    const app = (await cr(`applications/${appId}`)).data?.Data ?? {};
    const files = await filesOf(appId, app.ContactId?.Id);
    files.forEach((a) => remember('artifacts', a.Id));
    if (app.ContactId?.Id) remember('contacts', app.ContactId.Id);
    const checks = {
      'right job': app.JobId?.Id?.toLowerCase() === jobId.toLowerCase(),
      'resume attached': Boolean(app.PrimaryDocumentAttachmentId || files.length),
      'source "Website"': !source || app.ContactSourceId?.Id?.toLowerCase() === String(source.Id).toLowerCase(),
      'applicant name': app.FirstName === 'Website',
    };
    const missing = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
    console.log(`  · resume as "${field}": application ${appId}, ${missing.length ? `missing ${missing.join(', ')}` : 'complete'}`);
    if (!missing.length) {
      pass('Application through /apply', `applicant as JSON text, resume as "${field}"; right job, resume attached, source ${source?.Name ?? 'n/a'}${app.ContactId?.Id ? ', auto-approved to a contact' : ', waiting in Recruiting Intake'}`);
      return { field, appId };
    }
    if (missing.some((m) => m !== 'resume attached')) { fail('Application through /apply', `missing: ${missing.join(', ')}`); return null; }
  }
  fail('Application through /apply', 'created, but no resume field name attached the file');
  return null;
}

async function testGeneralResume(source, stamp) {
  const email = `website-test+resume${stamp}@example.com`;
  state.emails.push(email); save();
  const entity = { FirstName: 'Website', LastName: `Test Resume ${stamp}`, RecordType: 1, EmailAddresses_Personal: { Value: email, IsPrimary: true }, ...(source && { ContactSourceId: { Id: source.Id } }) };
  const c = await cr('contacts', { method: 'POST', body: { entity } });
  const id = typeof c.data?.Data === 'string' ? c.data.Data : null;
  if (!id) return fail('General resume: candidate', `${c.status} ${c.errors}`);
  remember('contacts', id);
  // The website's own upload (src/crelate.ts uploadResume).
  const name = `website-test-resume-${stamp}.pdf`;
  const shapes = [
    ['primary, file only', 'artifacts/primary', () => { const f = new FormData(); f.append('file', resume(name)); return f; }],
  ];
  let files = [], uploadShape = null;
  for (const [label, path, build] of shapes) {
    const up = await cr(path, { method: 'POST', params: { target_entity_name: 'Contacts', target_record_id: id }, body: build() });
    if (typeof up.data?.Data === 'string') remember('artifacts', up.data.Data);
    files = up.ok ? await filesOf(id) : [];
    console.log(`  · resume upload (${label}): ${up.status}${up.ok ? '' : ` ${up.errors}`}, ${files.length ? 'file on the contact' : 'no file on the contact'}`);
    if (files.length) { uploadShape = label; break; }
  }
  files.forEach((a) => remember('artifacts', a.Id));
  const got = (await cr(`contacts/${id}`)).data?.Data ?? {};
  const n = await cr('notes', { method: 'POST', body: { entity: { Display: 'Website Resume submission (general consideration)\nTEST RECORD from the website check; delete.', ParentId: { Id: id, EntityName: 'Contacts' } } } });
  if (typeof n.data?.Data === 'string') remember('notes', n.data.Data);
  const ok = (Number(got.RecordType) & 1) && files.length > 0 && n.ok;
  (ok ? pass : fail)('General resume ("Not Looking Right Now?")', `candidate ${Number(got.RecordType) & 1 ? 'yes' : 'NO'}, resume ${files.length ? `attached (${uploadShape})` : 'MISSING'}, note ${n.ok ? 'added' : `FAILED ${n.errors}`}, no job`);
}

async function testContactForm(source, stamp) {
  const email = `website-test+contact${stamp}@example.com`;
  state.emails.push(email); save();
  const entity = { FirstName: 'Website', LastName: `Test Contact ${stamp}`, RecordType: 2, EmailAddresses_Personal: { Value: email, IsPrimary: true }, ...(source && { ContactSourceId: { Id: source.Id } }) };
  const c = await cr('contacts', { method: 'POST', body: { entity } });
  const id = typeof c.data?.Data === 'string' ? c.data.Data : null;
  if (!id) return fail('Contact form: client contact', `${c.status} ${c.errors}`);
  remember('contacts', id);
  const n = await cr('notes', { method: 'POST', body: { entity: { Display: 'Website inquiry (contact form)\nTEST RECORD from the website check; delete.', ParentId: { Id: id, EntityName: 'Contacts' } } } });
  if (typeof n.data?.Data === 'string') remember('notes', n.data.Data);
  const got = (await cr(`contacts/${id}`)).data?.Data ?? {};
  const ok = Number(got.RecordType) & 2 && n.ok;
  (ok ? pass : fail)('Contact form', `client contact (RecordType ${got.RecordType}), note ${n.ok ? 'added' : `FAILED ${n.errors}`}`);
}

// ---------------------------------------------------------------------------

async function cleanup() {
  let left = 0;
  const rejected = state.applications.length;
  const gone = (kind, id, r) => { if (r.ok || r.status === 404) state[kind] = state[kind].filter((x) => x !== id); else { left++; console.log(`  ! could not remove ${kind} ${id}: ${r.status} ${r.errors}`); } save(); };
  for (const id of [...state.applications]) {
    const r = await cr(`applications/${id}/reject`, { method: 'POST', body: { ApplicationId: id, IgnorePossibleMatches: false } });
    const app = (await cr(`applications/${id}`)).data?.Data;
    if (app?.ContactId?.Id) remember('contacts', app.ContactId.Id);
    gone('applications', id, r.status === 400 && /reject|closed|status/i.test(r.errors) ? { ok: true } : r);
  }
  // Contacts found by the test emails, in case Crelate created one on its own.
  for (const email of state.emails) for (const c of list(await cr('contacts', { params: { emails: email, limit: 5 } }))) remember('contacts', c.Id);
  for (const id of [...state.notes]) gone('notes', id, await cr(`notes/${id}`, { method: 'DELETE' }));
  for (const id of [...state.artifacts]) gone('artifacts', id, await cr(`artifacts/${id}`, { method: 'DELETE' }));
  for (const id of [...state.contacts]) {
    // Only ever delete contacts that carry one of this run's test emails.
    const c = (await cr(`contacts/${id}`)).data?.Data;
    const emails = JSON.stringify(c ?? {}).toLowerCase();
    if (c && !state.emails.some((e) => emails.includes(e.toLowerCase()))) { console.log(`  ! skipped contact ${id}: not a test contact`); state.contacts = state.contacts.filter((x) => x !== id); save(); continue; }
    gone('contacts', id, await cr(`contacts/${id}`, { method: 'DELETE' }));
  }
  for (const id of [...state.jobs]) {
    const j = (await cr(`jobs/${id}`)).data?.Data;
    if (j && j.Name !== JOB_NAME) { console.log(`  ! skipped job ${id}: not the test job`); state.jobs = state.jobs.filter((x) => x !== id); save(); continue; }
    gone('jobs', id, await cr(`jobs/${id}`, { method: 'DELETE' }));
  }
  if (!left) { state.emails = []; save(); rmSync(STATE, { force: true }); }
  (left ? fail : pass)('Cleanup', left ? `${left} record(s) left; run "npm run crelate:live-test -- cleanup"` : `test job, contacts, notes and files deleted${rejected ? `; ${rejected} test application(s) rejected (Crelate can't delete applications)` : ''}`);
}

async function main() {
  if (process.argv[2] === 'cleanup') return cleanup();
  if (process.argv[2] === 'sources') return console.log(list(await cr('contactsources', { params: { limit: 100 } })).map((s) => s.Name).sort().join('\n'));
  const stamp = Date.now();
  const source = await websiteSource();
  (source ? pass : fail)('Contact source named "Website"', source?.Name ?? 'none in Crelate yet, so website records get no source (add one: Crelate → Settings → Contact Sources)');
  try {
    const jobId = await createTestJob();
    await testApply(jobId, source, stamp);
    await testGeneralResume(source, stamp);
    await testContactForm(source, stamp);
  } catch (e) {
    fail('Run stopped', redact(e instanceof Error ? e.message : e));
  } finally {
    await cleanup();
  }
  console.log(`\n${results.filter((r) => r[0] === '✓').length} passed, ${results.filter((r) => r[0] === '✗').length} failed`);
  if (results.some((r) => r[0] === '✗')) process.exitCode = 1;
}

main().catch((e) => { console.error(redact(e instanceof Error ? e.stack : e)); process.exit(1); });
