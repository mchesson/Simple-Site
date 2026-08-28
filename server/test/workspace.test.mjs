// Integration tests. These run against a real Postgres database built from the
// same schema the application uses - a mock would not catch the constraints,
// which are where most of the design lives.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { resetTestDatabase, scriptedClient, textBlock, toolBlock } from "./helpers.mjs";

resetTestDatabase();

const { pool, readOnlyPool, rows, one, close } = await import("../src/db.js");
const { withContext } = await import("../src/context.js");
const repo = await import("../src/repo.js");
const { buildTools, runReadOnlySql, describeSchema } = await import("../src/tools.js");
const agent = await import("../src/agent.js");
const trace = await import("../src/trace.js");

let mark, rae, dev, globex, austin, reno, dana, marcus, project;

before(async () => {
  await pool.query(`truncate app_user, account, account_owner, location, contact, project,
    project_approver, submission, submission_event, placement, placement_rate, agreement,
    rate_verification, sow, change_order, purchase_order, timesheet, timesheet_entry,
    timesheet_approval, unlock_request, invoice, invoice_line, payment, document,
    activity, pipeline, pipeline_member, domain_event, conversation, chat_message, trace
    restart identity cascade`);
  // audit_log is append-only and refuses DELETE, so it is emptied directly.
  await pool.query(`alter table audit_log disable trigger audit_no_update`);
  await pool.query(`delete from audit_log`);
  await pool.query(`alter table audit_log enable trigger audit_no_update`);

  mark = await one(`insert into app_user (email, full_name, role)
    values ('mark@ts.com','Mark Chesson','admin') returning *`);
  rae = await one(`insert into app_user (email, full_name, role)
    values ('rae@ts.com','Rae Lambert','account_manager') returning *`);
  dev = await one(`insert into app_user (email, full_name, role)
    values ('dev@ts.com','Devon Okafor','recruiter') returning *`);

  globex = await repo.insertRecord("account", {
    name: "Globex Manufacturing", status: "active",
    bg_check_policy: "7-year county and federal.",
  }, mark.id);
  await repo.insertRecord("account", { name: "Hooli Health" }, mark.id);

  austin = await repo.insertRecord("location", {
    account_id: globex.id, name: "Globex Austin", city: "Austin", state: "TX",
    rules_of_engagement: "All reqs route through the plant manager.",
  }, mark.id);
  reno = await repo.insertRecord("location", {
    account_id: globex.id, name: "Globex Reno", city: "Reno", state: "NV",
    bg_check_notes: "Reno adds a respirator fit test.",
  }, mark.id);

  await repo.setAccountOwners(globex.id,
    [{ user_id: rae.id, role: "account_manager", split_pct: 60 },
     { user_id: dev.id, role: "recruiter", split_pct: 40 }], mark.id);

  dana = await repo.insertRecord("contact", {
    full_name: "Dana Reyes", email: "dana@globex.com", title: "Plant Engineering Manager",
    is_manager: true, is_candidate: true, account_id: globex.id, location_id: austin.id,
  }, mark.id);
  marcus = await repo.insertRecord("contact", {
    full_name: "Marcus Bell", email: "marcus@example.com", is_candidate: true,
    skills: ["Python", "Airflow", "Snowflake"], on_payroll: true, recruiter_id: dev.id,
  }, dev.id);

  project = await repo.insertRecord("project", {
    account_id: globex.id, location_id: austin.id, name: "Plant data platform",
    delivery_type: "managed_project", openings: 3, owner_id: mark.id,
  }, mark.id);
});

after(async () => { await close(); });

// ---------------------------------------------------------------- the schema

describe("the database refuses states the business does not allow", () => {
  test("a project cannot use a location belonging to another account", async () => {
    const other = await repo.insertRecord("account", { name: "Initech" }, mark.id);
    await assert.rejects(
      () => repo.insertRecord("project",
        { account_id: other.id, location_id: austin.id, name: "Wrong site" }, mark.id),
      /does not belong to account/);
  });

  test("a manager must sit on an account", async () => {
    await assert.rejects(
      () => repo.insertRecord("contact", { full_name: "Nobody", is_manager: true }, mark.id),
      /manager_needs_account/);
  });

  test("a contact must be a manager, a candidate, or both", async () => {
    await assert.rejects(
      () => repo.insertRecord("contact", { full_name: "Ghost" }, mark.id),
      /has_a_role/);
  });

  test("a document belongs to exactly one thing", async () => {
    await assert.rejects(
      () => repo.insertRecord("document",
        { kind: "resume", title: "Bad", account_id: globex.id, contact_id: dana.id }, mark.id),
      /exactly_one_scope/);
  });

  test("two rates of the same type cannot overlap in time", async () => {
    const pl = await repo.insertRecord("placement",
      { project_id: project.id, contact_id: marcus.id, start_date: "2026-01-05" }, mark.id);
    await pool.query(
      `insert into placement_rate (placement_id, pay_rate, bill_rate, burden_pct,
         effective_from, effective_to) values ($1,60,95,22,'2026-01-05','2026-07-01')`,
      [pl.id]);
    await assert.rejects(
      () => pool.query(
        `insert into placement_rate (placement_id, pay_rate, bill_rate, burden_pct,
           effective_from) values ($1,65,100,22,'2026-06-01')`, [pl.id]),
      /no_overlapping_rates/);
    // The correct successor, starting where the first one ends, is accepted.
    await pool.query(
      `insert into placement_rate (placement_id, pay_rate, bill_rate, burden_pct,
         effective_from) values ($1,65,100,22,'2026-07-01')`, [pl.id]);
    const rs = await rows(`select * from placement_rate where placement_id = $1`, [pl.id]);
    assert.equal(rs.length, 2);
  });

  test("burden is charged against pay, not against bill", async () => {
    const r = await one(
      `select gross_margin(60,95,22) as gm, round(gross_margin_pct(60,95,22),2) as pct`);
    // 95 - 60 - (60 * 0.22) = 21.80, not the 35.00 that a naive spread would show.
    assert.equal(Number(r.gm), 21.8);
    assert.equal(Number(r.pct), 22.95);
  });
});

// ------------------------------------------------------------- non-destructive

describe("changing data never destroys it", () => {
  test("an update keeps the previous version and says what changed", async () => {
    const r = await repo.updateRecord("contact", marcus.id,
      { headline: "Senior data engineer", skills: ["Python", "Airflow", "dbt"] }, dev.id);
    assert.deepEqual(r.changed.sort(), ["headline", "skills"]);
    assert.equal(r.before.headline, null);
    assert.equal(r.after.headline, "Senior data engineer");

    const history = await repo.revisionsFor("contact", marcus.id);
    assert.ok(history.length >= 2, "the insert and the update are both recorded");
    assert.equal(history[0].action, "update");
    assert.equal(history[0].before.headline, null);
    assert.equal(history[0].after.headline, "Senior data engineer");
    assert.ok(history.some((h) => h.action === "insert"));
  });

  test("archiving hides a record without removing the row", async () => {
    const doomed = await repo.insertRecord("account", { name: "Temporary Co" }, mark.id);
    await repo.archiveRecord("account", doomed.id, mark.id);
    const visible = await repo.listAccounts({ q: "Temporary" });
    assert.equal(visible.length, 0);
    const still = await one(`select id, archived_at from account where id=$1`, [doomed.id]);
    assert.ok(still && still.archived_at, "the row is still there, just stamped");
  });

  test("every write leaves an event tied to the turn that caused it", async () => {
    const events = await repo.recentEvents(50);
    assert.ok(events.some((e) => e.kind === "contact.updated"));
    assert.ok(events.some((e) => e.kind === "account.archived"));
  });
});

// ---------------------------------------------------------------- the model

describe("one person, two hats", () => {
  test("a note tied to a project is logged candidate-side", async () => {
    const a = await repo.logActivity({
      contactId: dana.id, projectId: project.id,
      body: "Would move for the right operations seat.", actorId: dev.id });
    assert.equal(a.as_role, "candidate");
  });

  test("a note about her employer is logged manager-side", async () => {
    const a = await repo.logActivity({
      contactId: dana.id, accountId: globex.id,
      body: "Wants a controls engineer before the shutdown.", actorId: rae.id });
    assert.equal(a.as_role, "manager");
    assert.equal(a.account_id, globex.id);
  });

  test("both notes hang off the same person", async () => {
    const c = await repo.getContact(dana.id);
    const roles = c.activity.map((x) => x.as_role).sort();
    assert.deepEqual(roles, ["candidate", "manager"]);
    assert.equal(c.is_manager, true);
    assert.equal(c.is_candidate, true);
  });

  test("creating someone who already exists adds the hat instead of a second record", async () => {
    const tools = buildTools({ userId: dev.id });
    const create = tools.find((t) => t.name === "create_contact");
    const out = await create.run({
      full_name: "Marcus Bell", email: "marcus@example.com",
      is_manager: true, account_name: "Globex Manufacturing" });
    assert.equal(out.merged_into_existing, true);
    assert.equal(out.contact.id, marcus.id);
    assert.equal(out.contact.is_manager, true);
    assert.equal(out.contact.is_candidate, true);
    const dupes = await rows(
      `select count(*)::int n from contact where lower(email)='marcus@example.com'`);
    assert.equal(dupes[0].n, 1);
  });
});

