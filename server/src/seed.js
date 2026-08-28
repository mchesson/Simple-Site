// Demo data. Small, but shaped like the real business: multi-owner accounts,
// sites with their own rules, one human who is both a manager and a candidate,
// projects across every delivery type, and a purchase order mid burn.
//
//   node src/seed.js --reset    drop and rebuild the schema, then seed
//   node src/seed.js            seed into an existing empty schema

import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { config, ROOT } from "./config.js";

const reset = process.argv.includes("--reset");
const client = new pg.Client({ connectionString: config.databaseUrl });
await client.connect();

if (reset) {
  await client.query(`drop schema public cascade; create schema public;`);
  await client.query(`grant usage on schema public to ts_app, ts_readonly;
                      grant all on schema public to ts_app;`);
  const sql = fs.readFileSync(path.join(ROOT, "src", "schema.sql"), "utf8");
  await client.query(sql);
  await client.query(`
    grant select, insert, update, delete on all tables in schema public to ts_app;
    grant usage, select on all sequences in schema public to ts_app;
    grant execute on all functions in schema public to ts_app;
    grant select on all tables in schema public to ts_readonly;`);
  console.log("schema rebuilt");
}

const q = (t, p) => client.query(t, p).then((r) => r.rows[0]);

// -- users -------------------------------------------------------------------
const mark = await q(
  `insert into app_user (email, full_name, role) values
   ('mchesson@technicalsource.com','Mark Chesson','admin') returning *`);
const rae = await q(
  `insert into app_user (email, full_name, role) values
   ('rae.lambert@technicalsource.com','Rae Lambert','account_manager') returning *`);
const dev = await q(
  `insert into app_user (email, full_name, role) values
   ('devon.ok@technicalsource.com','Devon Okafor','recruiter') returning *`);
const sam = await q(
  `insert into app_user (email, full_name, role) values
   ('sam.iyer@technicalsource.com','Sam Iyer','delivery') returning *`);

// -- accounts ----------------------------------------------------------------
const globex = await q(
  `insert into account (name, status, industry, bg_check_policy, drug_test_policy,
                        onboarding_notes)
   values ('Globex Manufacturing','active','Industrial',
     '7-year county and federal criminal, MVR for any role that drives.',
     '5-panel pre-hire, no THC screen in states where it is prohibited.',
     'Badge photo on day one. Safety orientation before floor access.')
   returning *`);
const initech = await q(
  `insert into account (name, status, industry, bg_check_policy)
   values ('Initech Financial','active','Financial services',
     '10-year criminal plus FINRA check. Credit check for treasury roles.')
   returning *`);
const hooli = await q(
  `insert into account (name, status, industry)
   values ('Hooli Health','prospect','Healthcare IT') returning *`);

// Two owners on Globex, split. Hooli deliberately has none, so "unassigned
// accounts" has something to return.
await client.query(
  `insert into account_owner (account_id, user_id, role, split_pct) values
   ($1,$2,'account_manager',60), ($1,$3,'recruiter',40), ($4,$5,'account_manager',100)`,
  [globex.id, rae.id, dev.id, initech.id, mark.id]);

// -- locations ---------------------------------------------------------------
const austin = await q(
  `insert into location (account_id, name, address1, city, state, postal_code,
                         rules_of_engagement, drug_test_notes)
   values ($1,'Globex Austin Plant','4400 Tech Ridge Blvd','Austin','TX','78753',
     'All reqs route through the plant manager. No direct contact with line supervisors.
Submittals capped at three per opening.',
     'Site adds a respirator fit test for anyone on the fabrication floor.')
   returning *`, [globex.id]);
const reno = await q(
  `insert into location (account_id, name, address1, city, state, postal_code,
                         rules_of_engagement)
   values ($1,'Globex Reno Distribution','900 Vassar St','Reno','NV','89502',
     'Reno runs its own approvals. Rates are set by the regional director, not the plant.')
   returning *`, [globex.id]);
const nyc = await q(
  `insert into location (account_id, name, city, state, rules_of_engagement)
   values ($1,'Initech Manhattan','New York','NY',
     'VMS only. Anything submitted outside the VMS is disqualified.') returning *`,
  [initech.id]);

// -- contacts ----------------------------------------------------------------
// Dana is the case that breaks systems built on two tables: she is the hiring
// manager at Globex Austin, and she is also in our candidate pool.
const dana = await q(
  `insert into contact (full_name, email, phone, title, is_manager, is_candidate,
                        account_id, location_id, headline, skills, location_text, source)
   values ('Dana Reyes','dana.reyes@globex.com','512-555-0143','Plant Engineering Manager',
     true,true,$1,$2,'Plant engineering leader, 14 years in discrete manufacturing',
     '{"Operations","Lean","SAP PM"}','Austin, TX','Referral')
   returning *`, [globex.id, austin.id]);
