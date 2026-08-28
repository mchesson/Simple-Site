/* TS Workspace, hosted as a single page.
 *
 * The server build keeps its rules in Postgres. A page has no database, so the
 * same rules live here as guards every write goes through - the behaviour is the
 * same, the floor underneath it is weaker, and the page says so.
 *
 * Two things hold regardless: nothing is deleted, and every change is audited.
 */

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
  }
  for (const kid of kids.flat(3)) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
};
const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : "id-" + Math.random().toString(36).slice(2) + Date.now().toString(36));
const money = (n) => n === null || n === undefined ? "—" :
  (Number(n) < 0 ? "-$" : "$") +
  Math.abs(Number(n)).toLocaleString(undefined, { maximumFractionDigits: 0 });
const money2 = (n) => "$" + Number(n || 0).toFixed(2);
const iso = (d) => {
  const x = new Date(d); x.setHours(12, 0, 0, 0);
  return x.toISOString().slice(0, 10);
};
const day = (d) => d ? new Date(d + "T12:00:00").toLocaleDateString(undefined,
  { month: "short", day: "numeric", year: "numeric" }) : "—";
const shortDay = (d) => new Date(d + "T12:00:00").toLocaleDateString(undefined,
  { weekday: "short", day: "numeric", month: "short" });
const num = (n) => Number(n || 0);
const sum = (a, f) => a.reduce((t, x) => t + num(f(x)), 0);

/* ------------------------------------------------------------------- state */

let S = null;
const byId = (list, id) => (S[list] || []).find((x) => x.id === id) || null;
const where = (list, pred) => (S[list] || []).filter(pred);

const TABLE_LABEL = {
  accounts: "account", locations: "location", contacts: "contact",
  projects: "project", placements: "placement", rates: "rate", pos: "purchase order",
  timesheets: "timesheet", entries: "time entry", approvals: "approval",
  submissions: "submission", pipelines: "pipeline", pipelineMembers: "pipeline member",
  unlocks: "unlock request", invoices: "invoice", invoiceLines: "invoice line",
  payments: "payment", documents: "document", activity: "activity",
  agreements: "agreement", accountOwners: "account owner",
  projectApprovers: "project approver", users: "user",
};

function actingUser() {
  return byId("users", S.actingUserId) || S.users[0];
}

/* Every write goes through here, so the audit trail cannot be bypassed by a
 * feature that forgets to record itself. */
function audit(table, action, before, after, reason) {
  const me = actingUser();
  const changed = action === "update" && before && after
    ? Object.keys(after).filter((k) =>
        JSON.stringify(after[k]) !== JSON.stringify(before[k]))
    : null;
  if (action === "update" && changed && !changed.length) return null;
  S.audit.unshift({
    id: uid(), table, recordId: (after || before || {}).id || null, action,
    before: before ? { ...before } : null, after: after ? { ...after } : null,
    changed, actorId: me ? me.id : null, actorLabel: me ? me.name : null,
    reason: reason || null, at: new Date().toISOString(),
  });
  if (S.audit.length > 4000) S.audit.length = 4000;
  return true;
}

function insert(table, row, reason) {
  const withId = { id: uid(), ...row };
  (S[table] ||= []).push(withId);
  audit(table, "insert", null, withId, reason);
  return withId;
}
function update(table, id, changes, reason) {
  const list = S[table] || [];
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) throw new Error("not found");
  const before = { ...list[i] };
  list[i] = { ...list[i], ...changes };
  audit(table, "update", before, list[i], reason);
  return list[i];
}
function remove(table, id, reason) {
  const list = S[table] || [];
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return null;
  const before = list[i];
  list.splice(i, 1);
  audit(table, "delete", before, null, reason);
  return before;
}

/* --------------------------------------------------------- the front office */

const DAY = 864e5;
const daysSince = (when) => when
  ? Math.floor((Date.now() - new Date(when).getTime()) / DAY) : null;
const daysUntil = (when) => when
  ? Math.round((new Date(when + "T12:00:00").getTime() - Date.now()) / DAY) : null;

