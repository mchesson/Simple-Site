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
// Mark everything this script writes, so seeded rows are distinguishable from
// real ones in the audit trail rather than showing as unattributed.
await client.query(
  `select set_config('ts.actor_label','seed script',false),
          set_config('ts.reason','demo data',false)`);

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

const ben = await q(
  `insert into contact (full_name, email, is_candidate, headline, skills, location_text,
                        recruiter_id)
   values ('Ben Osei','ben.osei@example.com',true,
     'Programme manager, finance transformation','{"ERP","Finance","PMO"}','Remote',$1)
   returning *`, [sam.id]);
const nia = await q(
  `insert into contact (full_name, email, is_candidate, headline, skills, location_text,
                        recruiter_id, source)
   values ('Nia Fenwick','nia.f@example.com',true,'Controls technician, day shift only',
     '{"PLC","Allen-Bradley","Maintenance"}','Sparks, NV',$1,'Referral') returning *`,
  [dev.id]);

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
//
// Submissions are walked through the stage machine rather than dropped in at
// their final stage, because the machine will not have it any other way: a
// submission starts at submitted and every move writes its own history row.
// The upside is that the demo data has a truthful history instead of a
// hand-written one that says whatever the seed felt like saying.

const move = async (subId, stage, actorId, reason = null, lossCode = null) => {
  await client.query(
    `select set_config('ts.actor_id',$1,false), set_config('ts.reason',$2,false)`,
    [actorId || "", reason || "demo data"]);
  await client.query(
    `update submission set stage = $2, loss_reason_code = coalesce($3, loss_reason_code)
      where id = $1`, [subId, stage, lossCode]);
};
const walk = async (subId, stages, actorId, reason = null, lossCode = null) => {
  for (const st of stages) await move(subId, st, actorId, reason, lossCode);
};

const submit = (projectId, contactId, actorId, pay, bill, burden = 22, notes = null) => q(
  `insert into submission (project_id, contact_id, submitted_by, pay_rate, bill_rate,
                           burden_pct, notes)
   values ($1,$2,$3,$4,$5,$6,$7) returning *`,
  [projectId, contactId, actorId, pay, bill, burden, notes]);

// Marcus: the one that went all the way. Placed, on payroll, being invoiced.
const sub1 = await submit(dataPlatform.id, marcus.id, dev.id, 68, 108, 22,
  "Ran the historian migration at his last two sites.");
await walk(sub1.id, ["client_review", "interview", "offer"], dev.id);

const pl = await q(
  `insert into placement (project_id, contact_id, submission_id, status, start_date,
                          recruiter_id)
   values ($1,$2,$3,'active','2026-06-01',$4) returning *`,
  [dataPlatform.id, marcus.id, sub1.id, dev.id]);
// Only now may the submission say "placed" - the guard checks the placement is real.
await move(sub1.id, "placed", dev.id);

// The original rate, then a correction that supersedes it rather than overwriting.
const r1 = await q(
  `insert into placement_rate (placement_id, pay_rate, bill_rate, burden_pct,
                               effective_from, effective_to)
   values ($1,65,105,22,'2026-06-01','2026-08-01') returning *`, [pl.id]);
await client.query(
  `insert into placement_rate (placement_id, pay_rate, bill_rate, burden_pct,
                               effective_from, supersedes_id)
   values ($1,68,108,22,'2026-08-01',$2)`, [pl.id, r1.id]);

// Jo: interviewed on site eleven days ago and nobody has chased the feedback.
const sub2 = await submit(controls.id, jo.id, dev.id, 56, 90, 22,
  "Strong on Allen-Bradley. Free from the second week of September.");
await walk(sub2.id, ["client_review"], dev.id);
await q(
  `insert into interview (submission_id, scheduled_at, duration_mins, mode, where_text,
                          interviewers, prep_notes, arranged_by)
   values ($1, now() - interval '11 days', 90, 'onsite',
     'Reno plant, gate 2 - ask for the controls office',
     'Dana Reyes (engineering manager), Priya Shah (controls lead)',
     'They will ask about the line 3 outage. Walk them through the rollback.',
     $2) returning *`, [sub2.id, dev.id]);

// Tess: offer out on the ERP programme, waiting on the client's paperwork.
const sub3 = await submit(erp.id, tess.id, sam.id, null, 140, 0,
  "Ran the same cutover at a manufacturer of similar size.");