const priya = await q(
  `insert into contact (full_name, email, title, is_manager, account_id, location_id)
   values ('Priya Raman','p.raman@globex.com','Distribution Director',true,$1,$2)
   returning *`, [globex.id, reno.id]);
const walt = await q(
  `insert into contact (full_name, email, title, is_manager, account_id, location_id)
   values ('Walter Nkemdirim','w.nk@initech.com','VP Technology',true,$1,$2)
   returning *`, [initech.id, nyc.id]);

const marcus = await q(
  `insert into contact (full_name, email, phone, is_candidate, headline, skills,
                        location_text, on_payroll, recruiter_id, source)
   values ('Marcus Bell','marcus.bell@example.com','737-555-0110',true,
     'Senior data engineer, 9 years, healthcare and manufacturing',
     '{"Python","Airflow","dbt","Snowflake","SQL"}','Austin, TX',true,$1,'LinkedIn')
   returning *`, [dev.id]);
const jo = await q(
  `insert into contact (full_name, email, is_candidate, headline, skills, location_text,
                        recruiter_id, source)
   values ('Jo Nakamura','jo.nakamura@example.com',true,
     'Controls engineer, PLC and SCADA','{"PLC","Allen-Bradley","SCADA","Ignition"}',
     'Reno, NV',$1,'Job board') returning *`, [dev.id]);
const tess = await q(
  `insert into contact (full_name, email, is_candidate, headline, skills, location_text,
                        recruiter_id)
   values ('Tess Alvarez','tess.a@example.com',true,'Project manager, PMP, ERP rollouts',
     '{"PMP","ERP","Change management"}','Remote',$1) returning *`, [sam.id]);

// -- projects ----------------------------------------------------------------
const dataPlatform = await q(
  `insert into project (account_id, location_id, name, delivery_type, status, openings,
                        pay_rate_min, pay_rate_max, bill_rate_min, bill_rate_max,
                        start_date, description, skills, owner_id)
   values ($1,$2,'Plant data platform build','managed_project','open',3,
     60,75,95,120,'2026-09-14',
     'Stand up the plant telemetry warehouse. Team lead plus two engineers, our people,
no fixed deliverables - Globex directs the work week to week.',
     '{"Python","Airflow","Snowflake"}',$3) returning *`,
  [globex.id, austin.id, sam.id]);
const controls = await q(
  `insert into project (account_id, location_id, name, delivery_type, status, openings,
                        pay_rate_min, pay_rate_max, bill_rate_min, bill_rate_max,
                        start_date, skills, owner_id)
   values ($1,$2,'Controls engineer - line 4','staffing','open',1,
     52,58,82,92,'2026-09-01','{"PLC","Allen-Bradley"}',$3) returning *`,
  [globex.id, reno.id, dev.id]);
const erp = await q(
  `insert into project (account_id, location_id, name, delivery_type, status, openings,
                        bill_rate_min, start_date, skills, owner_id)
   values ($1,$2,'ERP cutover PMO','managed_service','open',1,140,'2026-10-01',
     '{"PMP","ERP"}',$3) returning *`, [initech.id, nyc.id, mark.id]);
const perm = await q(
  `insert into project (account_id, name, delivery_type, status, openings, owner_id)
   values ($1,'Director of Analytics (perm)','direct_hire','open',1,$2) returning *`,
  [initech.id, mark.id]);

// -- submissions and placements ---------------------------------------------
const sub1 = await q(
  `insert into submission (project_id, contact_id, stage, submitted_by, pay_rate, bill_rate)
   values ($1,$2,'placed',$3,68,108) returning *`, [dataPlatform.id, marcus.id, dev.id]);
await client.query(
  `insert into submission_event (submission_id, from_stage, to_stage, actor_id) values
   ($1,null,'submitted',$2), ($1,'submitted','client_review',$2),
   ($1,'client_review','interview',$2), ($1,'interview','offer',$2),
   ($1,'offer','placed',$2)`, [sub1.id, dev.id]);
await q(`insert into submission (project_id, contact_id, stage, submitted_by)
         values ($1,$2,'interview',$3) returning *`, [controls.id, jo.id, dev.id]);
await q(`insert into submission (project_id, contact_id, stage, submitted_by)
         values ($1,$2,'client_review',$3) returning *`, [erp.id, tess.id, sam.id]);

const pl = await q(
  `insert into placement (project_id, contact_id, status, start_date, recruiter_id)
   values ($1,$2,'active','2026-06-01',$3) returning *`,
  [dataPlatform.id, marcus.id, dev.id]);