describe("accounts, sites and ownership", () => {
  test("an account carries several owners with splits", async () => {
    const a = await repo.getAccount(globex.id);
    assert.equal(a.owners.length, 2);
    assert.equal(a.owners.find((o) => o.full_name === "Rae Lambert").split_pct, 60);
  });

  test("an owner has to be a workspace user", async () => {
    await assert.rejects(
      () => repo.setAccountOwners(globex.id,
        [{ user_id: "00000000-0000-0000-0000-000000000000" }], mark.id),
      /not workspace users/);
  });

  test("account screening flows down to a site, and site notes add to it", async () => {
    const l = await repo.getLocation(reno.id);
    assert.equal(l.inherited_bg_check, "7-year county and federal.");
    assert.equal(l.bg_check_notes, "Reno adds a respirator fit test.");
  });

  test("a site shows only its own contacts, the account shows all of them", async () => {
    const site = await repo.getLocation(austin.id);
    const account = await repo.getAccount(globex.id);
    assert.equal(site.contacts.length, 1);
    assert.ok(account.contacts.length >= 1);
    assert.ok(account.contacts.some((c) => c.full_name === "Dana Reyes"));
  });

  test("unassigned accounts are the ones with no owner at all", async () => {
    const un = await repo.listAccounts({ unassigned: true });
    assert.ok(un.some((a) => a.name === "Hooli Health"));
    assert.ok(!un.some((a) => a.name === "Globex Manufacturing"));
  });

  test("my accounts means accounts I actually own", async () => {
    const mine = await repo.listAccounts({ ownerId: rae.id });
    assert.deepEqual(mine.map((a) => a.name), ["Globex Manufacturing"]);
  });
});

// ------------------------------------------------------- timesheets & money

// -------------------------------------------------------- the pipeline

describe("a submission can only move the way the machine allows", () => {
  let jo, sub;

  before(async () => {
    jo = await repo.insertRecord("contact", {
      full_name: "Jo Nakamura", email: "jo@example.com", is_candidate: true,
      skills: ["PLC", "SCADA"], recruiter_id: dev.id,
    }, dev.id);
    sub = await repo.submitCandidate({
      projectId: project.id, contactId: jo.id,
      payRate: 56, billRate: 90, burdenPct: 22,
    }, dev.id);
  });

  test("submitting works out the margin before anybody commits to the rate", () => {
    // 90 bill, 56 pay, burden 22% of pay = 12.32. 90 - 56 - 12.32 = 21.68.
    assert.equal(Number(sub.gm), 21.68);
    assert.ok(Math.abs(Number(sub.gm_pct) - 24.09) < 0.01);
  });

  test("a thin margin is flagged back rather than silently accepted", async () => {
    const thin = await repo.submitCandidate({
      projectId: project.id, contactId: dana.id,
      payRate: 80, billRate: 90, burdenPct: 22,
    }, dev.id);
    assert.ok(thin.advisories.some((a) => a.includes("gross margin")),
      `expected a margin advisory, got ${JSON.stringify(thin.advisories)}`);
    // Advisory, not a refusal: the row exists.
    assert.ok(thin.id);
  });

  test("it starts at submitted and writes its own first history row", async () => {
    const h = await repo.submissionHistory(sub.id);
    assert.equal(h.stage, "submitted");
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].from_stage, null);
    assert.equal(h.events[0].to_stage, "submitted");
  });

  test("a submission cannot be created part way down the funnel", async () => {
    await assert.rejects(
      () => pool.query(
        `insert into submission (project_id, contact_id, stage) values ($1,$2,'offer')`,
        [project.id, marcus.id]),
      /starts at submitted/);
  });

  test("skipping to placed is refused, and the error says what is allowed", async () => {
    await assert.rejects(
      () => repo.advanceSubmission(sub.id, "placed", "client said yes", {}, dev.id),
      (e) => /cannot go to placed/.test(e.message) &&
             /client_review/.test(e.message));
  });

  test("the same refusal applies to SQL written straight at the table", async () => {
    await assert.rejects(
      () => pool.query(`update submission set stage='placed' where id=$1`, [sub.id]),
      /cannot go to placed/);
  });

  test("a move that needs a reason is refused without one", async () => {
    await assert.rejects(
      () => repo.advanceSubmission(sub.id, "withdrawn", null,
        { lossReasonCode: "unresponsive" }, dev.id),
      /needs a reason/);
  });

  test("a loss is refused without a coded reason, however well explained", async () => {
    await assert.rejects(
      () => repo.advanceSubmission(sub.id, "rejected",
        "the client said she was not right for it", {}, dev.id),
      /say why we lost this one/);
  });

  test("the legal path forward moves the clock and records who and why", async () => {
    await repo.advanceSubmission(sub.id, "client_review",
      "sent to Dana with the line 3 write-up", {}, dev.id);
    const h = await repo.submissionHistory(sub.id);
    assert.equal(h.stage, "client_review");
    assert.equal(h.days_in_stage, 0);
    const last = h.events.at(-1);
    assert.equal(last.from_stage, "submitted");
    assert.equal(last.reason, "sent to Dana with the line 3 write-up");
    assert.equal(last.actor_name, "Devon Okafor");
  });

  test("the history cannot be rewritten afterwards", async () => {
    await assert.rejects(
      () => pool.query(`update submission_event set reason='something else'
                         where submission_id=$1`, [sub.id]),
      /history cannot be changed/);
    await assert.rejects(
      () => pool.query(`delete from submission_event where submission_id=$1`, [sub.id]),
      /history cannot be changed/);
  });

  test("what a submission can do next comes from the database, not the screen", async () => {
    const moves = await repo.movesFor(sub.id);
    const codes = moves.map((m) => m.to_stage).sort();
    assert.deepEqual(codes, ["interview", "offer", "rejected", "withdrawn"]);
    const rejected = moves.find((m) => m.to_stage === "rejected");
    assert.equal(rejected.needs_reason, true);
    assert.equal(rejected.needs_loss_reason, true);
    const interview = moves.find((m) => m.to_stage === "interview");
    assert.equal(interview.needs_loss_reason, false);
  });
});

describe("interviews are a date and an outcome, not a word", () => {
  let sub, iv;

  before(async () => {
    const ravi = await repo.insertRecord("contact", {
      full_name: "Ravi Menon", email: "ravi@example.com", is_candidate: true,
    }, dev.id);
    sub = await repo.submitCandidate({
      projectId: project.id, contactId: ravi.id, payRate: 62, billRate: 100, burdenPct: 22,
    }, dev.id);
    iv = await repo.scheduleInterview({
      submissionId: sub.id, scheduledAt: "2026-09-04T16:00:00-05:00",
      mode: "panel", interviewers: "Dana Reyes, Priya Raman", durationMins: 45,
    }, dev.id);
  });

  test("booking one carries the submission into the interview stage by itself", async () => {
    const h = await repo.submissionHistory(sub.id);
    assert.equal(h.stage, "interview");
    // submitted, then the move the booking caused
    assert.deepEqual(h.events.map((e) => e.to_stage), ["submitted", "interview"]);
  });

  test("rounds number themselves", async () => {
    const second = await repo.scheduleInterview({
      submissionId: sub.id, scheduledAt: "2026-09-11T16:00:00-05:00", mode: "video",
    }, dev.id);
    assert.equal(iv.round, 1);
    assert.equal(second.round, 2);
  });

  test("a second round does not drag the stage backwards", async () => {
    await repo.advanceSubmission(sub.id, "offer", null, {}, dev.id);
    await repo.scheduleInterview({
      submissionId: sub.id, scheduledAt: "2026-09-18T16:00:00-05:00", mode: "phone",
    }, dev.id);
    const after = await one(`select stage from submission where id=$1`, [sub.id]);
    assert.equal(after.stage, "offer");
  });

  test("recording an outcome hands back the decision instead of taking it", async () => {
    const out = await repo.recordInterviewOutcome(iv.id,
      { outcome: "reject", feedback: "Not deep enough on Ignition." }, dev.id);
    assert.equal(out.interview.outcome, "reject");
    // The submission has not moved: a rejection needs a coded reason from a person.
    const still = await one(`select stage from submission where id=$1`, [sub.id]);
    assert.equal(still.stage, "offer");
    assert.ok(out.next_moves.some((m) => m.to_stage === "rejected"));
  });

  test("an interview that has been and gone with no outcome is surfaced", async () => {
    await pool.query(`alter table submission disable trigger submission_stage_check`);
    const past = await repo.scheduleInterview({
      submissionId: sub.id, scheduledAt: "2026-08-01T16:00:00-05:00", mode: "phone",
    }, dev.id);
    await pool.query(`alter table submission enable trigger submission_stage_check`);
    const waiting = await repo.interviewsAwaitingFeedback({});
    assert.ok(waiting.some((w) => w.id === past.id),
      "an interview in the past with a pending outcome should be chased");
  });

  test("nothing can be booked onto a closed submission", async () => {
    const gone = await repo.submitCandidate({
      projectId: project.id, contactId: marcus.id }, dev.id);
    await repo.advanceSubmission(gone.id, "withdrawn", "took another offer",
      { lossReasonCode: "took_other_offer" }, dev.id);
    await assert.rejects(
      () => repo.scheduleInterview({
        submissionId: gone.id, scheduledAt: "2026-09-30T16:00:00-05:00" }, dev.id),
      /closed/);
  });
});