await walk(sub3.id, ["client_review", "interview"], sam.id);
await q(
  `insert into interview (submission_id, scheduled_at, duration_mins, mode, interviewers,
                          status, outcome, feedback, arranged_by)
   values ($1, now() - interval '9 days', 60, 'video', 'Walter Kang (programme director)',
     'completed', 'advance',
     'Walter wants her. Asked us to hold the rate while finance signs the requisition.',
     $2) returning *`, [sub3.id, sam.id]);
await move(sub3.id, "offer", sam.id, "Walter confirmed verbally, requisition in finance");

// Walter's finance director wants one more conversation before signing, so
// there is a second round booked while the offer is still out. Booking it does
// not drag her stage backwards - the trigger only ever moves a stage forward.
await q(
  `insert into interview (submission_id, round, scheduled_at, duration_mins, mode,
                          interviewers, prep_notes, arranged_by)
   values ($1, 2, date_trunc('hour', now() + interval '3 days') + interval '9 hours',
     30, 'video', 'Renata Cole (finance director)',
     'Half an hour on the programme budget. She signs the requisition.', $2) returning *`,
  [sub3.id, sam.id]);

// Ben: lost on rate. This is the row the loss breakdown is built from.
const sub4 = await submit(erp.id, ben.id, sam.id, null, 155, 0,
  "Stronger on finance transformation, lighter on change management.");
await walk(sub4.id, ["client_review"], sam.id);
await move(sub4.id, "rejected", sam.id,
  "Walter said 155 was 20 dollars over what finance would sign off", "rate_too_high");

// Nia: just gone out this morning, nothing has happened yet.
await submit(controls.id, nia.id, dev.id, 52, 86, 22,
  "Day shift only. Wants to be close to home.");

// Age the demo data. The stage machine stamps every move with the time it
// happened, which is right, and it means a freshly seeded database has a
// pipeline where nothing has been waiting for anything - so the screens that
// exist to show you what has gone stale have nothing to show.
//
// This is the one place in the system that steps around a guard, it does it by
// switching the triggers off in the open rather than by finding a gap in them,
// and it puts them straight back. Nothing outside this script may do this: the
// grants do not allow it, and the whole point of the guard is that a normal
// caller cannot move a clock.
const backdate = async (subId, createdDaysAgo, stageDaysAgo) => {
  await client.query(
    `update submission
        set created_at  = now() - ($2::int * interval '1 day'),
            stage_since = now() - ($3::int * interval '1 day'),
            updated_at  = now() - ($3::int * interval '1 day')
      where id = $1`, [subId, createdDaysAgo, stageDaysAgo]);
  // Spread the history rows across the life of the submission, in order, so the
  // story reads as something that happened over weeks rather than in one second.
  await client.query(
    `with ordered as (
       select id, row_number() over (order by id) - 1 as n,
              count(*) over () as total
         from submission_event where submission_id = $1)
     update submission_event e
        set occurred_at = now() - (($2::numeric -
              (($2::numeric - $3::numeric) * o.n / greatest(o.total - 1, 1)))
              * interval '1 day')
       from ordered o where o.id = e.id`,
    [subId, createdDaysAgo, stageDaysAgo]);
};

await client.query(`alter table submission disable trigger submission_stage_check;
                    alter table submission_event disable trigger submission_event_no_edit;`);
await backdate(sub1.id, 80, 74);   // Marcus, placed and working since June
await backdate(sub2.id, 17, 11);   // Jo, interviewed 11 days ago, no feedback chased
await backdate(sub3.id, 20, 6);    // Tess, offer out for nearly a week
await backdate(sub4.id, 32, 30);   // Ben, lost a month ago
await client.query(`alter table submission enable trigger submission_stage_check;
                    alter table submission_event enable trigger submission_event_no_edit;`);

await q(`insert into rate_verification (project_id, contact_id, placement_id, status,
                                        pay_rate, bill_rate, start_date, confirmed_by,
                                        confirmed_at)
         values ($1,$2,$3,'confirmed',68,108,'2026-08-01','Dana Reyes', now()) returning *`,
  [dataPlatform.id, marcus.id, pl.id]);

// -- SOW, PO and time --------------------------------------------------------
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

// Marcus is on two Globex projects at once, so his weeks split. Priya approves
// the Reno side and Dana the Austin side, which is what makes one week able to
// be half approved.
const controlsPlacement = await q(
  `insert into placement (project_id, contact_id, status, start_date, recruiter_id)
   values ($1,$2,'active','2026-07-06',$3) returning *`,
  [controls.id, marcus.id, dev.id]);
await client.query(
  `insert into placement_rate (placement_id, pay_rate, bill_rate, burden_pct, effective_from)
   values ($1,55,90,22,'2026-07-06')`, [controlsPlacement.id]);