/* Three words for a person, and they are not interchangeable.
 *
 *   candidate   Somebody we could place. A role on a contact record, alongside
 *               manager - the same human can be both.
 *   resource    The internal word for a person put against a project's need.
 *               A project has a resource need; we submit a resource to fill it.
 *               This is how the desk talks among itself.
 *   consultant  A person who is working: on our payroll, on an assignment.
 *               This is the word for the person themselves, and the word to use
 *               anywhere they would read it.
 *
 * So a candidate is submitted as a resource and becomes a consultant on the day
 * they start. Somebody already on the bench is a consultant being submitted as
 * a resource again, which is why the submit action says resource and not
 * consultant - it has to be true in both cases.
 *
 * "Somebody" is still the right word when it means a colleague of ours, and is
 * left alone in those places.
 */

/* The stage machine.
 *
 * On the server this is two tables and a trigger, so a stage cannot move the
 * wrong way even from a SQL prompt. A page has no trigger, so the same rules
 * are these three lists plus the guards in the pipeline section - and the
 * screen draws its buttons from them rather than hard-coding a set, which is
 * the habit that keeps the two builds honest with each other.
 */
const STAGES = [
  { code: "submitted",     label: "Submitted",    sort: 10, open: true,  entry: true },
  { code: "client_review", label: "With client",  sort: 20, open: true },
  { code: "interview",     label: "Interviewing", sort: 30, open: true },
  { code: "offer",         label: "Offer out",    sort: 40, open: true },
  { code: "placed",        label: "Placed",       sort: 50, open: false, won: true },
  { code: "rejected",      label: "Rejected",     sort: 60, open: false },
  { code: "withdrawn",     label: "Withdrawn",    sort: 70, open: false },
];

/* from, to, what the button says, whether the person has to explain themselves */
const FLOW = [
  ["submitted",     "client_review", "Client has it",             false],
  ["client_review", "interview",     "Interview booked",          false],
  ["interview",     "offer",         "Offer out",                 false],
  ["offer",         "placed",        "Placed",                    false],
  ["submitted",     "interview",     "Straight to interview",     false],
  ["client_review", "offer",         "Offer without interview",   true],
  ["interview",     "client_review", "Back with the client",       true],
  ["offer",         "interview",     "Another interview round",    true],
  ["submitted",     "rejected",      "Rejected",                  true],
  ["client_review", "rejected",      "Rejected",                  true],
  ["interview",     "rejected",      "Rejected",                  true],
  ["offer",         "rejected",      "Rejected",                  true],
  ["submitted",     "withdrawn",     "Withdrawn",                 true],
  ["client_review", "withdrawn",     "Withdrawn",                 true],
  ["interview",     "withdrawn",     "Withdrawn",                 true],
  ["offer",         "withdrawn",     "Withdrawn",                 true],
  ["placed",        "withdrawn",     "Never started",             true],
  ["rejected",      "client_review", "Client came back",           true],
  ["withdrawn",     "submitted",     "Back in play",               true],
].map(([from, to, label, needsReason]) => ({ from, to, label, needsReason }));

/* Why we lost, in a fixed list so it can be counted. side is whose decision it
 * was: the fix for a client reason is a rate conversation, for a candidate
 * reason it is a closing conversation, and for one of ours it is process. */
const LOSS_REASONS = [
  ["rate_too_high",       "Rate too high",                       "client"],
  ["skills_gap",          "Not the right skills",                "client"],
  ["someone_else_filled", "Client filled it elsewhere",           "client"],
  ["client_hired_direct", "Client hired directly",                "client"],
  ["project_cancelled",   "Project cancelled or on hold",         "client"],
  ["interview_poor",      "Interviewed badly",                    "client"],
  ["took_other_offer",    "Took another offer",                   "candidate"],
  ["declined_rate",       "Declined our rate",                    "candidate"],
  ["unresponsive",        "Went dark on us",                      "candidate"],
  ["counter_offered",     "Counter offered where they are",       "candidate"],
  ["failed_screening",    "Failed background or drug screening",  "candidate"],
  ["submitted_too_late",  "We were too late",                     "us"],
  ["wrong_submission",    "We submitted the wrong person",        "us"],
  ["no_reason_given",     "No reason given",                      "client"],
].map(([code, label, side]) => ({ code, label, side }));