// The original rate, then a correction that supersedes it rather than overwriting.
const r1 = await q(
  `insert into placement_rate (placement_id, pay_rate, bill_rate, burden_pct,
                               effective_from, effective_to)
   values ($1,65,105,22,'2026-06-01','2026-08-01') returning *`, [pl.id]);
await client.query(
  `insert into placement_rate (placement_id, pay_rate, bill_rate, burden_pct,
                               effective_from, supersedes_id)
   values ($1,68,108,22,'2026-08-01',$2)`, [pl.id, r1.id]);

await q(`insert into rate_verification (project_id, contact_id, placement_id, status,
                                        pay_rate, bill_rate, start_date, confirmed_by,
                                        confirmed_at)
         values ($1,$2,$3,'confirmed',68,108,'2026-08-01','Dana Reyes', now()) returning *`,
  [dataPlatform.id, marcus.id, pl.id]);

// -- SOW, PO and timecards ---------------------------------------------------
const sowRow = await q(
  `insert into sow (project_id, title, status, start_date, end_date, total_value, deliverables)
   values ($1,'Plant data platform - phase 1','executed','2026-06-01','2026-12-31',420000,
     'Time and materials against an agreed team. No fixed deliverables in phase 1.')
   returning *`, [dataPlatform.id]);
await client.query(
  `insert into change_order (sow_id, number, status, value_delta, end_date, summary)
   values ($1,1,'executed',60000,'2027-02-28','Added a third engineer through February.')`,
  [sowRow.id]);
const po = await q(
  `insert into purchase_order (project_id, sow_id, po_number, amount, start_date, end_date)
   values ($1,$2,'PO-GLX-88412',180000,'2026-06-01','2026-10-31') returning *`,
  [dataPlatform.id, sowRow.id]);
const po2 = await q(
  `insert into purchase_order (project_id, po_number, amount, start_date, end_date)
   values ($1,'PO-GLX-88500',95000,'2026-08-01','2027-01-31') returning *`,
  [dataPlatform.id]);

// Thirteen weeks of time in three states, then the invoices drawn from them.
// This is the shape that makes the burn-down interesting: some weeks billed,
// some approved and sitting unbilled in our own queue, some still waiting on
// the client to approve.
const cards = [];
let wk = new Date("2026-06-07");
for (let i = 0; i < 13; i++) {
  const d = new Date(wk); d.setDate(wk.getDate() + i * 7);
  const iso = d.toISOString().slice(0, 10);
  // 0-9 approved, 10-12 still submitted and waiting on Globex.
  const approved = i < 10;
  const tc = await q(
    `insert into timecard (placement_id, purchase_order_id, week_ending, hours,
                           status, submitted_at, approved_by, approved_at)
     values ($1,$2,$3,40,$4, now(), $5, $6) returning *`,
    [pl.id, po.id, iso, approved ? "approved" : "submitted",
     approved ? "Dana Reyes" : null, approved ? new Date() : null]);
  cards.push(tc);
}

// Two invoices already issued and one still in draft, so the difference between
// billed, prepared and earned is visible on day one.
async function invoiceFor(number, weeks, status, issued, paidAmount) {
  const inv = await q(
    `insert into invoice (invoice_number, account_id, project_id, purchase_order_id,
                          status, terms_days, period_start, period_end, issue_date,
                          due_date, sent_at)
     values ($1,$2,$3,$4,'draft',45,$5,$6,$7,$8,$9) returning *`,
    [number, globex.id, dataPlatform.id, po.id,
     weeks[0].week_ending, weeks[weeks.length - 1].week_ending,
     issued, issued ? new Date(new Date(issued).getTime() + 45 * 864e5)
       .toISOString().slice(0, 10) : null, issued]);
  let n = 0;
  for (const w of weeks) {
    const rate = Number(w.billable_amount) / 40;
    await client.query(
      `insert into invoice_line (invoice_id, kind, timecard_id, description,
                                 quantity, unit_rate, amount, sort_order)
       values ($1,'time',$2,$3,40,$4,$5,$6)`,
      [inv.id, w.id, `Marcus Bell - week ending ${w.week_ending
        .toISOString().slice(0, 10)}`, rate, w.billable_amount, n++]);
  }
  if (status !== "draft") {
    await client.query(`update invoice set status = $2 where id = $1`, [inv.id, status]);
  }
  if (paidAmount) {
    await client.query(
      `insert into payment (invoice_id, amount, received_at, method, reference)
       values ($1,$2,$3,'ACH',$4)`,
      [inv.id, paidAmount, issued, "GLX-" + number]);
  }
  return inv;
}

await invoiceFor("TS-2026-0411", cards.slice(0, 4), "paid", "2026-07-06",
                 cards.slice(0, 4).reduce((a, c) => a + Number(c.billable_amount), 0));