const controlsPo = await q(
  `insert into purchase_order (project_id, po_number, amount, start_date, end_date)
   values ($1,'PO-GLX-90114',60000,'2026-07-06','2026-11-30') returning *`, [controls.id]);

await client.query(
  `insert into project_approver (project_id, contact_id, is_primary) values
   ($1,$2,true), ($3,$4,true), ($5,$2,true)`,
  [dataPlatform.id, dana.id, controls.id, priya.id, erp.id]);

// Twelve weeks of history, then a live week in each state so every screen has
// something real in it.
function weekEnding(offsetWeeks) {
  const d = new Date("2026-08-30");
  d.setDate(d.getDate() - offsetWeeks * 7);
  return d;
}
const iso = (d) => d.toISOString().slice(0, 10);

async function week(offset, plan) {
  const we = weekEnding(offset);
  const ts = await q(
    `insert into timesheet (contact_id, week_ending, status) values ($1,$2,'draft')
     returning *`, [marcus.id, iso(we)]);
  for (const [dayOffset, alloc] of plan.entries()) {
    const day = new Date(we); day.setDate(we.getDate() - 6 + dayOffset);
    for (const a of alloc) {
      if (!a.hours) continue;
      await client.query(
        `insert into timesheet_entry (timesheet_id, placement_id, project_id,
                                      purchase_order_id, work_date, hours)
         values ($1,$2,$3,$4,$5,$6)`,
        [ts.id, a.placement, a.project, a.po, iso(day), a.hours]);
    }
  }
  return ts;
}

const platform = { placement: pl.id, project: dataPlatform.id, po: po.id };
const line4 = { placement: controlsPlacement.id, project: controls.id, po: controlsPo.id };
// Index 0 is Monday, index 6 is Sunday.
const straight = [[{ ...platform, hours: 8 }], [{ ...platform, hours: 8 }],
  [{ ...platform, hours: 8 }], [{ ...platform, hours: 8 }],
  [{ ...platform, hours: 8 }], [], []];
// A split week: Tuesday is shared and Wednesday goes entirely to line 4.
const split = [[{ ...platform, hours: 8 }],
  [{ ...platform, hours: 5 }, { ...line4, hours: 3 }],
  [{ ...line4, hours: 8 }], [{ ...platform, hours: 8 }],
  [{ ...platform, hours: 6 }], [], []];

async function submitAndDecide(ts, decisions) {
  await client.query(
    `update timesheet set status='submitted', submitted_at=now() where id=$1`, [ts.id]);
  const projects = await client.query(
    `select distinct project_id from timesheet_entry where timesheet_id=$1`, [ts.id]);
  for (const row of projects.rows) {
    const approver = await q(
      `select contact_id from project_approver where project_id=$1
        order by is_primary desc limit 1`, [row.project_id]);
    const ap = await q(
      `insert into timesheet_approval (timesheet_id, project_id, approver_contact_id)
       values ($1,$2,$3) returning *`, [ts.id, row.project_id, approver.contact_id]);
    const d = decisions[row.project_id];
    if (d) {
      await client.query(
        `update timesheet_approval set status=$2, decided_at=now(), decided_by=$3, note=$4
          where id=$1`, [ap.id, d.status, d.by, d.note ?? null]);
    }
  }
}

const approvedWeeks = [];
for (let i = 12; i >= 3; i--) {
  // Marcus only joins line 4 in July, so only the later weeks split.
  const ts = await week(i, i % 4 === 2 && i <= 6 ? split : straight);
  await submitAndDecide(ts, {
    [dataPlatform.id]: { status: "approved", by: "Dana Reyes" },
    [controls.id]: { status: "approved", by: "Priya Raman" },
  });
  approvedWeeks.push(ts);
}

// Two weeks ago: Dana has signed off, Priya has not. Half the week is earned.
const halfWeek = await week(2, split);
await submitAndDecide(halfWeek, {
  [dataPlatform.id]: { status: "approved", by: "Dana Reyes" },
});
// Last week: submitted, nobody has looked at it.
await week(1, straight).then((ts) => submitAndDecide(ts, {}));
// This week: still being filled in.
await week(0, [[{ ...platform, hours: 8 }], [{ ...platform, hours: 8 }], [], [], [], [], []]);