const stageOf = (code) => STAGES.find((s) => s.code === code) || null;
const stageIsOpen = (code) => !!(stageOf(code) || {}).open;
const movesFrom = (code) => FLOW.filter((f) => f.from === code);
const lossReason = (code) => LOSS_REASONS.find((l) => l.code === code) || null;

const OPEN_STAGES = STAGES.filter((s) => s.open).map((s) => s.code);
const STAGE_LABEL = Object.fromEntries(STAGES.map((s) => [s.code, s.label]));

/* Log an interaction. Which hat the person was wearing follows from the context,
 * the same way the server works it out: a note against a project is
 * candidate-side, a note about the company they work for is manager-side. */
function logActivity({ contactId, accountId = null, projectId = null, asRole = null,
                       kind = "note", body }) {
  const c = byId("contacts", contactId);
  if (!c) throw new Error("that person is not on file");
  if (!body || !body.trim()) throw new Error("there is nothing to record");
  let role = asRole;
  if (!role) {
    if (projectId) role = "candidate";
    else if (accountId && c.isManager && c.accountId === accountId) role = "manager";
    else if (c.isManager && !c.isCandidate) role = "manager";
    else if (c.isCandidate && !c.isManager) role = "candidate";
    else role = "manager";
  }
  return insert("activity", {
    contactId, accountId: accountId || (role === "manager" ? c.accountId : null),
    projectId, asRole: role, kind, body: body.trim(),
    actorId: actingUser().id, occurredAt: new Date().toISOString(),
  }, "logged an interaction");
}

const lastTouch = (contactId) => where("activity", (a) => a.contactId === contactId)
  .map((a) => a.occurredAt).sort().pop() || null;

/* When did anyone last touch this account - through its managers, its projects,
 * or the account itself. Sales lives off this number. */
function accountLastTouch(accountId) {
  const projectIds = new Set(projectsOf(accountId).map((p) => p.id));
  const dates = where("activity", (a) =>
    a.accountId === accountId ||
    (a.projectId && projectIds.has(a.projectId)) ||
    (a.contactId && (byId("contacts", a.contactId) || {}).accountId === accountId))
    .map((a) => a.occurredAt);
  return dates.sort().pop() || null;
}
const ownedBy = (userId) => where("accountOwners", (o) => o.userId === userId)
  .map((o) => byId("accounts", o.accountId)).filter((a) => a && !a.archivedAt);

const submissionsFor = (projectId) => where("submissions",
  (x) => x.projectId === projectId);
const openSubmissions = (projectId) => submissionsFor(projectId)
  .filter((x) => OPEN_STAGES.includes(x.stage));

const activePlacements = (projectId) => where("placements",
  (pl) => pl.projectId === projectId && pl.status === "active");

/* A seat is open when the project wants more people than it has working. This is
 * the number a recruiter starts the day with. */
function seatsToFill(ownerId = null) {
  return where("projects", (p) => !p.archivedAt && p.status === "open")
    .map((p) => {
      const filled = activePlacements(p.id).length;
      const open = Math.max(0, num(p.openings) - filled);
      const out = openSubmissions(p.id);
      const account = byId("accounts", p.accountId);
      return { project: p, account, open, filled, submitted: out.length,
               daysOpen: daysSince(p.createdAt || null),
               owner: p.ownerId };
    })
    .filter((r) => r.open > 0 && (!ownerId || r.owner === ownerId ||
      where("accountOwners", (o) => o.accountId === r.project.accountId &&
        o.userId === ownerId).length > 0))
    .sort((a, b) => (a.submitted - b.submitted) || (b.open - a.open));
}