await invoiceFor("TS-2026-0452", cards.slice(4, 8), "sent", "2026-08-03", null);
// Weeks 9 and 10 are drafted but not issued. Weeks 11-13 are not even approved.
await invoiceFor("TS-2026-0488", cards.slice(8, 10), "draft", null, null);

// -- agreements and documents ------------------------------------------------
await client.query(
  `insert into agreement (account_id, kind, status, effective_from, terms_notes) values
   ($1,'MSA','executed','2024-03-01','Net 45. 90-day conversion at 15% of first year salary.'),
   ($1,'rate_sheet','executed','2026-01-01','Rates hold through 2026.')`, [globex.id]);
await client.query(
  `insert into agreement (account_id, location_id, kind, status, effective_from, terms_notes)
   values ($1,$2,'addendum','executed','2025-07-01',
     'Reno-specific: 60-day notice on any rate change, overrides the master rate sheet.')`,
  [globex.id, reno.id]);
await client.query(
  `insert into document (kind, title, contact_id, content_text, uploaded_by) values
   ('resume','Marcus Bell - resume 2026.docx',$1,
    'Marcus Bell. Senior Data Engineer. Nine years building batch and streaming pipelines
in healthcare and discrete manufacturing. Python, Airflow, dbt, Snowflake, Kafka.
Led the migration of a 200-table warehouse from SQL Server to Snowflake.',$2)`,
  [marcus.id, dev.id]);
await client.query(
  `insert into document (kind, title, account_id, content_text, sharepoint_url) values
   ('MSA','Globex MSA - executed 2024-03-01.pdf',$1,
    'Master Services Agreement between Technical Source and Globex Manufacturing.
Net 45 payment terms. Conversion fee 15% of first year base salary within 90 days.',
    'https://technicalsource.sharepoint.com/Shared%20Documents/MSAs/Globex/MSA.pdf')`,
  [globex.id]);
await client.query(
  `insert into document (kind, title, project_id, content_text) values
   ('exhibit_a','Exhibit A - Marcus Bell - plant data platform.pdf',$1,
    'Rate verification. Marcus Bell. Bill rate 108.00/hr effective 2026-08-01.
Confirmed by Dana Reyes, Globex Manufacturing.')`, [dataPlatform.id]);

// -- activity ----------------------------------------------------------------
// The same human logged twice, wearing a different hat each time.
await client.query(
  `insert into activity (contact_id, account_id, as_role, kind, body, actor_id, occurred_at)
   values ($1,$2,'manager','call',
     'Dana walked through the line 4 controls gap. Wants a body on site before the
October shutdown. Confirmed three-submittal cap still applies.',$3, now() - interval '2 days')`,
  [dana.id, globex.id, rae.id]);
await client.query(
  `insert into activity (contact_id, project_id, as_role, kind, body, actor_id, occurred_at)
   values ($1,$2,'candidate','note',
     'Dana asked to be kept in mind for plant leadership roles outside Globex.
Not active, would move for the right operations director seat.',$3, now() - interval '9 days')`,
  [dana.id, dataPlatform.id, dev.id]);
await client.query(
  `insert into activity (contact_id, project_id, as_role, kind, body, actor_id, occurred_at)
   values ($1,$2,'candidate','interview',
     'Marcus interviewed with the Globex platform team. Strong on Airflow, light on
Snowflake cost tuning. They want him.',$3, now() - interval '75 days')`,
  [marcus.id, dataPlatform.id, dev.id]);
await client.query(
  `insert into activity (contact_id, as_role, kind, body, actor_id, occurred_at)
   values ($1,'candidate','call','Jo is on a contract through October. Available after.
Wants to stay in Reno.',$2, now() - interval '1 day')`, [jo.id, dev.id]);

// -- pipelines ---------------------------------------------------------------
const pipe = await q(
  `insert into pipeline (owner_id, name, notes) values
   ($1,'Reno controls bench','People I can move on short notice in northern Nevada')
   returning *`, [dev.id]);
await client.query(
  `insert into pipeline_member (pipeline_id, contact_id, note) values
   ($1,$2,'Free after October'), ($1,$3,'On payroll, redeployable in December')`,
  [pipe.id, jo.id, marcus.id]);

await client.query(
  `insert into domain_event (kind, subject_type, subject_id, payload)
   values ('workspace.seeded','account',$1,'{"note":"demo data"}')`, [globex.id]);

const counts = await client.query(`
  select 'accounts' t, count(*)::int n from account
  union all select 'locations', count(*) from location
  union all select 'contacts', count(*) from contact
  union all select 'projects', count(*) from project
  union all select 'documents', count(*) from document
  union all select 'timecards', count(*) from timecard
  order by 1`);
console.table(counts.rows);
await client.end();