describe("placed is a placement, not a word", () => {
  let sub;

  before(async () => {
    const nia = await repo.insertRecord("contact", {
      full_name: "Nia Fenwick", email: "nia@example.com", is_candidate: true,
    }, dev.id);
    sub = await repo.submitCandidate({
      projectId: project.id, contactId: nia.id, payRate: 52, billRate: 86, burdenPct: 22,
    }, dev.id);
    await repo.advanceSubmission(sub.id, "client_review", null, {}, dev.id);
    await repo.advanceSubmission(sub.id, "offer", "client skipped the interview", {}, dev.id);
  });

  test("the stage cannot claim placed until a placement exists", async () => {
    await assert.rejects(
      () => pool.query(`update submission set stage='placed' where id=$1`, [sub.id]),
      /create the placement first/);
  });

  test("a placement naming the wrong person is refused", async () => {
    await assert.rejects(
      () => pool.query(
        `insert into placement (project_id, contact_id, start_date, submission_id)
         values ($1,$2,'2026-09-21',$3)`, [project.id, marcus.id, sub.id]),
      /does not match its submission/);
  });

  test("placing one writes the placement, its opening rate and the stage together",
    async () => {
      const out = await repo.placeSubmission({
        submissionId: sub.id, startDate: "2026-09-21",
      }, dev.id);
      assert.equal(out.submission.stage, "placed");
      assert.equal(out.placement.submission_id, sub.id);
      const rate = await one(
        `select pay_rate, bill_rate, burden_pct, effective_from
           from placement_rate where placement_id = $1`, [out.placement.id]);
      // The rates default to the ones the submission was made at.
      assert.equal(Number(rate.pay_rate), 52);
      assert.equal(Number(rate.bill_rate), 86);
      assert.equal(Number(rate.burden_pct), 22);
    });

  test("somebody starting work is on our payroll from that moment", async () => {
    const pl = await one(`select contact_id from placement where submission_id=$1`, [sub.id]);
    const c = await one(`select on_payroll from contact where id=$1`, [pl.contact_id]);
    assert.equal(c.on_payroll, true);
  });

  test("a placement with no rates is refused - payroll has nothing to run on",
    async () => {
      const other = await repo.insertRecord("contact", {
        full_name: "Ash Whitlock", email: "ash@example.com", is_candidate: true }, dev.id);
      const bare = await repo.submitCandidate({
        projectId: project.id, contactId: other.id }, dev.id);
      await repo.advanceSubmission(bare.id, "client_review", null, {}, dev.id);
      await repo.advanceSubmission(bare.id, "offer", "no interview needed", {}, dev.id);
      await assert.rejects(
        () => repo.placeSubmission({ submissionId: bare.id, startDate: "2026-10-01" }, dev.id),
        /needs a pay rate and a bill rate/);
    });

  test("it cannot be placed twice", async () => {
    await assert.rejects(
      () => repo.placeSubmission({ submissionId: sub.id, startDate: "2026-10-05" }, dev.id),
      /already has a placement/);
  });

  test("a newly placed consultant can be allocated time straight away", async () => {
    const pl = await one(`select contact_id from placement where submission_id=$1`, [sub.id]);
    const targets = await repo.allocationTargets(pl.contact_id, "2026-09-27");
    assert.ok(targets.length >= 1,
      "a placement that has started should be an allocation target");
    assert.equal(Number(targets[0].bill_rate), 86);
  });
});

describe("two recruiters cannot work the same person into the same client", () => {
  let bree, first;

  before(async () => {
    bree = await repo.insertRecord("contact", {
      full_name: "Bree Coleman", email: "bree@example.com", is_candidate: true }, dev.id);
    first = await repo.submitCandidate({
      projectId: project.id, contactId: bree.id, payRate: 60, billRate: 95 }, dev.id);
  });

  test("a second recruiter is stopped, and told who has her and on what", async () => {
    const second = await repo.insertRecord("project", {
      account_id: globex.id, name: "Line 6 controls", owner_id: rae.id }, rae.id);
    await assert.rejects(
      () => repo.submitCandidate({
        projectId: second.id, contactId: bree.id, payRate: 60, billRate: 95 }, rae.id),
      (e) => /already out to this client/.test(e.message) &&
             /Devon Okafor/.test(e.message) &&
             /Plant data platform/.test(e.message));
  });

  test("the same recruiter putting her up for a second role is ordinary work", async () => {
    const third = await repo.insertRecord("project", {
      account_id: globex.id, name: "Line 7 controls", owner_id: dev.id }, dev.id);
    const ok = await repo.submitCandidate({
      projectId: third.id, contactId: bree.id, payRate: 60, billRate: 95 }, dev.id);
    assert.equal(ok.stage, "submitted");
  });

  test("reviving a dead submission is checked again, not waved through", async () => {
    await repo.advanceSubmission(first.id, "rejected", "client filled it internally",
      { lossReasonCode: "client_hired_direct" }, dev.id);
    const others = await rows(
      `select s.id from submission s join project p on p.id = s.project_id
        where s.contact_id = $1 and p.account_id = $2 and s.id <> $3`,
      [bree.id, globex.id, first.id]);
    for (const o of others) {
      await repo.advanceSubmission(o.id, "withdrawn", "parking her for now",
        { lossReasonCode: "unresponsive" }, dev.id);
    }
    // Nobody has her now, so Rae may take her.
    const raeProject = await repo.insertRecord("project", {
      account_id: globex.id, name: "Line 8 controls", owner_id: rae.id }, rae.id);
    await repo.submitCandidate({
      projectId: raeProject.id, contactId: bree.id, payRate: 60, billRate: 95 }, rae.id);
    // And now Devon cannot bring his own back from the dead behind her.
    await assert.rejects(
      () => repo.advanceSubmission(first.id, "client_review", "client came back to me",
        {}, dev.id),
      (e) => /already out to this client/.test(e.message) &&
             /Rae Lambert/.test(e.message));
  });

  test("a person who is not a candidate cannot be submitted", async () => {
    const managerOnly = await repo.insertRecord("contact", {
      full_name: "Priya Raman", email: "priya@globex.com", is_manager: true,
      account_id: globex.id }, mark.id);
    await assert.rejects(
      () => repo.submitCandidate({
        projectId: project.id, contactId: managerOnly.id }, dev.id),
      /not marked as a candidate/);
  });
});

describe("the funnel counts what was reached, not where things ended up", () => {
  test("a rejected candidate still counts towards the interviews they got", async () => {
    const funnel = await repo.submissionFunnel();
    const at = (code) => funnel.find((f) => f.stage === code);
    // Ravi was interviewed twice and ended at offer; Jo never got past client_review.
    assert.ok(at("interview").reached >= 1);
    assert.ok(at("submitted").reached > at("interview").reached,
      "more submissions should have been submitted than interviewed");
    // sitting_here is the snapshot, reached is the history: they differ.
    assert.notEqual(at("submitted").reached, at("submitted").sitting_here);
  });

  test("losses are grouped by whose decision it was", async () => {
    const losses = await repo.lossBreakdown({ days: 365 });
    assert.ok(losses.length >= 2);
    const sides = new Set(losses.map((l) => l.side));
    assert.ok(sides.has("client") || sides.has("candidate"));
    for (const l of losses) assert.ok(l.label && l.losses >= 1);
  });

  test("the board carries the numbers a desk sorts by", async () => {
    const board = await repo.submissionBoard({ openOnly: false });
    assert.ok(board.length > 0);
    for (const b of board) {
      assert.ok(b.stage_label, "every row needs a readable stage");
      assert.ok(typeof b.days_in_stage === "number");
      assert.ok(b.account_name && b.project_name && b.contact_name);
    }
    const withRates = board.find((b) => b.pay_rate && b.bill_rate);
    assert.ok(withRates.gm_pct !== null, "margin should be computed on the board");
  });

  test("the board can be narrowed to what is still in play", async () => {
    const open = await repo.submissionBoard({ openOnly: true });
    const all = await repo.submissionBoard({ openOnly: false });
    assert.ok(open.length < all.length);
    for (const b of open) assert.equal(b.is_open, true);
  });
});