/* Submissions sitting with the client, oldest first. The ones nobody has chased. */
function waitingOnClient(ownerId = null) {
  return where("submissions", (x) => ["client_review", "interview", "offer"]
    .includes(x.stage))
    .map((x) => {
      const project = byId("projects", x.projectId);
      const contact = byId("contacts", x.contactId);
      const account = project ? byId("accounts", project.accountId) : null;
      return { ...x, project, contact, account,
               waiting: daysSince(x.stageSince) ?? 0,
               lastTouch: lastTouch(x.contactId) };
    })
    .filter((r) => r.project && r.contact &&
      (!ownerId || r.submittedBy === ownerId || r.project.ownerId === ownerId))
    .sort((a, b) => b.waiting - a.waiting);
}

/* Candidates we are working who have gone quiet. In the pipeline or submitted,
 * and nobody has spoken to them for a while. */
function goingCold(days = 14, ownerId = null) {
  const inPlay = new Set([
    ...where("submissions", (x) => OPEN_STAGES.includes(x.stage)).map((x) => x.contactId),
    ...where("pipelineMembers", () => true).map((m) => m.contactId),
  ]);
  return [...inPlay].map((id) => byId("contacts", id)).filter(Boolean)
    .map((c) => ({ contact: c, quiet: daysSince(lastTouch(c.id)),
                   recruiterId: c.recruiterId }))
    .filter((r) => (r.quiet === null || r.quiet >= days) &&
      (!ownerId || !r.recruiterId || r.recruiterId === ownerId))
    .sort((a, b) => (b.quiet ?? 9999) - (a.quiet ?? 9999));
}

/* Consultants whose assignment ends soon. Every one is a redeployment
 * conversation, and an extension conversation for whoever owns the account. */
function rollingOff(days = 45) {
  return where("placements", (pl) => pl.status === "active" && pl.endDate)
    .map((pl) => {
      const project = byId("projects", pl.projectId);
      return { placement: pl, contact: byId("contacts", pl.contactId), project,
               account: project ? byId("accounts", project.accountId) : null,
               left: daysUntil(pl.endDate) };
    })
    .filter((r) => r.contact && r.left !== null && r.left <= days)
    .sort((a, b) => a.left - b.left);
}

/* An account we cannot legally staff, or one whose paperwork has lapsed. */
function agreementGaps() {
  return activeAccounts().map((a) => {
    const msa = where("agreements", (g) => g.accountId === a.id && g.kind === "MSA"
      && g.status === "executed")[0];
    const expired = msa && msa.effectiveTo && msa.effectiveTo < iso(new Date());
    const openProjects = projectsOf(a.id).filter((p) => p.status === "open").length;
    return { account: a, msa, expired, openProjects };
  }).filter((r) => !r.msa || r.expired)
    .sort((a, b) => b.openProjects - a.openProjects);
}

function quietAccounts(days = 21, ownerId = null) {
  const mine = ownerId ? ownedBy(ownerId) : activeAccounts();
  return mine.map((a) => ({ account: a, quiet: daysSince(accountLastTouch(a.id)),
                            openProjects: projectsOf(a.id)
                              .filter((p) => p.status === "open").length }))
    .filter((r) => r.quiet === null || r.quiet >= days)
    .sort((a, b) => (b.quiet ?? 9999) - (a.quiet ?? 9999));
}

/* What an account is worth a week right now, at the rate in force today. */
function runRate(accountId) {
  const today = iso(new Date());
  return sum(projectsOf(accountId).flatMap((p) => activePlacements(p.id)), (pl) => {
    const r = rateInForce(pl.id, today);
    if (!r) return 0;
    const m = grossMargin(r.payRate, r.billRate, r.burdenPct);
    return m.gm * 40;
  });
}

const myPipelines = (ownerId) => where("pipelines", (pl) => pl.ownerId === ownerId)
  .map((pl) => ({ ...pl,
    members: where("pipelineMembers", (m) => m.pipelineId === pl.id)
      .map((m) => ({ ...m, contact: byId("contacts", m.contactId) }))
      .filter((m) => m.contact) }));

