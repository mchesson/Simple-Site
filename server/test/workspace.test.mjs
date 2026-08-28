// Integration tests. These run against a real Postgres database built from the
// same schema the application uses - a mock would not catch the constraints,
// which are where most of the design lives.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { resetTestDatabase, scriptedClient, textBlock, toolBlock } from "./helpers.mjs";

resetTestDatabase();

const { pool, readOnlyPool, rows, one, close } = await import("../src/db.js");
const repo = await import("../src/repo.js");
const { buildTools, runReadOnlySql, describeSchema } = await import("../src/tools.js");
const agent = await import("../src/agent.js");
const trace = await import("../src/trace.js");

let mark, rae, dev, globex, austin, reno, dana, marcus, project;

before(async () => {
  await pool.query(`truncate app_user, account, account_owner, location, contact, project,
    submission, submission_event, placement, placement_rate, agreement, rate_verification,
    sow, change_order, purchase_order, timecard, document, activity, pipeline,
    pipeline_member, record_revision, domain_event, conversation, chat_message, trace
    restart identity cascade`);

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
    assert.equal(history[0].before.headline, null);
    assert.equal(history[0].after.headline, "Senior data engineer");
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

// --------------------------------------------------------- timecards & money

describe("time turns into money in three distinct stages", () => {
  let pl, po, weeks;

  test("a placement, a PO and three weeks of submitted time", async () => {
    pl = await repo.insertRecord("placement",
      { project_id: project.id, contact_id: marcus.id, start_date: "2026-06-01" }, mark.id);
    // Two effective-dated rates, so the "rate in force that week" logic is real.
    await pool.query(
      `insert into placement_rate (placement_id, pay_rate, bill_rate, burden_pct,
         effective_from, effective_to) values ($1,65,105,22,'2026-06-01','2026-08-01')`,
      [pl.id]);
    await pool.query(
      `insert into placement_rate (placement_id, pay_rate, bill_rate, burden_pct,
         effective_from) values ($1,68,108,22,'2026-08-01')`, [pl.id]);
    po = await repo.insertRecord("purchase_order",
      { project_id: project.id, po_number: "PO-TEST-1", amount: 30000,
        start_date: "2026-06-01", end_date: "2026-12-31" }, mark.id);
    weeks = [];
    for (const wk of ["2026-07-03", "2026-07-10", "2026-08-07"]) {
      weeks.push(await repo.insertRecord("timecard",
        { placement_id: pl.id, purchase_order_id: po.id, week_ending: wk,
          hours: 40, status: "submitted" }, mark.id));
    }
    assert.equal(weeks.length, 3);
  });

  test("a week is priced at the rate in force that week, not today's rate", async () => {
    const list = await repo.listTimecards({ poId: po.id });
    const july = list.find((t) => t.week_ending.toISOString().startsWith("2026-07-03"));
    const august = list.find((t) => t.week_ending.toISOString().startsWith("2026-08-07"));
    assert.equal(Number(july.value), 4200);    // 40 x 105
    assert.equal(Number(august.value), 4320);  // 40 x 108, after the rate moved
  });

  test("overtime uses the overtime rate, or time and a half when none is on file", async () => {
    const [r] = await rows(
      `select timecard_billable($1,'2026-07-03',40,5) as v`, [pl.id]);
    assert.equal(Number(r.v), 40 * 105 + 5 * 157.5);
  });

  test("submitted time is not earned and does not appear as unbilled", async () => {
    const [b] = await repo.poBurndown({ projectId: project.id });
    assert.equal(Number(b.invoiced), 0);
    assert.equal(Number(b.approved_unbilled), 0);
    assert.equal(Number(b.submitted_pending), 12720);
    assert.equal(Number(b.remaining), 30000);
  });

  test("approving freezes the value and makes it earned but still unbilled", async () => {
    const done = await repo.approveTimecards(weeks.map((w) => w.id), "Dana Reyes", mark.id);
    assert.equal(done.length, 3);
    assert.equal(Number(done[0].billable_amount) > 0, true);
    const [b] = await repo.poBurndown({ projectId: project.id });
    assert.equal(Number(b.invoiced), 0, "approval is not billing");
    assert.equal(Number(b.approved_unbilled), 12720);
    assert.equal(Number(b.submitted_pending), 0);
    assert.equal(Number(b.projected_remaining), 30000 - 12720);
  });

  test("approving the same week twice is refused", async () => {
    await assert.rejects(
      () => repo.approveTimecards([weeks[0].id], "Dana Reyes", mark.id),
      /already approved/);
  });

  let invoice;
  test("drafting collects the approved unbilled time and nothing else", async () => {
    invoice = await repo.draftInvoiceFromApproved(
      { purchaseOrderId: po.id }, mark.id);
    assert.equal(invoice.line_count, 3);
    assert.equal(Number(invoice.total), 12720);
    assert.equal(invoice.status, "draft");
    assert.match(invoice.invoice_number, /^TS-\d{4}-\d{4}$/);
  });

  test("a draft does not burn the PO - it moves into its own column", async () => {
    const [b] = await repo.poBurndown({ projectId: project.id });
    assert.equal(Number(b.invoiced), 0, "a draft has not gone to the client");
    assert.equal(Number(b.drafted_not_sent), 12720);
    assert.equal(Number(b.approved_unbilled), 0);
    assert.equal(Number(b.remaining), 30000);
    assert.equal(Number(b.projected_remaining), 30000 - 12720,
      "the money is still committed, whichever column it sits in");
  });

  test("drafting again finds nothing, because the time is already on an invoice", async () => {
    const again = await repo.draftInvoiceFromApproved({ purchaseOrderId: po.id }, mark.id);
    assert.equal(again.nothing_to_bill, true);
  });

  test("the database refuses the same week on a second live invoice", async () => {
    const other = await repo.insertRecord("invoice", {
      invoice_number: "TS-MANUAL-1", account_id: globex.id, project_id: project.id,
      purchase_order_id: po.id }, mark.id);
    await assert.rejects(
      () => repo.insertRecord("invoice_line", {
        invoice_id: other.id, kind: "time", timecard_id: weeks[0].id,
        description: "billing it twice", amount: 4200 }, mark.id),
      /already on a live invoice/);
    await pool.query(`delete from invoice where id = $1`, [other.id]);
  });

  test("sending is what burns the PO", async () => {
    const sent = await repo.sendInvoice(invoice.id, "2026-08-20", mark.id);
    assert.equal(sent.status, "sent");
    assert.equal(Number(sent.total), 12720);
    // 45 day terms by default.
    assert.equal(sent.due_date.toISOString().slice(0, 10), "2026-10-04");
    const [b] = await repo.poBurndown({ projectId: project.id });
    assert.equal(Number(b.invoiced), 12720);
    assert.equal(Number(b.drafted_not_sent), 0);
    assert.equal(Number(b.remaining), 30000 - 12720);
    assert.equal(Number(b.pct_invoiced), 42.4);
  });

  test("a payment lowers what is outstanding but not the burn", async () => {
    const part = await repo.recordPayment(
      { invoiceId: invoice.id, amount: 5000, method: "ACH" }, mark.id);
    assert.equal(part.status, "part_paid");
    assert.equal(Number(part.outstanding), 7720);
    const [b] = await repo.poBurndown({ projectId: project.id });
    assert.equal(Number(b.invoiced), 12720, "paying does not change what was billed");
    assert.equal(Number(b.paid), 5000);
    assert.equal(Number(b.outstanding), 7720);

    const settled = await repo.recordPayment(
      { invoiceId: invoice.id, amount: 7720, method: "ACH" }, mark.id);
    assert.equal(settled.status, "paid");
    assert.equal(Number(settled.outstanding), 0);
  });

  test("time the client has not approved cannot be invoiced", async () => {
    const raw = await repo.insertRecord("timecard",
      { placement_id: pl.id, purchase_order_id: po.id, week_ending: "2026-08-14",
        hours: 40, status: "submitted" }, mark.id);
    const draft = await repo.insertRecord("invoice", {
      invoice_number: "TS-MANUAL-2", account_id: globex.id, project_id: project.id,
      purchase_order_id: po.id }, mark.id);
    await assert.rejects(
      () => repo.insertRecord("invoice_line", {
        invoice_id: draft.id, kind: "time", timecard_id: raw.id,
        description: "not approved yet", amount: 4320 }, mark.id),
      /not approved/);
    await pool.query(`delete from invoice where id = $1`, [draft.id]);
  });

  test("an invoice cannot be changed once it has been sent", async () => {
    await assert.rejects(
      () => repo.insertRecord("invoice_line", {
        invoice_id: invoice.id, kind: "adjustment",
        description: "sneaking one on", amount: 500 }, mark.id),
      /can only change while it is a draft/);
  });

  test("an invoice that would overrun the PO is refused, and says what to do", async () => {
    const over = await repo.insertRecord("invoice", {
      invoice_number: "TS-MANUAL-3", account_id: globex.id, project_id: project.id,
      purchase_order_id: po.id }, mark.id);
    await repo.insertRecord("invoice_line", {
      invoice_id: over.id, kind: "adjustment", description: "big one",
      amount: 25000 }, mark.id);
    await assert.rejects(
      () => repo.sendInvoice(over.id, "2026-08-21", mark.id),
      /over its limit.*change order/s);
    await pool.query(`delete from invoice where id = $1`, [over.id]);
  });

  test("voiding keeps the invoice and releases its weeks to be billed again", async () => {
    const voided = await repo.voidInvoice(invoice.id, "wrong PO", mark.id);
    assert.equal(voided.status, "void");
    const still = await one(`select id from invoice where id = $1`, [invoice.id]);
    assert.ok(still, "the invoice row is still there");
    const [b] = await repo.poBurndown({ projectId: project.id });
    assert.equal(Number(b.invoiced), 0, "a void does not burn");
    assert.equal(Number(b.approved_unbilled), 12720, "the time is billable again");
    const redo = await repo.draftInvoiceFromApproved({ purchaseOrderId: po.id }, mark.id);
    assert.equal(redo.line_count, 3);
    await pool.query(`delete from invoice where id = $1`, [redo.id]);
  });

  test("aging buckets an issued invoice and ignores drafts", async () => {
    const inv = await repo.insertRecord("invoice", {
      invoice_number: "TS-AGE-1", account_id: globex.id, project_id: project.id,
      terms_days: 30 }, mark.id);
    await repo.insertRecord("invoice_line", {
      invoice_id: inv.id, kind: "adjustment", description: "fee", amount: 1000 }, mark.id);
    const drafts = await repo.invoiceAging();
    assert.ok(!drafts.some((a) => a.invoice_number === "TS-AGE-1"),
      "a draft is not a receivable");

    // Issued 100 days ago with 30 day terms, so it is 70 days past due.
    const old = new Date(Date.now() - 100 * 864e5).toISOString().slice(0, 10);
    await repo.sendInvoice(inv.id, old, mark.id);
    const aged = await repo.invoiceAging();
    const row = aged.find((a) => a.invoice_number === "TS-AGE-1");
    assert.equal(row.bucket, "61-90");
    assert.equal(row.days_overdue, 70);
  });

  test("the burn-down flags a PO that is already spent on approved work alone", async () => {
    const small = await repo.insertRecord("purchase_order",
      { project_id: project.id, po_number: "PO-TIGHT", amount: 1000,
        start_date: "2026-06-01", end_date: "2026-12-31" }, mark.id);
    const tc = await repo.insertRecord("timecard",
      { placement_id: pl.id, purchase_order_id: small.id, week_ending: "2026-09-04",
        hours: 40, status: "submitted" }, mark.id);
    await repo.approveTimecards([tc.id], "Dana Reyes", mark.id);
    const risky = await repo.poBurndown({ atRisk: true });
    const row = risky.find((r) => r.po_number === "PO-TIGHT");
    assert.ok(row, "an over-committed PO shows up as at risk");
    assert.equal(Number(row.remaining), 1000, "nothing invoiced, so it looks healthy");
    assert.ok(Number(row.projected_remaining) < 0,
      "but the approved backlog already exceeds it");
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