describe("the assistant works the pipeline through the same rules", () => {
  test("it is told which moves are legal rather than guessing", async () => {
    const tools = buildTools({ userId: dev.id });
    const machine = await tools.find((t) => t.name === "stage_machine").run({});
    assert.equal(machine.stages.length, 7);
    assert.ok(machine.movesFrom.submitted.length >= 4);
    assert.ok(machine.lossReasons.length > 5);
  });

  test("an illegal move comes back as a readable refusal, not a stack trace", async () => {
    const tools = buildTools({ userId: dev.id });
    const ash = await one(`select id from contact where full_name = 'Ash Whitlock'`);
    const sub = await one(`select id from submission where contact_id = $1`, [ash.id]);
    const out = await tools.find((t) => t.name === "advance_submission")
      .run({ submission_id: sub.id, to_stage: "placed" });
    assert.equal(out.error, "refused");
    assert.match(out.message, /create the placement first/);
  });

  test("submitting a resource through a tool resolves names and reports the margin", async () => {
    const tools = buildTools({ userId: dev.id });
    await repo.insertRecord("contact", {
      full_name: "Tomas Vidal", email: "tomas@example.com", is_candidate: true }, dev.id);
    const out = await tools.find((t) => t.name === "submit_resource").run({
      contact_name: "Tomas Vidal", project_name: "Line 7 controls",
      pay_rate: 55, bill_rate: 92, burden_pct: 22 });
    assert.ok(out.id, JSON.stringify(out));
    assert.ok(Number(out.gm_pct) > 20);
  });

  test("a tool asked for a submission with no name says what it needs", async () => {
    const tools = buildTools({ userId: dev.id });
    const out = await tools.find((t) => t.name === "get_submission").run({});
    assert.equal(out.error, "missing_information");
    assert.ok(out.needs.length);
  });

  test("the duplicate refusal reaches the assistant as an explanation", async () => {
    const tools = buildTools({ userId: dev.id });
    const out = await tools.find((t) => t.name === "submit_resource").run({
      contact_name: "Bree Coleman", project_name: "Plant data platform" });
    assert.equal(out.error, "refused");
    assert.match(out.message, /already out to this client/);
  });
});