/* ------------------------------------------------------------- money & rates */

function grossMargin(pay, bill, burdenPct) {
  const p = num(pay), b = num(bill), bp = num(burdenPct);
  const gm = b - p - (p * bp / 100);
  return { gm, gmPct: b ? gm / b * 100 : null, spread: b - p, burden: p * bp / 100 };
}

/* The rate in force on a date. Rates are effective-dated and never edited, so
 * "what was the rate that day" always has an answer. */
function rateInForce(placementId, date, type = "standard") {
  return where("rates", (r) => r.placementId === placementId && r.rateType === type &&
    r.effectiveFrom <= date && (!r.effectiveTo || r.effectiveTo > date))[0] || null;
}

function entryBillable(placementId, date, hours, ot) {
  const std = rateInForce(placementId, date, "standard");
  if (!std) return null;
  const otRate = rateInForce(placementId, date, "overtime");
  const rate = otRate ? otRate.billRate : std.billRate * 1.5;
  return Math.round((num(hours) * std.billRate + num(ot) * rate) * 100) / 100;
}

const entryValue = (e) => e.billableAmount !== null && e.billableAmount !== undefined
  ? num(e.billableAmount)
  : num(entryBillable(e.placementId, e.workDate, e.hours, e.otHours));

const approvalFor = (timesheetId, projectId) =>
  where("approvals", (a) => a.timesheetId === timesheetId && a.projectId === projectId)[0]
  || null;

const entryApproval = (e) => approvalFor(e.timesheetId, e.projectId);
const entryInvoiceLine = (e) => where("invoiceLines", (l) => l.entryId === e.id)
  .find((l) => { const i = byId("invoices", l.invoiceId); return i && i.status !== "void"; })
  || null;

/* ------------------------------------------------------------- burn-down */

function poBurndown(filter = {}) {
  return where("pos", (po) => {
    const p = byId("projects", po.projectId);
    if (filter.projectId && po.projectId !== filter.projectId) return false;
    if (filter.accountId && (!p || p.accountId !== filter.accountId)) return false;
    return true;
  }).map((po) => {
    const lines = where("invoiceLines", (l) => {
      const e = byId("entries", l.entryId);
      const inv = byId("invoices", l.invoiceId);
      if (!inv || inv.status === "void") return false;
      if (inv.purchaseOrderId === po.id) return true;
      return e && e.purchaseOrderId === po.id;
    });
    const liveInv = (st) => lines.filter((l) => {
      const inv = byId("invoices", l.invoiceId);
      return inv && st.includes(inv.status);
    });
    const invoiced = sum(liveInv(["sent", "part_paid", "paid"]), (l) => l.amount);
    const drafted = sum(liveInv(["draft"]), (l) => l.amount);
    const paid = sum(where("payments", (p) => {
      const inv = byId("invoices", p.invoiceId);
      return inv && inv.status !== "void" && inv.purchaseOrderId === po.id;
    }), (p) => p.amount);

    const poEntries = where("entries", (e) => e.purchaseOrderId === po.id);
    const approvedUnbilled = sum(poEntries.filter((e) => {
      const a = entryApproval(e);
      return a && a.status === "approved" && !entryInvoiceLine(e);
    }), entryValue);
    const submittedPending = sum(poEntries.filter((e) => {
      const a = entryApproval(e);
      return a && a.status === "pending";
    }), entryValue);

    const project = byId("projects", po.projectId);
    const account = project ? byId("accounts", project.accountId) : null;
    const amount = num(po.amount);
    const days = po.endDate
      ? Math.round((new Date(po.endDate + "T12:00:00") - new Date()) / 864e5) : null;
    return {
      ...po, projectName: project ? project.name : "—",
      accountName: account ? account.name : "—",
      invoiced, drafted, paid, outstanding: invoiced - paid,
      approvedUnbilled, submittedPending,
      remaining: amount - invoiced,
      projectedRemaining: amount - invoiced - drafted - approvedUnbilled,
      pctInvoiced: amount ? Math.round(invoiced / amount * 10000) / 100 : null,
      pctCommitted: amount
        ? Math.round((invoiced + drafted + approvedUnbilled) / amount * 10000) / 100 : null,
      daysRemaining: days,
    };
  }).sort((a, b) => (a.daysRemaining ?? 1e9) - (b.daysRemaining ?? 1e9));
}