// Two invoices already issued and one still in draft, so the difference between
// billed, prepared and earned is visible on day one.
async function invoiceFor(number, poId, projectId, entryIds, status, issued, paidAmount) {
  const inv = await q(
    `insert into invoice (invoice_number, account_id, project_id, purchase_order_id,
                          status, terms_days, issue_date, due_date, sent_at)
     values ($1,$2,$3,$4,'draft',45,$5,$6,$7) returning *`,
    [number, globex.id, projectId, poId, issued,
     issued ? iso(new Date(new Date(issued).getTime() + 45 * 864e5)) : null, issued]);
  let n = 0;
  for (const e of entryIds) {
    const hours = Number(e.hours) + Number(e.ot_hours);
    await client.query(
      `insert into invoice_line (invoice_id, kind, timesheet_entry_id, description,
                                 quantity, unit_rate, amount, sort_order)
       values ($1,'time',$2,$3,$4,$5,$6,$7)`,
      [inv.id, e.entry_id,
       `${e.consultant} - ${iso(e.work_date)}${e.po_number ? " (" + e.po_number + ")" : ""}`,
       hours, hours ? Number(e.value) / hours : null, e.value, n++]);
  }
  if (status !== "draft") {
    await client.query(`update invoice set status = $2 where id = $1`, [inv.id, status]);
  }
  if (paidAmount) {
    await client.query(
      `insert into payment (invoice_id, amount, received_at, method, reference)
       values ($1,$2,$3,'ACH',$4)`, [inv.id, paidAmount, issued, "GLX-" + number]);
  }
  return inv;
}

const billable = await client.query(
  `select * from timesheet_entry_detail
    where approval_status = 'approved' and purchase_order_id = $1
    order by work_date`, [po.id]);
const rowsA = billable.rows;
const third = Math.floor(rowsA.length / 3);
await invoiceFor("TS-2026-0411", po.id, dataPlatform.id, rowsA.slice(0, third),
                 "paid", "2026-07-06",
                 rowsA.slice(0, third).reduce((a, e) => a + Number(e.value), 0));
await invoiceFor("TS-2026-0452", po.id, dataPlatform.id, rowsA.slice(third, third * 2),
                 "sent", "2026-08-03", null);
await invoiceFor("TS-2026-0488", po.id, dataPlatform.id,
                 rowsA.slice(third * 2, third * 2 + 2), "draft", null, null);

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

// -- the bench ---------------------------------------------------------------
// On our payroll and not out working. Every day here costs us and earns nothing,
// so putting him against a project is the cheapest seat the desk will fill.
const owen = await q(
  `insert into contact (full_name, email, phone, is_candidate, headline, skills,
                        location_text, on_payroll, recruiter_id, source)
   values ('Owen Marsh','o.marsh@example.com','775-555-0132',true,
     'Controls engineer, 11 years, food and beverage',
     '{"PLC","Allen-Bradley","Ignition","SCADA"}','Reno, NV',true,$1,'Redeployment')
   returning *`, [dev.id]);
const owenPl = await q(
  `insert into placement (project_id, contact_id, status, start_date, end_date,
                          recruiter_id)
   values ($1,$2,'ended','2026-02-02', current_date - 21, $3) returning *`,
  [controls.id, owen.id, dev.id]);
await client.query(
  `insert into placement_rate (placement_id, pay_rate, bill_rate, burden_pct,
                               effective_from, effective_to)
   values ($1,58,94,22,'2026-02-02', current_date - 21)`, [owenPl.id]);

// -- pipelines ---------------------------------------------------------------
//
// A pipeline is a recruiter's own named category, not the submission board. It
// holds resources they know are good and who are not out working, grouped
// however that person thinks about the work.
const pipe = await q(
  `insert into pipeline (owner_id, name, notes) values
   ($1,'Reno controls bench','People I can move on short notice in northern Nevada')
   returning *`, [dev.id]);
await client.query(
  `insert into pipeline_member (pipeline_id, contact_id, note) values
   ($1,$2,'Free after October'), ($1,$3,'On payroll, redeployable in December'),
   ($1,$4,'Came off line 4 in good standing. Ready now.')`,
  [pipe.id, jo.id, marcus.id, owen.id]);

await client.query(
  `insert into domain_event (kind, subject_type, subject_id, payload)
   values ('workspace.seeded','account',$1,'{"note":"demo data"}')`, [globex.id]);

const counts = await client.query(`
  select 'accounts' t, count(*)::int n from account
  union all select 'locations', count(*) from location
  union all select 'contacts', count(*) from contact
  union all select 'projects', count(*) from project
  union all select 'documents', count(*) from document
  union all select 'timesheets', count(*) from timesheet
  union all select 'time entries', count(*) from timesheet_entry
  union all select 'invoices', count(*) from invoice
  order by 1`);
console.table(counts.rows);
await client.end();