describe("a week is allocated across projects, and approved a project at a time",
() => {
  let dana, priya, controls, pl1, pl2, poA, poB, ts;
  const week = "2026-08-30";
  const day = (n) => `2026-08-${String(24 + n).padStart(2, "0")}`;   // Mon = day(0)

  test("two placements at one client, two approving managers", async () => {
    dana = await repo.insertRecord("contact", {
      full_name: "Dana Approver", email: "dana.a@globex.com", is_manager: true,
      account_id: globex.id }, mark.id);
    priya = await repo.insertRecord("contact", {
      full_name: "Priya Approver", email: "priya.a@globex.com", is_manager: true,
      account_id: globex.id }, mark.id);
    controls = await repo.insertRecord("project", {
      account_id: globex.id, name: "Line 4 controls", delivery_type: "staffing" }, mark.id);

    await repo.setProjectApprovers(project.id, [dana.id], mark.id);
    await repo.setProjectApprovers(controls.id, [priya.id], mark.id);

    pl1 = await repo.insertRecord("placement",
      { project_id: project.id, contact_id: marcus.id, start_date: "2026-06-01" }, mark.id);
    pl2 = await repo.insertRecord("placement",
      { project_id: controls.id, contact_id: marcus.id, start_date: "2026-06-01" }, mark.id);
    await pool.query(
      `insert into placement_rate (placement_id, pay_rate, bill_rate, burden_pct,
         effective_from) values ($1,68,108,22,'2026-06-01')`, [pl1.id]);
    await pool.query(
      `insert into placement_rate (placement_id, pay_rate, bill_rate, burden_pct,
         effective_from) values ($1,55,90,22,'2026-06-01')`, [pl2.id]);
    poA = await repo.insertRecord("purchase_order",
      { project_id: project.id, po_number: "PO-A", amount: 50000,
        end_date: "2026-12-31" }, mark.id);
    poB = await repo.insertRecord("purchase_order",
      { project_id: controls.id, po_number: "PO-B", amount: 20000,
        end_date: "2026-12-31" }, mark.id);
  });

  test("an approver has to be a manager on that account", async () => {
    // Somebody we have never met at this client, and a manager at a different one.
    const outsider = await repo.insertRecord("contact",
      { full_name: "Wes Outsider", email: "wes@example.com", is_candidate: true },
      mark.id);
    await assert.rejects(
      () => repo.setProjectApprovers(project.id, [outsider.id], mark.id),
      /manager on this account/);
    // The real approvers are untouched by the attempt.
    const still = await repo.projectApprovers(project.id);
    assert.deepEqual(still.map((a) => a.full_name), ["Dana Approver"]);
  });

  test("allocation targets are the placements the consultant actually holds", async () => {
    const targets = await repo.allocationTargets(marcus.id, week);
    assert.ok(targets.some((t) => t.project_name === "Plant data platform"));
    assert.ok(targets.some((t) => t.project_name === "Line 4 controls"));
    assert.ok(targets.some((t) => t.po_number === "PO-A"));
    assert.ok(targets.some((t) => t.po_number === "PO-B"));
    // The bill rate in force is offered alongside, so the grid can price a week
    // before anything is entered.
    const onA = targets.find((t) => t.placement_id === pl1.id && t.po_number === "PO-A");
    assert.equal(Number(onA.bill_rate), 108);
    const onB = targets.find((t) => t.placement_id === pl2.id);
    assert.equal(Number(onB.bill_rate), 90);
  });

  test("a week can split a single day across two projects", async () => {
    ts = await repo.getOrCreateTimesheet(marcus.id, week, mark.id);
    await repo.saveTimesheet(ts.id, [
      { placement_id: pl1.id, purchase_order_id: poA.id, work_date: day(0), hours: 8 },
      { placement_id: pl1.id, purchase_order_id: poA.id, work_date: day(1), hours: 5 },
      { placement_id: pl2.id, purchase_order_id: poB.id, work_date: day(1), hours: 3 },
      { placement_id: pl2.id, purchase_order_id: poB.id, work_date: day(2), hours: 8 },
      { placement_id: pl1.id, purchase_order_id: poA.id, work_date: day(3), hours: 8 },
      { placement_id: pl1.id, purchase_order_id: poA.id, work_date: day(4), hours: 6 },
    ], mark.id);
    const full = await repo.getTimesheet(ts.id);
    assert.equal(full.total_hours, 38);
    const tuesday = full.entries.filter((e) =>
      e.work_date.toISOString().startsWith(day(1)));
    assert.equal(tuesday.length, 2, "Tuesday is split between two projects");
    assert.equal(Number(tuesday.reduce((a, e) => a + Number(e.hours), 0)), 8);
  });

  test("each day is priced at its own placement's rate", async () => {
    const full = await repo.getTimesheet(ts.id);
    const platformDay = full.entries.find((e) => e.po_number === "PO-A" &&
      Number(e.hours) === 8);
    const controlsDay = full.entries.find((e) => e.po_number === "PO-B" &&
      Number(e.hours) === 8);
    assert.equal(Number(platformDay.value), 864);   // 8 x 108
    assert.equal(Number(controlsDay.value), 720);   // 8 x 90
  });

  test("a day cannot exceed 24 hours however it is split", async () => {
    await assert.rejects(
      () => repo.saveTimesheet(ts.id, [
        { placement_id: pl1.id, purchase_order_id: poA.id, work_date: day(0), hours: 14 },
        { placement_id: pl2.id, purchase_order_id: poB.id, work_date: day(0), hours: 12 },
      ], mark.id),
      /26.00 hours/);
  });

  test("a day outside the week is refused", async () => {
    await assert.rejects(
      () => repo.saveTimesheet(ts.id, [
        { placement_id: pl1.id, purchase_order_id: poA.id,
          work_date: "2026-09-06", hours: 8 }], mark.id),
      /not in the week ending/);
  });

  test("a purchase order from another project is refused", async () => {
    await assert.rejects(
      () => repo.saveTimesheet(ts.id, [
        { placement_id: pl1.id, purchase_order_id: poB.id,
          work_date: day(0), hours: 8 }], mark.id),
      /does not belong to this project/);
  });

  test("submitting creates one packet per project, routed to its approver", async () => {
    // Put the good week back after the failed saves above.
    await repo.saveTimesheet(ts.id, [
      { placement_id: pl1.id, purchase_order_id: poA.id, work_date: day(0), hours: 8 },
      { placement_id: pl1.id, purchase_order_id: poA.id, work_date: day(1), hours: 5 },
      { placement_id: pl2.id, purchase_order_id: poB.id, work_date: day(1), hours: 3 },
      { placement_id: pl2.id, purchase_order_id: poB.id, work_date: day(2), hours: 8 },
      { placement_id: pl1.id, purchase_order_id: poA.id, work_date: day(3), hours: 8 },
      { placement_id: pl1.id, purchase_order_id: poA.id, work_date: day(4), hours: 6 },
    ], mark.id);
    const out = await repo.submitTimesheet(ts.id, mark.id);
    assert.equal(out.status, "submitted");
    assert.equal(out.packets.length, 2);
    const q = await repo.approvalQueue({ approverContactId: dana.id });
    assert.equal(q.length, 1);
    assert.equal(q[0].project_name, "Plant data platform");
    assert.equal(Number(q[0].hours), 27);
  });

  test("a submitted week cannot be edited", async () => {
    await assert.rejects(
      () => repo.saveTimesheet(ts.id, [
        { placement_id: pl1.id, purchase_order_id: poA.id,
          work_date: day(0), hours: 9 }], mark.id),
      /reopen it before changing it/);
  });

  test("one manager approving leaves the week partly approved", async () => {
    const q = await repo.approvalQueue({ approverContactId: dana.id });
    await repo.decideApproval(q[0].approval_id, "approved", "Dana Approver", null, mark.id);
    const full = await repo.getTimesheet(ts.id);
    assert.equal(full.status, "partly_approved");
    const approved = full.entries.filter((e) => e.approval_status === "approved");
    assert.equal(approved.length, 4);
    // Approving freezes the value on exactly those days and nothing else.
    assert.ok(approved.every((e) => e.billable_amount !== null));
    assert.ok(full.entries.filter((e) => e.approval_status === "pending")
      .every((e) => e.billable_amount === null));
  });

  test("the burn-down splits earned from still-pending by purchase order", async () => {
    const rows = await repo.poBurndown({});
    const a = rows.find((r) => r.po_number === "PO-A");
    const b = rows.find((r) => r.po_number === "PO-B");
    assert.equal(Number(a.approved_unbilled), 2916);   // 27h on the platform
    assert.equal(Number(a.submitted_pending), 0);
    assert.equal(Number(b.approved_unbilled), 0);
    assert.equal(Number(b.submitted_pending), 990);    // 11h on line 4
  });

  test("a decision cannot be made twice", async () => {
    const done = await repo.approvalQueue({ approverContactId: dana.id,
                                            status: "approved" });
    await assert.rejects(
      () => repo.decideApproval(done[0].approval_id, "rejected", "Someone Else",
                                "changed my mind", mark.id),
      /already approved by Dana Approver/);
  });

  test("only the approved days, on the right PO, can be billed", async () => {
    const inv = await repo.draftInvoiceFromApproved({ purchaseOrderId: poA.id }, mark.id);
    assert.equal(inv.line_count, 4);
    assert.equal(Number(inv.total), 2916);
    // Nothing on PO-B is approved, so there is nothing to bill there.
    const none = await repo.draftInvoiceFromApproved({ purchaseOrderId: poB.id }, mark.id);
    assert.equal(none.nothing_to_bill, true);
    await pool.query(`delete from invoice where id = $1`, [inv.id]);
  });

  test("a rejection releases the value and sends the week back", async () => {
    const q = await repo.approvalQueue({ approverContactId: priya.id });
    await repo.decideApproval(q[0].approval_id, "rejected", "Priya Approver",
                              "Tuesday belongs on the shutdown PO", mark.id);
    const full = await repo.getTimesheet(ts.id);
    assert.equal(full.status, "rejected");
    const rejected = full.entries.filter((e) => e.approval_status === "rejected");
    assert.equal(rejected.length, 2);
    assert.ok(rejected.every((e) => e.billable_amount === null),
      "a rejected day is no longer worth anything");
    const b = (await repo.poBurndown({})).find((r) => r.po_number === "PO-B");
    assert.equal(Number(b.approved_unbilled), 0);
    assert.equal(Number(b.submitted_pending), 0);
  });

  test("a rejection reopens only the rejected part, never the approved part",
  async () => {
    // This is the case that matters: Priya rejected line 4, so the week came
    // back - but Dana already approved the platform days, and those are frozen
    // and possibly already billed. Resending the whole week must be refused.
    await assert.rejects(
      () => repo.saveTimesheet(ts.id, [
        { placement_id: pl1.id, purchase_order_id: poA.id, work_date: day(0), hours: 9 },
        { placement_id: pl2.id, purchase_order_id: poB.id, work_date: day(2), hours: 8 },
      ], mark.id),
      /approved and is locked/);

    // Correcting only the rejected side is accepted, and leaves the approved
    // days exactly as they were.
    await repo.saveTimesheet(ts.id, [
      { placement_id: pl2.id, purchase_order_id: poB.id, work_date: day(2), hours: 6 },
    ], mark.id);
    const full = await repo.getTimesheet(ts.id);
    assert.equal(full.status, "draft", "corrections go back to draft, not straight out");
    const approved = full.entries.filter((e) => e.approval_status === "approved");
    assert.equal(approved.length, 4, "Dana's days survived untouched");
    assert.equal(approved.reduce((a, e) => a + Number(e.hours), 0), 27);
    const corrected = full.entries.filter((e) => e.po_number === "PO-B");
    assert.equal(corrected.length, 1);
    assert.equal(Number(corrected[0].hours), 6);
    assert.equal(full.approvals.length, 1, "the approved packet is still on file");
    assert.equal(full.approvals[0].status, "approved");
  });

  test("submitting a project with no approver on file still records the gap",
  async () => {
    const orphan = await repo.insertRecord("project",
      { account_id: globex.id, name: "Unrouted work" }, mark.id);
    const opl = await repo.insertRecord("placement",
      { project_id: orphan.id, contact_id: dana.id, start_date: "2026-06-01" }, mark.id);
    await pool.query(
      `insert into placement_rate (placement_id, pay_rate, bill_rate, burden_pct,
         effective_from) values ($1,50,80,22,'2026-06-01')`, [opl.id]);
    const ots = await repo.getOrCreateTimesheet(dana.id, week, mark.id);
    await repo.saveTimesheet(ots.id,
      [{ placement_id: opl.id, work_date: day(0), hours: 8 }], mark.id);
    const out = await repo.submitTimesheet(ots.id, mark.id);
    assert.equal(out.packets.length, 1);
    assert.equal(out.packets[0].approver_contact_id, null,
      "the packet exists so the time is not lost, but nobody is named on it");
  });

  test("time cannot be billed before anyone has approved it", async () => {
    const pending = await rows(
      `select entry_id from timesheet_entry_detail where approval_status = 'pending'
        limit 1`);
    const draft = await repo.insertRecord("invoice", {
      invoice_number: "TS-MANUAL-9", account_id: globex.id, project_id: project.id },
      mark.id);
    await assert.rejects(
      () => repo.insertRecord("invoice_line", {
        invoice_id: draft.id, kind: "time", timesheet_entry_id: pending[0].entry_id,
        description: "not approved", amount: 100 }, mark.id),
      /not approved/);
    await pool.query(`delete from invoice where id = $1`, [draft.id]);
  });
});