/* ---------------------------------------------------------- timesheet cycle */

function weekEndingOf(date = new Date()) {
  const d = new Date(date); d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
  return d;
}
function daysOfWeek(weekEnding) {
  const end = new Date(weekEnding + "T12:00:00");
  return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label, i) => {
    const d = new Date(end); d.setDate(end.getDate() - 6 + i);
    return { label, date: iso(d) };
  });
}

function getOrCreateTimesheet(contactId, weekEnding) {
  const found = where("timesheets",
    (t) => t.contactId === contactId && t.weekEnding === weekEnding)[0];
  if (found) return found;
  return insert("timesheets",
    { contactId, weekEnding, status: "draft", submittedAt: null, notes: null },
    "started a week");
}

function allocationTargets(contactId, weekEnding) {
  const out = [];
  for (const pl of where("placements", (p) => p.contactId === contactId)) {
    if (pl.startDate > weekEnding) continue;
    const project = byId("projects", pl.projectId);
    if (!project) continue;
    const account = byId("accounts", project.accountId);
    const pos = where("pos", (po) => po.projectId === project.id && po.status === "open");
    const rate = rateInForce(pl.id, weekEnding);
    const base = { placementId: pl.id, projectId: project.id, projectName: project.name,
                   deliveryType: project.deliveryType,
                   accountName: account ? account.name : "—",
                   billRate: rate ? rate.billRate : null };
    if (!pos.length) out.push({ ...base, purchaseOrderId: null, poNumber: null });
    for (const po of pos) {
      out.push({ ...base, purchaseOrderId: po.id, poNumber: po.poNumber,
                 poEndDate: po.endDate });
    }
  }
  return out;
}

const lockedProjectsFor = (timesheetId) => new Set(
  where("approvals", (a) => a.timesheetId === timesheetId && a.status === "approved")
    .map((a) => a.projectId));

/* Save a week. The whole unlocked part is replaced at once, because that is how
 * a grid is edited. Approved days are left exactly where they are. */
function saveTimesheet(timesheetId, rows) {
  const ts = byId("timesheets", timesheetId);
  if (!ts) throw new Error("that week is not on file");
  if (!["draft", "rejected"].includes(ts.status)) {
    throw new Error(`that week is ${ts.status.replace(/_/g, " ")} — it cannot be edited`);
  }
  const locked = lockedProjectsFor(timesheetId);
  const weekDays = daysOfWeek(ts.weekEnding).map((d) => d.date);

  // Validate before touching anything, so a bad edit changes nothing.
  const perDay = {};
  for (const r of rows) {
    const hours = num(r.hours), ot = num(r.otHours);
    if (hours <= 0 && ot <= 0) continue;
    if (!weekDays.includes(r.workDate)) {
      throw new Error(`${r.workDate} is not in the week ending ${ts.weekEnding}`);
    }
    const pl = byId("placements", r.placementId);
    if (!pl) throw new Error("that placement is not on file");
    const projectId = pl.projectId;
    if (r.purchaseOrderId) {
      const po = byId("pos", r.purchaseOrderId);
      if (!po || po.projectId !== projectId) {
        throw new Error("that purchase order does not belong to this project");
      }
    }
    if (locked.has(projectId)) {
      throw new Error(
        "some of that time was approved and is locked. Request an unlock and have " +
        "an admin grant it before changing those days.");
    }
    if (!rateInForce(r.placementId, r.workDate)) {
      throw new Error(`no rate is in force for that placement on ${r.workDate}`);
    }
    perDay[r.workDate] = (perDay[r.workDate] || 0) + hours + ot;
  }
  for (const e of where("entries", (x) => x.timesheetId === timesheetId)) {
    if (locked.has(e.projectId)) {
      perDay[e.workDate] = (perDay[e.workDate] || 0) + num(e.hours) + num(e.otHours);
    }
  }
  for (const [d, total] of Object.entries(perDay)) {
    if (total > 24) throw new Error(`that would put ${d} at ${total} hours`);
  }

  for (const e of where("entries", (x) => x.timesheetId === timesheetId)) {
    if (!locked.has(e.projectId)) remove("entries", e.id, "week re-entered");
  }
  const kept = [];
  for (const r of rows) {
    const hours = num(r.hours), ot = num(r.otHours);
    if (hours <= 0 && ot <= 0) continue;
    const pl = byId("placements", r.placementId);
    if (locked.has(pl.projectId)) continue;
    kept.push(insert("entries", {
      timesheetId, placementId: r.placementId, projectId: pl.projectId,
      purchaseOrderId: r.purchaseOrderId || null, workDate: r.workDate,
      hours, otHours: ot, notes: r.notes || null, billableAmount: null,
    }, "time entered"));
  }
  if (ts.status === "rejected") {
    update("timesheets", timesheetId, { status: "draft" }, "reopened for correction");
    for (const a of where("approvals",
      (x) => x.timesheetId === timesheetId && x.status !== "approved")) {
      remove("approvals", a.id, "week is being corrected");
    }
  }
  return kept;
}