describe("invoices and payments", () => {
  let poC, pl, ts, invoice;

  test("a full cycle from entry to a paid invoice", async () => {
    const approver = await repo.insertRecord("contact", {
      full_name: "Cyril Approver", email: "cyril@globex.com", is_manager: true,
      account_id: globex.id }, mark.id);
    const proj = await repo.insertRecord("project",
      { account_id: globex.id, name: "Cycle test" }, mark.id);
    await repo.setProjectApprovers(proj.id, [approver.id], mark.id);
    pl = await repo.insertRecord("placement",
      { project_id: proj.id, contact_id: marcus.id, start_date: "2026-06-01" }, mark.id);
    await pool.query(
      `insert into placement_rate (placement_id, pay_rate, bill_rate, burden_pct,
         effective_from) values ($1,60,100,22,'2026-06-01')`, [pl.id]);
    poC = await repo.insertRecord("purchase_order",
      { project_id: proj.id, po_number: "PO-C", amount: 10000,
        end_date: "2026-12-31" }, mark.id);

    ts = await repo.getOrCreateTimesheet(marcus.id, "2026-09-06", mark.id);
    await repo.saveTimesheet(ts.id, [
      { placement_id: pl.id, purchase_order_id: poC.id,
        work_date: "2026-09-01", hours: 8 },
      { placement_id: pl.id, purchase_order_id: poC.id,
        work_date: "2026-09-02", hours: 8 },
    ], mark.id);
    await repo.submitTimesheet(ts.id, mark.id);

    const q = await repo.approvalQueue({ approverContactId: approver.id });
    await repo.decideApproval(q[0].approval_id, "approved", "Cyril Approver",
                              null, mark.id);

    invoice = await repo.draftInvoiceFromApproved({ purchaseOrderId: poC.id }, mark.id);
    assert.equal(Number(invoice.total), 1600);

    let b = (await repo.poBurndown({})).find((r) => r.po_number === "PO-C");
    assert.equal(Number(b.invoiced), 0, "a draft has not gone to the client");
    assert.equal(Number(b.drafted_not_sent), 1600);

    const sent = await repo.sendInvoice(invoice.id, "2026-09-10", mark.id);
    assert.equal(sent.status, "sent");
    b = (await repo.poBurndown({})).find((r) => r.po_number === "PO-C");
    assert.equal(Number(b.invoiced), 1600, "issuing is what burns the PO");
    assert.equal(Number(b.remaining), 8400);

    const paid = await repo.recordPayment(
      { invoiceId: invoice.id, amount: 1600, method: "ACH" }, mark.id);
    assert.equal(paid.status, "paid");
    b = (await repo.poBurndown({})).find((r) => r.po_number === "PO-C");
    assert.equal(Number(b.paid), 1600);
    assert.equal(Number(b.outstanding), 0);
    assert.equal(Number(b.invoiced), 1600, "paying does not change what was billed");
  });

  test("the same day cannot be billed twice", async () => {
    const entry = await one(
      `select l.timesheet_entry_id from invoice_line l where l.invoice_id = $1 limit 1`,
      [invoice.id]);
    const second = await repo.insertRecord("invoice", {
      invoice_number: "TS-DUP-1", account_id: globex.id,
      purchase_order_id: poC.id }, mark.id);
    await assert.rejects(
      () => repo.insertRecord("invoice_line", {
        invoice_id: second.id, kind: "time",
        timesheet_entry_id: entry.timesheet_entry_id,
        description: "billing it twice", amount: 800 }, mark.id),
      /already on a live invoice/);
    await pool.query(`delete from invoice where id = $1`, [second.id]);
  });

  test("a sent invoice is frozen", async () => {
    await assert.rejects(
      () => repo.insertRecord("invoice_line", {
        invoice_id: invoice.id, kind: "adjustment",
        description: "sneaking one on", amount: 500 }, mark.id),
      /can only change while it is a draft/);
  });

  test("an invoice that would overrun the PO is refused, and says what to do",
  async () => {
    const over = await repo.insertRecord("invoice", {
      invoice_number: "TS-OVER-1", account_id: globex.id,
      purchase_order_id: poC.id }, mark.id);
    await repo.insertRecord("invoice_line", {
      invoice_id: over.id, kind: "adjustment", description: "big one",
      amount: 9000 }, mark.id);
    await assert.rejects(
      () => repo.sendInvoice(over.id, "2026-09-11", mark.id),
      /over its limit.*change order/s);
    await pool.query(`delete from invoice where id = $1`, [over.id]);
  });

  test("voiding keeps the invoice and releases its days to be billed again",
  async () => {
    const voided = await repo.voidInvoice(invoice.id, "wrong PO", mark.id);
    assert.equal(voided.status, "void");
    assert.ok(await one(`select id from invoice where id = $1`, [invoice.id]));
    const b = (await repo.poBurndown({})).find((r) => r.po_number === "PO-C");
    assert.equal(Number(b.invoiced), 0);
    assert.equal(Number(b.approved_unbilled), 1600, "the days are billable again");
  });

  test("aging buckets an issued invoice and ignores drafts", async () => {
    const inv = await repo.insertRecord("invoice", {
      invoice_number: "TS-AGE-1", account_id: globex.id, terms_days: 30 }, mark.id);
    await repo.insertRecord("invoice_line", {
      invoice_id: inv.id, kind: "adjustment", description: "fee", amount: 1000 }, mark.id);
    assert.ok(!(await repo.invoiceAging()).some((a) => a.invoice_number === "TS-AGE-1"),
      "a draft is not a receivable");
    const old = new Date(Date.now() - 100 * 864e5).toISOString().slice(0, 10);
    await repo.sendInvoice(inv.id, old, mark.id);
    const row = (await repo.invoiceAging()).find((a) => a.invoice_number === "TS-AGE-1");
    assert.equal(row.bucket, "61-90");
    assert.equal(row.days_overdue, 70);
  });
});

// ------------------------------------------------------------- audit trail

describe("nothing changes without leaving a trace", () => {
  test("a write made outside the application is still audited", async () => {
    // The point of a trigger rather than a helper: this bypasses every line of
    // repo.js and is recorded anyway.
    const row = await one(
      `insert into account (name, status) values ('Backdoor Co','prospect') returning *`);
    const trail = await repo.revisionsFor("account", row.id);
    assert.equal(trail.length, 1);
    assert.equal(trail[0].action, "insert");
    assert.equal(trail[0].after.name, "Backdoor Co");
  });

  test("the acting user and a reason travel with the change", async () => {
    const acct = await one(`select id from account where name = 'Backdoor Co'`);
    await withContext(
      { actorId: rae.id, actorLabel: "Rae Lambert", reason: "client renamed" },
      () => repo.updateRecord("account", acct.id, { name: "Front Door Co" }));
    const trail = await repo.revisionsFor("account", acct.id);
    assert.equal(trail[0].changed_by, "Rae Lambert");
    assert.equal(trail[0].reason, "client renamed");
    assert.ok(trail[0].changed.includes("name"));
  });

  test("an update that changes nothing is not recorded as history", async () => {
    const acct = await one(`select id, name from account where name = 'Front Door Co'`);
    const before = (await repo.revisionsFor("account", acct.id)).length;
    await pool.query(`update account set name = $2 where id = $1`, [acct.id, acct.name]);
    assert.equal((await repo.revisionsFor("account", acct.id)).length, before,
      "a no-op update is noise, not history");
  });

  test("a delete is recorded with what was there", async () => {
    const doomed = await one(
      `insert into account (name) values ('Vanishing Ltd') returning *`);
    await pool.query(`delete from account where id = $1`, [doomed.id]);
    const trail = await repo.revisionsFor("account", doomed.id);
    assert.equal(trail[0].action, "delete");
    assert.equal(trail[0].before.name, "Vanishing Ltd");
  });

  test("the audit log cannot be edited or deleted", async () => {
    await assert.rejects(
      () => pool.query(`update audit_log set reason = 'nothing to see' where id =
        (select max(id) from audit_log)`),
      /audit log cannot be changed/);
    await assert.rejects(
      () => pool.query(`delete from audit_log where id = (select max(id) from audit_log)`),
      /audit log cannot be changed/);
  });

  test("one user action is one transaction across every table it touched",
  async () => {
    const acct = await withContext({ actorId: mark.id, actorLabel: "Mark Chesson" },
      () => repo.insertRecord("account", { name: "Txn Test Co" }));
    const trail = await repo.revisionsFor("account", acct.id);
    const together = await repo.auditTransaction(Number(trail[0].txid ?? 0)) || [];
    assert.ok(together.length >= 1);
    assert.ok(together.every((r) => String(r.txid) === String(trail[0].txid)));
  });

  test("the trail can be searched across the whole system", async () => {
    const all = await repo.auditTrail({ table: "account", action: "insert", limit: 50 });
    assert.ok(all.some((r) => r.label === "Txn Test Co"));
    const byActor = await repo.auditTrail({ actorId: rae.id });
    assert.ok(byActor.length >= 1);
    assert.ok(byActor.every((r) => r.actor === "Rae Lambert"));
  });
});

// ------------------------------------------------------------- locked time