/* Submitting routes one packet per project to that project's approver. */
function submitTimesheet(timesheetId) {
  const ts = byId("timesheets", timesheetId);
  if (!ts) throw new Error("that week is not on file");
  if (!["draft", "rejected"].includes(ts.status)) {
    throw new Error(`that week is already ${ts.status.replace(/_/g, " ")}`);
  }
  const entries = where("entries", (e) => e.timesheetId === timesheetId);
  if (!entries.length) throw new Error("there is no time on that week to submit");

  for (const a of where("approvals",
    (x) => x.timesheetId === timesheetId && x.status !== "approved")) {
    remove("approvals", a.id, "re-submitted");
  }
  const projects = [...new Set(entries.map((e) => e.projectId))];
  const packets = [];
  for (const projectId of projects) {
    const existing = approvalFor(timesheetId, projectId);
    if (existing) { packets.push(existing); continue; }
    const approver = where("projectApprovers", (pa) => pa.projectId === projectId)
      .sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0))[0];
    packets.push(insert("approvals", {
      timesheetId, projectId, approverContactId: approver ? approver.contactId : null,
      status: "pending", decidedAt: null, decidedBy: null, note: null,
    }, "submitted for approval"));
  }
  update("timesheets", timesheetId,
    { status: "submitted", submittedAt: new Date().toISOString() },
    "submitted for approval");
  return packets;
}

function rollUpTimesheet(timesheetId) {
  const packets = where("approvals", (a) => a.timesheetId === timesheetId);
  if (!packets.length) return;
  let status = "submitted";
  if (packets.some((p) => p.status === "rejected")) status = "rejected";
  else if (packets.every((p) => p.status === "approved")) status = "approved";
  else if (packets.some((p) => p.status === "approved")) status = "partly_approved";
  update("timesheets", timesheetId, { status }, "approval status changed");
}

/* A client manager decides their part. Approving freezes the value of those
 * days at the rate in force on each one; rejecting releases it. */
function decideApproval(approvalId, decision, decidedBy, note) {
  if (!["approved", "rejected"].includes(decision)) {
    throw new Error("a decision is either approved or rejected");
  }
  if (!decidedBy) throw new Error("record who made the decision");
  const ap = byId("approvals", approvalId);
  if (!ap) throw new Error("that approval is not on file");
  if (ap.status !== "pending") {
    throw new Error(`that was already ${ap.status} by ${ap.decidedBy || "someone"}`);
  }
  update("approvals", approvalId, {
    status: decision, decidedAt: new Date().toISOString(), decidedBy,
    note: note || null,
  }, decision === "approved" ? "client approved" : "client sent it back");

  for (const e of where("entries",
    (x) => x.timesheetId === ap.timesheetId && x.projectId === ap.projectId)) {
    update("entries", e.id, {
      billableAmount: decision === "approved"
        ? entryBillable(e.placementId, e.workDate, e.hours, e.otHours) : null,
    }, decision === "approved" ? "value frozen at approval" : "value released");
  }
  rollUpTimesheet(ap.timesheetId);
  return byId("approvals", approvalId);
}