describe("approved time is locked until an admin unlocks it", () => {
  let approver, proj, pl, ts, approvalId;
  const week = "2026-10-04";

  test("a week is entered, submitted and approved", async () => {
    approver = await repo.insertRecord("contact", {
      full_name: "Lock Approver", email: "lock@globex.com", is_manager: true,
      account_id: globex.id }, mark.id);
    proj = await repo.insertRecord("project",
      { account_id: globex.id, name: "Locked work" }, mark.id);
    await repo.setProjectApprovers(proj.id, [approver.id], mark.id);
    pl = await repo.insertRecord("placement",
      { project_id: proj.id, contact_id: marcus.id, start_date: "2026-06-01" }, mark.id);
    await pool.query(
      `insert into placement_rate (placement_id, pay_rate, bill_rate, burden_pct,
         effective_from) values ($1,60,100,22,'2026-06-01')`, [pl.id]);

    ts = await repo.getOrCreateTimesheet(marcus.id, week, mark.id);
    await repo.saveTimesheet(ts.id, [
      { placement_id: pl.id, work_date: "2026-09-28", hours: 8 },
      { placement_id: pl.id, work_date: "2026-09-29", hours: 8 },
    ], mark.id);
    await repo.submitTimesheet(ts.id, mark.id);
    const q = await repo.approvalQueue({ approverContactId: approver.id });
    approvalId = q[0].approval_id;
    await repo.decideApproval(approvalId, "approved", "Lock Approver", null, mark.id);
    const full = await repo.getTimesheet(ts.id);
    assert.equal(full.status, "approved");
  });

  test("nobody can change an approved day, not even the consultant", async () => {
    await assert.rejects(
      () => repo.saveTimesheet(ts.id, [
        { placement_id: pl.id, work_date: "2026-09-28", hours: 12 }], mark.id),
      /reopen it before changing it|approved and is locked/);
    // Not through the back door either.
    await assert.rejects(
      () => pool.query(
        `update timesheet_entry set hours = 12 where timesheet_id = $1`, [ts.id]),
      /approved and is locked/);
    await assert.rejects(
      () => pool.query(`delete from timesheet_entry where timesheet_id = $1`, [ts.id]),
      /approved and is locked/);
  });

  test("un-approving without a granted unlock is refused", async () => {
    await assert.rejects(
      () => pool.query(
        `update timesheet_approval set status = 'pending' where id = $1`, [approvalId]),
      /locked.*unlock request/s);
    await assert.rejects(
      () => repo.reopenApproval(approvalId, mark.id),
      /locked.*unlock request/s);
  });

  test("an unlock request needs a real reason", async () => {
    await assert.rejects(
      () => repo.requestUnlock({ approvalId, reason: "oops" }, dev.id),
      /say why/);
  });

  let request;
  test("a request is raised and waits for an admin", async () => {
    request = await withContext({ actorId: dev.id },
      () => repo.requestUnlock(
        { approvalId, reason: "Client says Monday was booked to the wrong project" },
        dev.id));
    assert.equal(request.status, "pending");
    const queue = await repo.listUnlockRequests({ status: "pending" });
    assert.ok(queue.some((r) => r.id === request.id));
    assert.equal(queue.find((r) => r.id === request.id).consultant, "Marcus Bell");
  });

  test("only one request can be open on a week at a time", async () => {
    await assert.rejects(
      () => repo.requestUnlock({ approvalId, reason: "asking again just in case" },
                               dev.id),
      /already an unlock request waiting/);
  });

  test("a non-admin cannot grant it", async () => {
    await assert.rejects(
      () => repo.decideUnlock(request.id, "granted", dev.id, null),
      /only an admin/);
  });

  test("an admin cannot grant their own request", async () => {
    const mine = await repo.requestUnlock(
      { approvalId, reason: "a second week that I am asking about myself" }, mark.id)
      .catch(() => null);
    // The one-open-request rule blocks a second, so test the rule directly.
    await pool.query(`update unlock_request set requested_by = $2 where id = $1`,
                     [request.id, mark.id]);
    await assert.rejects(
      () => repo.decideUnlock(request.id, "granted", mark.id, null),
      /somebody other than the requester/);
    await pool.query(`update unlock_request set requested_by = $2 where id = $1`,
                     [request.id, dev.id]);
    assert.equal(mine, null);
  });

  test("an admin grants it, and the grant opens the week once", async () => {
    const granted = await repo.decideUnlock(request.id, "granted", mark.id,
                                            "agreed, correct it");
    assert.equal(granted.status, "granted");
    assert.ok(granted.expires_at, "a grant is a key with a life, not a permanent door");

    await repo.reopenApproval(approvalId, mark.id);
    const full = await repo.getTimesheet(ts.id);
    assert.equal(full.status, "draft");
    assert.ok(full.entries.every((e) => e.billable_amount === null),
      "reopening releases the frozen values");

    const spent = await one(`select status, used_at from unlock_request where id = $1`,
                            [request.id]);
    assert.equal(spent.status, "used");
    assert.ok(spent.used_at);
  });

  test("now unlocked, the week can be corrected", async () => {
    await repo.saveTimesheet(ts.id, [
      { placement_id: pl.id, work_date: "2026-09-28", hours: 6 },
      { placement_id: pl.id, work_date: "2026-09-29", hours: 8 },
    ], mark.id);
    const full = await repo.getTimesheet(ts.id);
    assert.equal(full.total_hours, 14);
  });

  test("the key is spent - relocking and reopening needs a fresh grant", async () => {
    await repo.submitTimesheet(ts.id, mark.id);
    const q = await repo.approvalQueue({ approverContactId: approver.id });
    await repo.decideApproval(q[0].approval_id, "approved", "Lock Approver",
                              null, mark.id);
    await assert.rejects(
      () => repo.reopenApproval(q[0].approval_id, mark.id),
      /locked.*unlock request/s);
  });

  test("time that has already been invoiced cannot be unlocked at all", async () => {
    const poX = await repo.insertRecord("purchase_order",
      { project_id: proj.id, po_number: "PO-LOCK", amount: 50000,
        end_date: "2026-12-31" }, mark.id);
    // Put the approved days on that PO by correcting and re-approving is not
    // possible now, so bill them straight from the project instead.
    const inv = await repo.draftInvoiceFromApproved({ projectId: proj.id }, mark.id);
    await repo.sendInvoice(inv.id, "2026-10-05", mark.id);

    const q = await repo.approvalQueue({ approverContactId: approver.id,
                                         status: "approved" });
    const req = await repo.requestUnlock(
      { approvalId: q[0].approval_id,
        reason: "client disputes the hours after we billed them" }, dev.id);
    await assert.rejects(
      () => repo.decideUnlock(req.id, "granted", mark.id, null),
      /already on invoice.*Void or credit/s);
    assert.ok(poX);
  });

  test("every step of that left an audit entry", async () => {
    const trail = await repo.auditTrail({ table: "unlock_request", limit: 50 });
    assert.ok(trail.some((r) => r.action === "insert"));
    assert.ok(trail.some((r) => r.action === "update"));
    const onApproval = await repo.revisionsFor("timesheet_approval", approvalId);
    assert.ok(onApproval.length >= 3,
      "submitted, approved, reopened and approved again are all on the record");
  });
});

// --------------------------------------------------------------- the SQL tool

describe("the assistant's SQL access is read-only by grant", () => {
  test("a SELECT works", async () => {
    const r = await runReadOnlySql("select count(*) as n from account");
    assert.ok(r.rows[0].n >= 1);
  });

  test("a write is refused before it reaches the database", async () => {
    const r = await runReadOnlySql("delete from account");
    assert.match(r.error, /only SELECT/);
  });

  test("stacked statements are refused", async () => {
    const r = await runReadOnlySql("select 1; drop table account");
    assert.match(r.error, /one statement/);
  });

  test("and Postgres itself refuses a write on that connection", async () => {
    // The guard above is a convenience. This is the actual defence: even a
    // statement that slips past every check cannot write, because the role
    // holding the connection has no privilege to.
    await assert.rejects(
      () => readOnlyPool.query(`insert into app_user (email, full_name)
                                values ('x@y.z','X')`),
      /permission denied/);
  });

  test("a result set is capped so one query cannot flood the context", async () => {
    const r = await runReadOnlySql("select generate_series(1,5000) as n");
    assert.equal(r.rows.length, 200);
    assert.ok(r.truncated);
  });

  test("the schema description comes from the database, not a hand-kept list", async () => {
    const s = await describeSchema();
    assert.ok(s.account && s.contact && s.project);
    assert.equal(s.po_burndown.type, "VIEW");
    const names = s.contact.columns.map((c) => c.name);
    assert.ok(names.includes("is_manager") && names.includes("is_candidate"));
  });
});

// ------------------------------------------------------------- slot filling

describe("a tool that cannot proceed says what it needs", () => {
  test("a manager without a company asks for the company", async () => {
    const tools = buildTools({ userId: mark.id });
    const out = await tools.find((t) => t.name === "create_contact")
      .run({ full_name: "Nadia Frost", is_manager: true });
    assert.equal(out.error, "missing_information");
    assert.ok(out.needs.some((n) => /company/i.test(n)));
  });

  test("a person with no stated role asks which role", async () => {
    const tools = buildTools({ userId: mark.id });
    const out = await tools.find((t) => t.name === "create_contact")
      .run({ full_name: "Nadia Frost" });
    assert.ok(out.needs.some((n) => /manager|candidate/i.test(n)));
  });

  test("a project with no account asks which account", async () => {
    const tools = buildTools({ userId: mark.id });
    const out = await tools.find((t) => t.name === "create_project")
      .run({ name: "Some work" });
    assert.equal(out.error, "missing_information");
    assert.ok(out.needs.some((n) => /account/i.test(n)));
  });

  test("an ambiguous name offers the candidates rather than guessing", async () => {
    await repo.insertRecord("account", { name: "Globex Logistics" }, mark.id);
    const tools = buildTools({ userId: mark.id });
    const out = await tools.find((t) => t.name === "get_account").run({ name: "Globex" });
    assert.equal(out.error, "ambiguous");
    assert.equal(out.candidates.length, 2);
  });

  test("an exact name still resolves even when a longer one contains it", async () => {
    const tools = buildTools({ userId: mark.id });
    const out = await tools.find((t) => t.name === "get_account")
      .run({ name: "Globex Manufacturing" });
    assert.equal(out.id, globex.id);
  });
});

// ------------------------------------------------------------- the agent loop

describe("the agent loop", () => {
  test("runs tools the model asks for and returns the answer", async () => {
    agent.setClient(scriptedClient([
      { stop_reason: "tool_use",
        content: [toolBlock("list_accounts", { unassigned: true })] },
      { stop_reason: "end_turn",
        content: [textBlock("Hooli Health has no owner.")] },
    ]));
    const events = [];
    const r = await agent.runTurn({
      prompt: "which accounts are unassigned?",
      userId: mark.id,
      onEvent: (e) => events.push(e),
    });
    assert.equal(r.text, "Hooli Health has no owner.");
    assert.ok(events.some((e) => e.type === "tool_start" && e.tool === "list_accounts"));
    assert.ok(events.some((e) => e.type === "tool_end" && e.ok));
    agent.setClient(null);
  });

  test("captures a trace with the model call, the tool call and the SQL beneath it", async () => {
    agent.setClient(scriptedClient([
      { stop_reason: "tool_use", content: [toolBlock("list_accounts", {})] },
      { stop_reason: "end_turn", content: [textBlock("Three accounts.")] },
    ]));
    const r = await agent.runTurn({ prompt: "list accounts", userId: mark.id });
    const kinds = r.trace.steps.map((s) => s.type);
    assert.ok(kinds.includes("llm_request"));
    assert.ok(kinds.includes("tool_call"));
    assert.ok(kinds.includes("sql"), "the SQL the tool ran is in the trace");

    const sql = r.trace.steps.find((s) => s.type === "sql");
    assert.match(sql.sql, /from account/i);
    assert.ok(sql.ms >= 0 && sql.rowCount >= 1);

    const llm = r.trace.steps.find((s) => s.type === "llm_request");
    assert.equal(llm.model, "claude-opus-5");
    assert.ok(llm.costUsd > 0, "each call is costed");
    assert.ok(r.trace.costUsd > 0 && r.trace.durationMs >= 0);
    agent.setClient(null);
  });

  test("a tool failure is returned to the model rather than ending the turn", async () => {
    agent.setClient(scriptedClient([
      { stop_reason: "tool_use", content: [toolBlock("get_account", { name: "Nowhere Inc" })] },
      { stop_reason: "end_turn", content: [textBlock("I could not find that account.")] },
    ]));
    const r = await agent.runTurn({ prompt: "open Nowhere Inc", userId: mark.id });
    const call = r.trace.steps.find((s) => s.type === "tool_call");
    assert.equal(call.ok, false);
    assert.equal(r.text, "I could not find that account.");
    agent.setClient(null);
  });

  test("several tool calls in one turn come back in a single message", async () => {
    agent.setClient(scriptedClient([
      { stop_reason: "tool_use",
        content: [toolBlock("list_accounts", {}), toolBlock("list_users", {})] },
      { stop_reason: "end_turn", content: [textBlock("Done.")] },
    ]));
    const r = await agent.runTurn({ prompt: "accounts and users", userId: mark.id });
    const results = r.messages.filter((m) =>
      m.role === "user" && Array.isArray(m.content) &&
      m.content.every((b) => b.type === "tool_result"));
    assert.equal(results.length, 1, "one user message carrying both results");
    assert.equal(results[0].content.length, 2);
    agent.setClient(null);
  });

  test("the loop stops rather than running forever", async () => {
    // A model that only ever asks for another tool call.
    agent.setClient(scriptedClient([
      { stop_reason: "tool_use", content: [toolBlock("list_users", {})] },
    ]));
    const r = await agent.runTurn({ prompt: "loop", userId: mark.id });
    const calls = r.trace.steps.filter((s) => s.type === "llm_request").length;
    assert.equal(calls, 12, "capped at maxToolIterations");
    assert.match(r.text, /ran out of steps/);
    agent.setClient(null);
  });

  test("the system prompt is stable, so the cache can hit", async () => {
    const stub = scriptedClient([{ stop_reason: "end_turn", content: [textBlock("hi")] }]);
    agent.setClient(stub);
    await agent.runTurn({ prompt: "one", userId: mark.id });
    await agent.runTurn({ prompt: "two", userId: mark.id });
    const [a, b] = stub.requests;
    assert.equal(a.system[0].text, b.system[0].text);
    assert.deepEqual(a.system[0].cache_control, { type: "ephemeral" });
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(a.system[0].text),
      "no date in the prompt - that would invalidate the cache every day");
    agent.setClient(null);
  });

  test("the request carries the settings we think it does", async () => {
    const stub = scriptedClient([{ stop_reason: "end_turn", content: [textBlock("hi")] }]);
    agent.setClient(stub);
    await agent.runTurn({ prompt: "settings", userId: mark.id });
    const req = stub.requests[0];
    assert.equal(req.model, "claude-opus-5");
    assert.deepEqual(req.thinking, { type: "adaptive", display: "summarized" });
    assert.equal(req.output_config.effort, "high");
    assert.ok(req.tools.length >= 20);
    assert.ok(req.tools.every((t) => t.name && t.description && t.input_schema));
    assert.ok(!("budget_tokens" in (req.thinking || {})),
      "budget_tokens is rejected on this model");
    agent.setClient(null);
  });

  test("a turn is persisted so it survives a restart", async () => {
    agent.setClient(scriptedClient([
      { stop_reason: "end_turn", content: [textBlock("persisted")] }]));
    const r = await agent.runTurn({ prompt: "persist me", userId: mark.id });
    const saved = await one(`select * from trace where id = $1`, [r.trace.id]);
    assert.ok(saved);
    assert.equal(saved.prompt, "persist me");
    assert.ok(Number(saved.cost_usd) > 0);
    assert.ok(Array.isArray(saved.steps) && saved.steps.length >= 1);
    agent.setClient(null);
  });

  test("without a credential the turn fails with an instruction, not a stack trace", async () => {
    agent.setClient(null);
    const key = process.env.ANTHROPIC_API_KEY;
    const tok = process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    await assert.rejects(
      () => agent.runTurn({ prompt: "hello", userId: mark.id }),
      /ANTHROPIC_API_KEY/);
    if (key) process.env.ANTHROPIC_API_KEY = key;
    if (tok) process.env.ANTHROPIC_AUTH_TOKEN = tok;
  });
});

describe("conversations", () => {
  test("a turn is stored in full content-block form so it can be replayed", async () => {
    const conv = await agent.ensureConversation(null, mark.id, "Test chat");
    agent.setClient(scriptedClient([
      { stop_reason: "tool_use", content: [toolBlock("list_users", {})] },
      { stop_reason: "end_turn", content: [textBlock("Four users.")] },
    ]));
    const r = await agent.runTurn({
      prompt: "who is in the workspace?", userId: mark.id, conversationId: conv.id });
    await agent.saveMessages(conv.id, r.messages);
    const history = await agent.loadHistory(conv.id);
    assert.equal(history[0].role, "user");
    assert.ok(history.some((m) => m.role === "assistant" &&
      Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use")));
    agent.setClient(null);
  });
});

describe("a placement's status follows its start date", () => {
  test("one starting today is active, not waiting for somebody to notice", async () => {
    const c = await repo.insertRecord("contact", {
      full_name: "Ines Duarte", email: "ines@example.com", is_candidate: true }, dev.id);
    const p = await repo.insertRecord("project", {
      account_id: globex.id, name: "Line 9 controls", owner_id: dev.id }, dev.id);
    const sub = await repo.submitCandidate({
      projectId: p.id, contactId: c.id, payRate: 50, billRate: 80 }, dev.id);
    await repo.advanceSubmission(sub.id, "client_review", null, {}, dev.id);
    await repo.advanceSubmission(sub.id, "offer", "straight to offer", {}, dev.id);
    const today = new Date().toISOString().slice(0, 10);
    const out = await repo.placeSubmission({
      submissionId: sub.id, startDate: today }, dev.id);
    assert.equal(out.placement.status, "active");
  });

  test("one starting later is pending until it does", async () => {
    const c = await repo.insertRecord("contact", {
      full_name: "Omar Reyes", email: "omar@example.com", is_candidate: true }, dev.id);
    const p = await repo.insertRecord("project", {
      account_id: globex.id, name: "Line 10 controls", owner_id: dev.id }, dev.id);
    const sub = await repo.submitCandidate({
      projectId: p.id, contactId: c.id, payRate: 50, billRate: 80 }, dev.id);
    await repo.advanceSubmission(sub.id, "client_review", null, {}, dev.id);
    await repo.advanceSubmission(sub.id, "offer", "straight to offer", {}, dev.id);
    const later = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
    const out = await repo.placeSubmission({
      submissionId: sub.id, startDate: later }, dev.id);
    assert.equal(out.placement.status, "pending");
  });
});