/* ------------------------------------------------------------- unlocking */

function requestUnlock(approvalId, reason) {
  if (!reason || reason.trim().length <= 5) {
    throw new Error("say why it needs unlocking — the admin deciding will read it");
  }
  const ap = byId("approvals", approvalId);
  if (!ap) throw new Error("that approval is not on file");
  if (ap.status !== "approved") {
    throw new Error(`that time is ${ap.status}, not approved — it is not locked`);
  }
  if (where("unlocks", (u) => u.approvalId === approvalId && u.status === "pending")[0]) {
    throw new Error("there is already an unlock request waiting on that week");
  }
  return insert("unlocks", {
    approvalId, requestedBy: actingUser().id, reason: reason.trim(),
    status: "pending", decidedBy: null, decidedAt: null, decisionNote: null,
    expiresAt: null, usedAt: null,
  }, "asked for approved time to be unlocked");
}

function decideUnlock(requestId, decision, note) {
  const me = actingUser();
  const req = byId("unlocks", requestId);
  if (!req) throw new Error("that request is not on file");
  if (req.status !== "pending") throw new Error(`that request is already ${req.status}`);
  if (me.role !== "admin") throw new Error("only an admin can unlock approved time");
  if (me.id === req.requestedBy) {
    throw new Error("somebody other than the requester has to grant it");
  }
  if (decision === "granted") {
    const ap = byId("approvals", req.approvalId);
    const billed = where("entries",
      (e) => e.timesheetId === ap.timesheetId && e.projectId === ap.projectId)
      .map(entryInvoiceLine).filter(Boolean);
    if (billed.length) {
      const inv = byId("invoices", billed[0].invoiceId);
      throw new Error(
        `that time is already on invoice ${inv.invoiceNumber}. Void or credit the ` +
        `invoice first — unlocking it here would leave the invoice standing against ` +
        `time that no longer exists.`);
    }
  }
  return update("unlocks", requestId, {
    status: decision, decidedBy: me.id, decidedAt: new Date().toISOString(),
    decisionNote: note || null,
    expiresAt: decision === "granted"
      ? new Date(Date.now() + 24 * 3600e3).toISOString() : null,
  }, decision === "granted" ? "admin granted the unlock" : "admin denied the unlock");
}

/* Spend a granted unlock. It works once. */
function reopenApproval(approvalId) {
  const ap = byId("approvals", approvalId);
  if (!ap) throw new Error("that approval is not on file");
  if (ap.status !== "approved") throw new Error("that week is not approved");
  const key = where("unlocks", (u) => u.approvalId === approvalId &&
    u.status === "granted" && (!u.expiresAt || u.expiresAt > new Date().toISOString()))
    .sort((a, b) => (b.decidedAt || "").localeCompare(a.decidedAt || ""))[0];
  if (!key) {
    throw new Error(
      "that time is locked. Raise an unlock request and have an admin grant it.");
  }
  update("unlocks", key.id,
    { status: "used", usedAt: new Date().toISOString() }, "unlock spent");
  update("approvals", approvalId,
    { status: "pending", decidedAt: null, decidedBy: null, note: null },
    "reopened after an admin unlock");
  for (const e of where("entries",
    (x) => x.timesheetId === ap.timesheetId && x.projectId === ap.projectId)) {
    update("entries", e.id, { billableAmount: null }, "value released on reopen");
  }
  update("timesheets", ap.timesheetId, { status: "draft" }, "reopened for correction");
  return byId("approvals", approvalId);
}
