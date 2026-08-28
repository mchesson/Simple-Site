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

const OPEN_STAGES = ["submitted", "client_review", "interview", "offer"];
const STAGE_LABEL = {
  submitted: "Submitted", client_review: "With the client", interview: "Interviewing",
  offer: "Offer out", placed: "Placed", rejected: "Rejected", withdrawn: "Withdrawn",
};

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

/* ------------------------------------------------------------- invoicing */

function nextInvoiceNumber() {
  const year = new Date().getFullYear();
  const n = Math.max(0, ...S.invoices
    .map((i) => Number((i.invoiceNumber.match(/(\d+)$/) || [0, 0])[1]))) + 1;
  return `TS-${year}-${String(n).padStart(4, "0")}`;
}

const invoiceTotals = (invoiceId) => {
  const total = sum(where("invoiceLines", (l) => l.invoiceId === invoiceId),
                    (l) => l.amount);
  const paid = sum(where("payments", (p) => p.invoiceId === invoiceId), (p) => p.amount);
  return { total, paid, outstanding: total - paid };
};

/* The only route from worked time to an invoice line. It cannot pick up time the
 * client has not approved, and it cannot pick up a day already on a live
 * invoice or allocated to a different purchase order. */
function draftInvoice({ purchaseOrderId = null, projectId = null, terms = 45 }) {
  const candidates = where("entries", (e) => {
    if (purchaseOrderId && e.purchaseOrderId !== purchaseOrderId) return false;
    if (projectId && e.projectId !== projectId) return false;
    const a = entryApproval(e);
    return a && a.status === "approved" && !entryInvoiceLine(e);
  }).sort((a, b) => a.workDate.localeCompare(b.workDate));

  if (!candidates.length) {
    return { nothingToBill: true,
             message: "No approved time is waiting to be billed for that." };
  }
  const project = byId("projects", projectId || candidates[0].projectId);
  const inv = insert("invoices", {
    invoiceNumber: nextInvoiceNumber(), accountId: project.accountId,
    projectId: project.id,
    purchaseOrderId: purchaseOrderId || candidates[0].purchaseOrderId || null,
    status: "draft", issueDate: null, dueDate: null, termsDays: terms,
    periodStart: candidates[0].workDate,
    periodEnd: candidates[candidates.length - 1].workDate,
    voidReason: null,
  }, "drafted from approved time");

  let order = 0;
  for (const e of candidates) {
    const contact = byId("contacts", byId("timesheets", e.timesheetId).contactId);
    const po = e.purchaseOrderId ? byId("pos", e.purchaseOrderId) : null;
    const hours = num(e.hours) + num(e.otHours);
    insert("invoiceLines", {
      invoiceId: inv.id, kind: "time", entryId: e.id,
      description: `${contact.fullName} — ${e.workDate}` +
        (po ? ` (${po.poNumber})` : ""),
      quantity: hours, unitRate: hours ? entryValue(e) / hours : null,
      amount: entryValue(e), sortOrder: order++,
    }, "billed");
  }
  return { ...inv, lineCount: candidates.length,
           total: sum(candidates, entryValue) };
}

/* Issuing is what burns the purchase order, which is why the overrun check sits
 * on this transition and not on drafting. */
function sendInvoice(invoiceId, issueDate) {
  const inv = byId("invoices", invoiceId);
  if (!inv) throw new Error("that invoice is not on file");
  if (inv.status !== "draft") throw new Error(`invoice ${inv.invoiceNumber} is already ${inv.status}`);
  const { total } = invoiceTotals(invoiceId);

  if (inv.purchaseOrderId) {
    const po = byId("pos", inv.purchaseOrderId);
    const already = sum(where("invoices", (i) => i.purchaseOrderId === po.id &&
      i.id !== invoiceId && ["sent", "part_paid", "paid"].includes(i.status)),
      (i) => invoiceTotals(i.id).total);
    if (already + total > num(po.amount)) {
      throw new Error(
        `this invoice would put ${po.poNumber} over its limit: ${money(po.amount)} ` +
        `committed, ${money(already)} already invoiced, ${money(total)} on this ` +
        `invoice. Raise a change order or a new PO.`);
    }
  }
  const issue = issueDate || iso(new Date());
  const due = new Date(issue + "T12:00:00");
  due.setDate(due.getDate() + num(inv.termsDays));
  return update("invoices", invoiceId,
    { status: "sent", issueDate: issue, dueDate: iso(due) }, "issued to the client");
}

function recordPayment(invoiceId, amount, method) {
  const inv = byId("invoices", invoiceId);
  if (!inv) throw new Error("that invoice is not on file");
  if (inv.status === "void") throw new Error("that invoice was voided");
  if (inv.status === "draft") throw new Error("that invoice has not been sent yet");
  insert("payments", { invoiceId, amount: num(amount), receivedAt: iso(new Date()),
                       method: method || null, reference: null }, "payment received");
  const { outstanding } = invoiceTotals(invoiceId);
  return update("invoices", invoiceId,
    { status: outstanding <= 0 ? "paid" : "part_paid" }, "payment applied");
}

/* Voiding never deletes. The invoice stays and its days become billable again. */
function voidInvoice(invoiceId, reason) {
  return update("invoices", invoiceId,
    { status: "void", voidReason: reason || null }, "voided");
}

function invoiceAging() {
  const today = iso(new Date());
  return where("invoices", (i) => !["void", "draft"].includes(i.status)).map((i) => {
    const t = invoiceTotals(i.id);
    const overdue = i.dueDate && t.outstanding > 0
      ? Math.max(0, Math.round((new Date(today) - new Date(i.dueDate)) / 864e5)) : 0;
    const bucket = t.outstanding <= 0 ? "settled"
      : !i.dueDate ? "no due date"
      : overdue === 0 ? "current"
      : overdue <= 30 ? "1–30" : overdue <= 60 ? "31–60"
      : overdue <= 90 ? "61–90" : "90+";
    const account = byId("accounts", i.accountId);
    return { ...i, ...t, daysOverdue: overdue, bucket,
             accountName: account ? account.name : "—" };
  }).sort((a, b) => b.daysOverdue - a.daysOverdue);
}

/* ---------------------------------------------------------------- read models */

const activeAccounts = () => where("accounts", (a) => !a.archivedAt);
const ownersOf = (accountId) => where("accountOwners", (o) => o.accountId === accountId)
  .map((o) => ({ ...o, name: (byId("users", o.userId) || {}).name || "—" }));
const contactsOf = (accountId) => where("contacts",
  (c) => c.accountId === accountId && !c.archivedAt);
const locationsOf = (accountId) => where("locations", (l) => l.accountId === accountId);
const projectsOf = (accountId) => where("projects",
  (p) => p.accountId === accountId && !p.archivedAt);

function contactRoles(c) {
  const r = [];
  if (c.isManager) r.push("Manager");
  if (c.isCandidate) r.push("Candidate");
  return r;
}

function projectSummary(p) {
  const account = byId("accounts", p.accountId);
  const location = p.locationId ? byId("locations", p.locationId) : null;
  const placements = where("placements", (x) => x.projectId === p.id);
  return { ...p, accountName: account ? account.name : "—",
           locationName: location ? location.name : null,
           placementCount: placements.filter((x) => x.status === "active").length,
           approvers: where("projectApprovers", (pa) => pa.projectId === p.id)
             .map((pa) => (byId("contacts", pa.contactId) || {}).fullName)
             .filter(Boolean) };
}

function approvalQueue(status = "pending") {
  return where("approvals", (a) => a.status === status).map((a) => {
    const ts = byId("timesheets", a.timesheetId);
    const contact = byId("contacts", ts.contactId);
    const project = byId("projects", a.projectId);
    const account = byId("accounts", project.accountId);
    const entries = where("entries",
      (e) => e.timesheetId === a.timesheetId && e.projectId === a.projectId)
      .sort((x, y) => x.workDate.localeCompare(y.workDate));
    const approver = a.approverContactId ? byId("contacts", a.approverContactId) : null;
    return { ...a, weekEnding: ts.weekEnding, consultant: contact.fullName,
             projectName: project.name, accountName: account.name,
             approverName: approver ? approver.fullName : null,
             hours: sum(entries, (e) => num(e.hours) + num(e.otHours)),
             value: sum(entries, entryValue),
             days: entries.map((e) => ({ workDate: e.workDate,
               hours: num(e.hours) + num(e.otHours),
               poNumber: e.purchaseOrderId
                 ? (byId("pos", e.purchaseOrderId) || {}).poNumber : null })),
             billedOn: entries.map(entryInvoiceLine).filter(Boolean)
               .map((l) => (byId("invoices", l.invoiceId) || {}).invoiceNumber)[0] || null };
  }).sort((a, b) => b.weekEnding.localeCompare(a.weekEnding));
}

function unlockQueue(status = "pending") {
  return where("unlocks", (u) => u.status === status).map((u) => {
    const ap = byId("approvals", u.approvalId);
    const ts = byId("timesheets", ap.timesheetId);
    const contact = byId("contacts", ts.contactId);
    const project = byId("projects", ap.projectId);
    const account = byId("accounts", project.accountId);
    const entries = where("entries",
      (e) => e.timesheetId === ap.timesheetId && e.projectId === ap.projectId);
    return { ...u, weekEnding: ts.weekEnding, consultant: contact.fullName,
             projectName: project.name, accountName: account.name,
             value: sum(entries, entryValue),
             billedLines: entries.map(entryInvoiceLine).filter(Boolean).length,
             requestedByName: (byId("users", u.requestedBy) || {}).name || "—",
             decidedByName: (byId("users", u.decidedBy) || {}).name || null };
  }).sort((a, b) => (b.id || "").localeCompare(a.id || ""));
}

/* ------------------------------------------------------------------- seed */

/* Demo data shaped like the real business: a consultant on two engagements at
 * one client so weeks split, two approving managers so a week can be half
 * approved, and money at every stage from claimed to collected. */
function seedState() {
  const st = {
    v: 5, seeded: true, actingUserId: null,
    users: [], accounts: [], accountOwners: [], locations: [], contacts: [],
    projects: [], projectApprovers: [], placements: [], rates: [], pos: [],
    submissions: [], pipelines: [], pipelineMembers: [],
    timesheets: [], entries: [], approvals: [], unlocks: [],
    invoices: [], invoiceLines: [], payments: [],
    agreements: [], documents: [], activity: [], audit: [],
  };
  S = st;

  const U = (name, email, role) => insert("users", { name, email, role }, "seeded");
  const mark = U("Mark Chesson", "mchesson@technicalsource.com", "admin");
  const rae = U("Rae Lambert", "rae.lambert@technicalsource.com", "account_manager");
  const dev = U("Devon Okafor", "devon.ok@technicalsource.com", "recruiter");
  const sam = U("Sam Iyer", "sam.iyer@technicalsource.com", "delivery");
  // A second admin, so an unlock raised by one of them can still be granted.
  U("Nadia Frost", "nadia.frost@technicalsource.com", "admin");
  st.actingUserId = mark.id;

  const globex = insert("accounts", {
    name: "Globex Manufacturing", status: "active", industry: "Industrial",
    bgCheckPolicy: "7-year county and federal criminal, MVR for any role that drives.",
    drugTestPolicy: "5-panel pre-hire, no THC screen where it is prohibited.",
    onboardingNotes: "Badge photo on day one. Safety orientation before floor access.",
    notes: null, archivedAt: null }, "seeded");
  const initech = insert("accounts", {
    name: "Initech Financial", status: "active", industry: "Financial services",
    bgCheckPolicy: "10-year criminal plus FINRA. Credit check for treasury roles.",
    drugTestPolicy: null, onboardingNotes: null, notes: null, archivedAt: null }, "seeded");
  insert("accounts", { name: "Hooli Health", status: "prospect",
    industry: "Healthcare IT", bgCheckPolicy: null, drugTestPolicy: null,
    onboardingNotes: null, notes: null, archivedAt: null }, "seeded");

  insert("accountOwners", { accountId: globex.id, userId: rae.id,
    role: "account_manager", splitPct: 60 }, "seeded");
  insert("accountOwners", { accountId: globex.id, userId: dev.id,
    role: "recruiter", splitPct: 40 }, "seeded");
  insert("accountOwners", { accountId: initech.id, userId: mark.id,
    role: "account_manager", splitPct: 100 }, "seeded");

  const austin = insert("locations", { accountId: globex.id,
    name: "Globex Austin Plant", address1: "4400 Tech Ridge Blvd", city: "Austin",
    state: "TX", postalCode: "78753",
    rulesOfEngagement: "All reqs route through the plant manager. No direct contact " +
      "with line supervisors. Submittals capped at three per opening.",
    bgCheckNotes: null,
    drugTestNotes: "Site adds a respirator fit test for anyone on the fabrication floor."
  }, "seeded");
  const reno = insert("locations", { accountId: globex.id,
    name: "Globex Reno Distribution", address1: "900 Vassar St", city: "Reno",
    state: "NV", postalCode: "89502",
    rulesOfEngagement: "Reno runs its own approvals. Rates are set by the regional " +
      "director, not the plant.", bgCheckNotes: null, drugTestNotes: null }, "seeded");
  const nyc = insert("locations", { accountId: initech.id, name: "Initech Manhattan",
    city: "New York", state: "NY",
    rulesOfEngagement: "VMS only. Anything submitted outside the VMS is disqualified.",
    address1: null, postalCode: null, bgCheckNotes: null, drugTestNotes: null }, "seeded");

  // Dana is the case that breaks systems built on two tables: the hiring manager
  // at Globex Austin, and someone in our candidate pool.
  const dana = insert("contacts", { fullName: "Dana Reyes", email: "dana.reyes@globex.com",
    phone: "512-555-0143", title: "Plant Engineering Manager", isManager: true,
    isCandidate: true, accountId: globex.id, locationId: austin.id,
    headline: "Plant engineering leader, 14 years in discrete manufacturing",
    skills: ["Operations", "Lean", "SAP PM"], locationText: "Austin, TX",
    onPayroll: false, recruiterId: null, source: "Referral", notes: null,
    archivedAt: null }, "seeded");
  const priya = insert("contacts", { fullName: "Priya Raman", email: "p.raman@globex.com",
    title: "Distribution Director", isManager: true, isCandidate: false,
    accountId: globex.id, locationId: reno.id, phone: null, headline: null, skills: [],
    locationText: null, onPayroll: false, recruiterId: null, source: null, notes: null,
    archivedAt: null }, "seeded");
  const walter = insert("contacts", { fullName: "Walter Nkemdirim", email: "w.nk@initech.com",
    title: "VP Technology", isManager: true, isCandidate: false, accountId: initech.id,
    locationId: nyc.id, phone: null, headline: null, skills: [], locationText: null,
    onPayroll: false, recruiterId: null, source: null, notes: null,
    archivedAt: null }, "seeded");

  const marcus = insert("contacts", { fullName: "Marcus Bell",
    email: "marcus.bell@example.com", phone: "737-555-0110", title: null,
    isManager: false, isCandidate: true, accountId: null, locationId: null,
    headline: "Senior data engineer, 9 years, healthcare and manufacturing",
    skills: ["Python", "Airflow", "dbt", "Snowflake", "SQL"], locationText: "Austin, TX",
    onPayroll: true, recruiterId: dev.id, source: "LinkedIn", notes: null,
    archivedAt: null }, "seeded");
  const jo = insert("contacts", { fullName: "Jo Nakamura", email: "jo.nakamura@example.com",
    isManager: false, isCandidate: true, headline: "Controls engineer, PLC and SCADA",
    skills: ["PLC", "Allen-Bradley", "SCADA", "Ignition"], locationText: "Reno, NV",
    recruiterId: dev.id, source: "Job board", accountId: null, locationId: null,
    phone: null, title: null, onPayroll: false, notes: null, archivedAt: null }, "seeded");
  const tess = insert("contacts", { fullName: "Tess Alvarez", email: "tess.a@example.com",
    isManager: false, isCandidate: true, headline: "Project manager, PMP, ERP rollouts",
    skills: ["PMP", "ERP", "Change management"], locationText: "Remote",
    recruiterId: sam.id, accountId: null, locationId: null, phone: null, title: null,
    onPayroll: false, source: null, notes: null, archivedAt: null }, "seeded");
  const ravi = insert("contacts", { fullName: "Ravi Shah", email: "ravi.shah@example.com",
    isManager: false, isCandidate: true,
    headline: "Data engineer, 6 years, dbt and Snowflake",
    skills: ["Python", "dbt", "Snowflake", "SQL"], locationText: "Austin, TX",
    recruiterId: dev.id, source: "Referral", accountId: null, locationId: null,
    phone: "512-555-0188", title: null, onPayroll: false, notes: null,
    archivedAt: null }, "seeded");
  const nia = insert("contacts", { fullName: "Nia Boateng", email: "nia.b@example.com",
    isManager: false, isCandidate: true, headline: "Controls technician, PLC and HMI",
    skills: ["PLC", "HMI", "Allen-Bradley"], locationText: "Sparks, NV",
    recruiterId: dev.id, source: "Job board", accountId: null, locationId: null,
    phone: null, title: null, onPayroll: false, notes: null,
    archivedAt: null }, "seeded");
  const ben = insert("contacts", { fullName: "Ben Ortiz", email: "b.ortiz@example.com",
    isManager: false, isCandidate: true, headline: "ERP programme manager, finance",
    skills: ["PMP", "ERP", "SAP"], locationText: "Jersey City, NJ",
    recruiterId: sam.id, source: "LinkedIn", accountId: null, locationId: null,
    phone: null, title: null, onPayroll: false, notes: null,
    archivedAt: null }, "seeded");

  const platform = insert("projects", { accountId: globex.id, locationId: austin.id,
    name: "Plant data platform build", deliveryType: "managed_project", status: "open",
    openings: 3, payRateMin: 60, payRateMax: 75, billRateMin: 95, billRateMax: 120,
    startDate: "2026-06-01",
    description: "Stand up the plant telemetry warehouse. Team lead plus two engineers, " +
      "our people, no fixed deliverables — Globex directs the work week to week.",
    skills: ["Python", "Airflow", "Snowflake"], ownerId: sam.id,
    archivedAt: null }, "seeded");
  const line4 = insert("projects", { accountId: globex.id, locationId: reno.id,
    name: "Controls engineer — line 4", deliveryType: "staffing", status: "open",
    openings: 1, payRateMin: 52, payRateMax: 58, billRateMin: 82, billRateMax: 92,
    startDate: "2026-07-06", description: null,
    skills: ["PLC", "Allen-Bradley"], ownerId: dev.id, archivedAt: null }, "seeded");
  const erp = insert("projects", { accountId: initech.id, locationId: nyc.id,
    name: "ERP cutover PMO", deliveryType: "managed_service", status: "open",
    openings: 1, billRateMin: 140, startDate: "2026-10-01", payRateMin: null,
    payRateMax: null, billRateMax: null, description: null, skills: ["PMP", "ERP"],
    ownerId: mark.id, archivedAt: null }, "seeded");
  insert("projects", { accountId: initech.id, locationId: null,
    name: "Director of Analytics (perm)", deliveryType: "direct_hire", status: "open",
    openings: 1, ownerId: mark.id, payRateMin: null, payRateMax: null,
    billRateMin: null, billRateMax: null, startDate: null, description: null,
    skills: [], archivedAt: null }, "seeded");

  insert("projectApprovers", { projectId: platform.id, contactId: dana.id,
    isPrimary: true }, "seeded");
  insert("projectApprovers", { projectId: line4.id, contactId: priya.id,
    isPrimary: true }, "seeded");
  insert("projectApprovers", { projectId: erp.id, contactId: dana.id,
    isPrimary: true }, "seeded");

  const plPlatform = insert("placements", { projectId: platform.id, contactId: marcus.id,
    status: "active", startDate: "2026-06-01", endDate: "2026-12-31",
    recruiterId: dev.id }, "seeded");
  // Ends in six weeks: a redeployment conversation for Devon and an extension
  // conversation for whoever owns Globex.
  const plLine4 = insert("placements", { projectId: line4.id, contactId: marcus.id,
    status: "active", startDate: "2026-07-06", endDate: "2026-10-16",
    recruiterId: dev.id }, "seeded");

  // A correction that supersedes rather than overwrites.
  const first = insert("rates", { placementId: plPlatform.id, rateType: "standard",
    unit: "hour", payRate: 65, billRate: 105, burdenPct: 22,
    effectiveFrom: "2026-06-01", effectiveTo: "2026-08-01",
    supersedesId: null }, "seeded");
  insert("rates", { placementId: plPlatform.id, rateType: "standard", unit: "hour",
    payRate: 68, billRate: 108, burdenPct: 22, effectiveFrom: "2026-08-01",
    effectiveTo: null, supersedesId: first.id }, "seeded");
  insert("rates", { placementId: plLine4.id, rateType: "standard", unit: "hour",
    payRate: 55, billRate: 90, burdenPct: 22, effectiveFrom: "2026-07-06",
    effectiveTo: null, supersedesId: null }, "seeded");

  const poA = insert("pos", { projectId: platform.id, poNumber: "PO-GLX-88412",
    amount: 180000, currency: "USD", startDate: "2026-06-01", endDate: "2026-10-31",
    status: "open", notes: null }, "seeded");
  insert("pos", { projectId: platform.id, poNumber: "PO-GLX-88500", amount: 95000,
    currency: "USD", startDate: "2026-08-01", endDate: "2027-01-31", status: "open",
    notes: null }, "seeded");
  const poB = insert("pos", { projectId: line4.id, poNumber: "PO-GLX-90114",
    amount: 60000, currency: "USD", startDate: "2026-07-06", endDate: "2026-11-30",
    status: "open", notes: null }, "seeded");

  insert("agreements", { accountId: globex.id, locationId: null, kind: "MSA",
    status: "executed", effectiveFrom: "2024-03-01",
    termsNotes: "Net 45. 90-day conversion at 15% of first year salary." }, "seeded");
  insert("agreements", { accountId: globex.id, locationId: null, kind: "rate_sheet",
    status: "executed", effectiveFrom: "2026-01-01",
    termsNotes: "Rates hold through 2026." }, "seeded");
  // Initech's master agreement lapsed at the end of July and nobody noticed.
  insert("agreements", { accountId: initech.id, locationId: null, kind: "MSA",
    status: "executed", effectiveFrom: "2023-08-01", effectiveTo: "2026-07-31",
    termsNotes: "Net 30. Expired - needs renewing before the ERP work starts." },
    "seeded");
  insert("agreements", { accountId: globex.id, locationId: reno.id, kind: "addendum",
    status: "executed", effectiveFrom: "2025-07-01",
    termsNotes: "Reno-specific: 60-day notice on any rate change, overrides the " +
      "master rate sheet." }, "seeded");

  insert("documents", { kind: "resume", title: "Marcus Bell — resume 2026.docx",
    contactId: marcus.id, accountId: null, locationId: null, projectId: null,
    sharepointUrl: null,
    contentText: "Marcus Bell. Senior Data Engineer. Nine years building batch and " +
      "streaming pipelines in healthcare and discrete manufacturing. Python, Airflow, " +
      "dbt, Snowflake, Kafka." }, "seeded");
  insert("documents", { kind: "MSA", title: "Globex MSA — executed 2024-03-01.pdf",
    accountId: globex.id, contactId: null, locationId: null, projectId: null,
    sharepointUrl: "https://technicalsource.sharepoint.com/Shared%20Documents/MSAs/" +
      "Globex/MSA.pdf",
    contentText: "Master Services Agreement between Technical Source and Globex " +
      "Manufacturing. Net 45 payment terms. Conversion fee 15% of first year base " +
      "salary within 90 days." }, "seeded");
  insert("documents", { kind: "exhibit_a",
    title: "Exhibit A — Marcus Bell — plant data platform.pdf", projectId: platform.id,
    accountId: null, locationId: null, contactId: null, sharepointUrl: null,
    contentText: "Rate verification. Marcus Bell. Bill rate 108.00/hr effective " +
      "2026-08-01. Confirmed by Dana Reyes, Globex Manufacturing." }, "seeded");

  // The same human logged twice, wearing a different hat each time.
  insert("activity", { contactId: dana.id, accountId: globex.id, projectId: null,
    asRole: "manager", kind: "call",
    body: "Dana walked through the line 4 controls gap. Wants a body on site before " +
      "the October shutdown. Confirmed three-submittal cap still applies.",
    actorId: rae.id, occurredAt: "2026-08-26T15:10:00.000Z" }, "seeded");
  insert("activity", { contactId: dana.id, accountId: null, projectId: platform.id,
    asRole: "candidate", kind: "note",
    body: "Dana asked to be kept in mind for plant leadership roles outside Globex. " +
      "Not active, would move for the right operations director seat.",
    actorId: dev.id, occurredAt: "2026-08-19T17:30:00.000Z" }, "seeded");
  insert("activity", { contactId: marcus.id, accountId: null, projectId: platform.id,
    asRole: "candidate", kind: "interview",
    body: "Marcus interviewed with the Globex platform team. Strong on Airflow, light " +
      "on Snowflake cost tuning. They want him.",
    actorId: dev.id, occurredAt: "2026-06-14T14:00:00.000Z" }, "seeded");
  insert("activity", { contactId: jo.id, accountId: null, projectId: null,
    asRole: "candidate", kind: "call",
    body: "Jo is on a contract through October. Available after. Wants to stay in Reno.",
    actorId: dev.id, occurredAt: "2026-08-27T16:00:00.000Z" }, "seeded");
  insert("activity", { contactId: nia.id, accountId: null, projectId: line4.id,
    asRole: "candidate", kind: "note",
    body: "Sent Nia's details to Priya for the line 4 opening. Day shift only.",
    actorId: dev.id, occurredAt: "2026-08-24T13:00:00.000Z" }, "seeded");
  insert("activity", { contactId: ben.id, accountId: null, projectId: erp.id,
    asRole: "candidate", kind: "interview",
    body: "Ben screened well on the finance side. Walter wants to meet both him " +
      "and Tess before deciding.",
    actorId: sam.id, occurredAt: "2026-08-26T11:00:00.000Z" }, "seeded");
  // Initech has gone quiet: last contact was six weeks ago.
  insert("activity", { contactId: walter.id, accountId: initech.id, projectId: null,
    asRole: "manager", kind: "meeting",
    body: "Walter confirmed the ERP cutover is funded for October. Wants a PMO " +
      "lead named by mid-September.",
    actorId: mark.id, occurredAt: "2026-07-16T15:00:00.000Z" }, "seeded");

  // -------- submissions: what the recruiters are actually working
  const ago = (days) => new Date(Date.now() - days * 864e5).toISOString();
  const sub = (projectId, contactId, stage, submittedBy, days, rates) =>
    insert("submissions", { projectId, contactId, stage, submittedBy,
      payRate: rates ? rates[0] : null, billRate: rates ? rates[1] : null,
      createdAt: ago(days + 6), stageSince: ago(days) }, "seeded");

  sub(platform.id, marcus.id, "placed", dev.id, 74, [68, 108]);
  // With the client for eleven days and nobody has chased it.
  sub(line4.id, jo.id, "interview", dev.id, 11, [56, 90]);
  sub(line4.id, nia.id, "client_review", dev.id, 4, [52, 86]);
  sub(erp.id, tess.id, "offer", sam.id, 6, [null, 140]);
  sub(erp.id, ben.id, "client_review", sam.id, 2, [null, 140]);
  sub(platform.id, ravi.id, "submitted", dev.id, 1, [62, 100]);
  sub(platform.id, ben.id, "rejected", dev.id, 30, null);

  // -------- named pipelines: how a recruiter remembers people
  const bench = insert("pipelines", { ownerId: dev.id, name: "Reno controls bench",
    projectId: null,
    notes: "People I can move on short notice in northern Nevada" }, "seeded");
  insert("pipelineMembers", { pipelineId: bench.id, contactId: jo.id,
    note: "Free after October", addedAt: ago(20) }, "seeded");
  insert("pipelineMembers", { pipelineId: bench.id, contactId: nia.id,
    note: "Wants day shift only", addedAt: ago(9) }, "seeded");
  insert("pipelineMembers", { pipelineId: bench.id, contactId: marcus.id,
    note: "On payroll, redeployable in October", addedAt: ago(4) }, "seeded");
  const erpBench = insert("pipelines", { ownerId: sam.id, name: "ERP programme leads",
    projectId: erp.id, notes: "Shortlist for the Initech cutover" }, "seeded");
  insert("pipelineMembers", { pipelineId: erpBench.id, contactId: tess.id,
    note: "First choice", addedAt: ago(12) }, "seeded");
  insert("pipelineMembers", { pipelineId: erpBench.id, contactId: ben.id,
    note: "Stronger on finance, weaker on change", addedAt: ago(7) }, "seeded");

  // -------- weeks of time, ending in every state a screen needs to show
  const weekEnd = (offset) => {
    const d = new Date("2026-08-30T12:00:00");
    d.setDate(d.getDate() - offset * 7);
    return iso(d);
  };
  const straight = [[[plPlatform.id, poA.id, 8]], [[plPlatform.id, poA.id, 8]],
    [[plPlatform.id, poA.id, 8]], [[plPlatform.id, poA.id, 8]],
    [[plPlatform.id, poA.id, 8]], [], []];
  const split = [[[plPlatform.id, poA.id, 8]],
    [[plPlatform.id, poA.id, 5], [plLine4.id, poB.id, 3]],
    [[plLine4.id, poB.id, 8]], [[plPlatform.id, poA.id, 8]],
    [[plPlatform.id, poA.id, 6]], [], []];

  function buildWeek(offset, plan) {
    const we = weekEnd(offset);
    const ts = getOrCreateTimesheet(marcus.id, we);
    const rows = [];
    daysOfWeek(we).forEach((d, i) => {
      for (const [placementId, poId, hours] of plan[i] || []) {
        rows.push({ placementId, purchaseOrderId: poId, workDate: d.date, hours });
      }
    });
    saveTimesheet(ts.id, rows);
    return ts;
  }
  function decideAll(ts, decisions) {
    for (const packet of submitTimesheet(ts.id)) {
      const d = decisions[packet.projectId];
      if (d) decideApproval(packet.id, d.status, d.by, d.note);
    }
  }

  for (let i = 12; i >= 3; i--) {
    const ts = buildWeek(i, i % 4 === 2 && i <= 6 ? split : straight);
    decideAll(ts, {
      [platform.id]: { status: "approved", by: "Dana Reyes" },
      [line4.id]: { status: "approved", by: "Priya Raman" },
    });
  }
  // Two weeks ago: Dana has signed off, Priya has not. Half the week is earned.
  decideAll(buildWeek(2, split),
    { [platform.id]: { status: "approved", by: "Dana Reyes" } });
  // Last week: out with the client, nobody has looked.
  decideAll(buildWeek(1, straight), {});
  // This week: still being filled in.
  buildWeek(0, [[[plPlatform.id, poA.id, 8]], [[plPlatform.id, poA.id, 8]],
    [], [], [], [], []]);

  // -------- invoices at every stage
  const billable = where("entries", (e) => {
    const a = entryApproval(e);
    return e.purchaseOrderId === poA.id && a && a.status === "approved";
  }).sort((a, b) => a.workDate.localeCompare(b.workDate));

  function bill(count, status, issued) {
    const take = billable.filter((e) => !entryInvoiceLine(e)).slice(0, count);
    if (!take.length) return null;
    const project = byId("projects", take[0].projectId);
    const inv = insert("invoices", {
      invoiceNumber: nextInvoiceNumber(), accountId: project.accountId,
      projectId: project.id, purchaseOrderId: poA.id, status: "draft",
      issueDate: null, dueDate: null, termsDays: 45,
      periodStart: take[0].workDate, periodEnd: take[take.length - 1].workDate,
      voidReason: null }, "seeded");
    let order = 0;
    for (const e of take) {
      const hours = num(e.hours);
      insert("invoiceLines", { invoiceId: inv.id, kind: "time", entryId: e.id,
        description: `Marcus Bell — ${e.workDate} (PO-GLX-88412)`,
        quantity: hours, unitRate: entryValue(e) / hours, amount: entryValue(e),
        sortOrder: order++ }, "seeded");
    }
    if (status !== "draft") {
      const due = new Date(issued + "T12:00:00");
      due.setDate(due.getDate() + 45);
      update("invoices", inv.id,
        { status, issueDate: issued, dueDate: iso(due) }, "seeded");
    }
    return inv;
  }
  const paidInv = bill(15, "paid", "2026-07-06");
  if (paidInv) {
    insert("payments", { invoiceId: paidInv.id,
      amount: invoiceTotals(paidInv.id).total, receivedAt: "2026-08-14",
      method: "ACH", reference: "GLX-0411" }, "seeded");
  }
  bill(15, "sent", "2026-08-03");
  bill(4, "draft", null);

  st.actingUserId = mark.id;
  st.audit = st.audit.map((a) => ({ ...a, actorLabel: "seed", reason: "demo data" }));
  return st;
}

/* ------------------------------------------------------------------- views */

const TITLES = {
  home: "Desk", accounts: "Accounts", account: "Account", location: "Site",
  contacts: "Contacts", contact: "Contact", projects: "Projects", project: "Project",
  documents: "Documents", pos: "Purchase orders", timesheet: "My week",
  approvals: "Approvals", invoices: "Invoices", invoice: "Invoice",
  unlocks: "Unlock requests", audit: "Audit trail",
};

const UI = { view: "home", sel: null, week: null, who: null,
             auditFilter: {}, drawer: false, desk: null };

function section(title, kids) {
  const body = kids.flat().filter(Boolean).filter((n) => {
    const tb = n.querySelector ? n.querySelector("tbody") : null;
    return !tb || tb.children.length > 0;
  });
  if (!body.length) return null;
  return el("div", { style: "margin:18px 0" },
    el("div", { class: "navsec", style: "padding-left:0" }, title), ...body);
}
const roleChips = (c) => contactRoles(c).map((r) =>
  el("span", { class: "pill", style: "margin-right:5px" }, r));
const cell = (k, v, sub, neg) => el("div", {},
  el("div", { class: "k" }, k),
  el("div", { class: "v" + (neg ? " neg" : "") }, v),
  sub ? el("div", { class: "meta", style: "font-size:11.5px" }, sub) : null);

/* -------------------------------------------------------------------- home
 *
 * The desk. Sales and recruiting are the two jobs that bring work in and find
 * the people to do it, so this page is written for them: not a dashboard of
 * totals, but a short list of things that need a human today, each one a click
 * from the record and from logging what you did about it.
 */

const SALES_ROLES = ["account_manager", "admin"];

function homeView() {
  const me = actingUser();
  const desk = UI.desk || (SALES_ROLES.includes(me.role) ? "sales" : "recruiting");
  // An admin runs the whole business, so they see everything by default. Everyone
  // else starts with their own and can widen.
  const mineOnly = UI.scope === undefined || UI.scope === null
    ? me.role !== "admin" : UI.scope === "mine";

  const seg = (items, current, set) => el("div", { class: "deskswitch" },
    ...items.map(([k, label]) => el("button",
      { class: "seg" + (current === k ? " on" : ""), onclick: () => { set(k); render(); } },
      label)));

  return el("div", { class: "pane" },
    el("div", { class: "deskhead" },
      el("div", {},
        el("h2", { class: "dtitle" },
          desk === "sales" ? "Accounts" : "Your desk"),
        el("p", { class: "dsub" },
          `${me.name} · ` + (desk === "sales"
            ? "what needs a call, and what is at risk"
            : "seats to fill, people to chase, and who is coming free"))),
      el("div", { class: "segs" },
        seg([["mine", "Mine"], ["all", "Everyone"]], mineOnly ? "mine" : "all",
            (k) => { UI.scope = k; }),
        seg([["recruiting", "Recruiting"], ["sales", "Sales"]], desk,
            (k) => { UI.desk = k; }))),
    desk === "sales" ? salesDesk(me, mineOnly) : recruitingDesk(me, mineOnly),
    el("details", { class: "tourbox" },
      el("summary", {}, "How the whole cycle works, end to end"),
      tourSteps()));
}

/* A row that a person can act on: what it is, why it matters now, and a way to
 * record what you did. */
function actionRow(cells, opts = {}) {
  return el("tr", { class: opts.urgent ? "urgent" : null,
                    style: opts.onclick ? "cursor:pointer" : null,
                    onclick: opts.onclick || null }, ...cells);
}

function logButton(label, { contactId, accountId = null, projectId = null,
                            kind = "call", prompt: question }) {
  return el("button", { class: "linkbtn", onclick: (e) => {
    e.stopPropagation();
    const body = prompt(question || "What happened?");
    if (!body) return;
    try { logActivity({ contactId, accountId, projectId, kind, body }); commit(); render(); }
    catch (err) { alert(err.message); }
  } }, label);
}

const ageChip = (n, warnAt, unit = "d") => {
  if (n === null || n === undefined) return el("span", { class: "pill bad" }, "never");
  return el("span", { class: "pill" + (n >= warnAt ? " bad" : n >= warnAt / 2 ? " warn" : "") },
    n + unit);
};

/* ------------------------------------------------------------- recruiting */

function recruitingDesk(me, mineOnly) {
  const who = mineOnly ? me.id : null;
  const seats = seatsToFill(who);
  const waiting = waitingOnClient(who);
  const cold = goingCold(14, who);
  const off = rollingOff(60).filter((r) => !mineOnly ||
    r.placement.recruiterId === me.id);
  const pipes = mineOnly ? myPipelines(me.id)
    : S.pipelines.map((pl) => myPipelines(pl.ownerId)).flat()
        .filter((pl, i, a) => a.findIndex((x) => x.id === pl.id) === i);
  const noSubs = seats.filter((r) => r.submitted === 0);
  const nothing = !seats.length && !waiting.length && !cold.length && !off.length;

  const kpi = (k, v, sub, tone) => el("div", { class: "kpi" + (tone ? " " + tone : "") },
    el("div", { class: "k" }, k), el("div", { class: "v" }, v),
    sub ? el("div", { class: "meta", style: "font-size:11.5px" }, sub) : null);

  return el("div", {},
    el("div", { class: "kpis" },
      kpi("Seats to fill", sum(seats, (r) => r.open),
          `${seats.length} project${seats.length === 1 ? "" : "s"}`),
      kpi("Nobody submitted", noSubs.length, "no candidate out yet",
          noSubs.length ? "alarm" : null),
      kpi("With the client", waiting.length,
          waiting.length ? `oldest ${waiting[0].waiting} days` : "nothing out"),
      kpi("Going quiet", cold.length, "no contact in 14 days",
          cold.length ? "alarm" : null),
      kpi("Coming free", off.length, "within 60 days")),

    nothing && mineOnly
      ? el("div", { class: "banner" },
          el("b", {}, "Nothing on your desk. "),
          "That may be because these records are owned by somebody else — " +
          "switch to Everyone above to see the whole business.")
      : null,

    deskSection("Seats to fill", "Least covered first — no submissions is the " +
      "one that loses the req.", seats.length
      ? el("table", { class: "grid" },
          el("thead", {}, el("tr", {}, ...["Project", "Account", "Open", "Out",
            "Delivery", ""].map((h) => el("th", {}, h)))),
          el("tbody", {}, ...seats.map((r) => actionRow([
            el("td", {}, el("strong", {}, r.project.name)),
            el("td", { class: "muted" }, r.account ? r.account.name : "—"),
            el("td", { class: "num" }, r.open),
            el("td", {}, r.submitted
              ? el("span", { class: "num" }, r.submitted)
              : el("span", { class: "pill bad" }, "none")),
            el("td", { class: "muted" }, r.project.deliveryType.replace(/_/g, " ")),
            el("td", { class: "muted" }, (r.project.skills || []).slice(0, 3).join(", ")),
          ], { urgent: r.submitted === 0,
               onclick: () => go("project", r.project.id) })))
        )
      : el("p", { class: "muted" }, "Every open seat has somebody working on it.")),

    deskSection("Waiting on the client",
      "Days since the stage last moved. The old ones need a phone call, not an email.",
      waiting.length
      ? el("table", { class: "grid" },
          el("thead", {}, el("tr", {}, ...["Candidate", "Project", "Stage", "Waiting",
            "Rate", ""].map((h) => el("th", {}, h)))),
          el("tbody", {}, ...waiting.map((r) => actionRow([
            el("td", {}, el("strong", {}, r.contact.fullName)),
            el("td", { class: "muted" },
              `${r.account ? r.account.name : ""} · ${r.project.name}`),
            el("td", {}, el("span", { class: "pill" }, STAGE_LABEL[r.stage] || r.stage)),
            el("td", {}, ageChip(r.waiting, 7)),
            el("td", { class: "num" }, r.billRate ? money2(r.billRate) : "—"),
            el("td", {}, logButton("Log a chase", { contactId: r.contact.id,
              projectId: r.project.id,
              prompt: `What did ${r.account ? r.account.name : "the client"} say about ` +
                      `${r.contact.fullName}?` })),
          ], { urgent: r.waiting >= 7,
               onclick: () => go("contact", r.contact.id) })))
        )
      : el("p", { class: "muted" }, "Nothing is sitting with a client.")),

    deskSection("Going quiet",
      "In play — submitted or on a shortlist — and nobody has spoken to them.",
      cold.length
      ? el("table", { class: "grid" },
          el("thead", {}, el("tr", {}, ...["Candidate", "Headline", "Last contact",
            "Recruiter", ""].map((h) => el("th", {}, h)))),
          el("tbody", {}, ...cold.map((r) => actionRow([
            el("td", {}, el("strong", {}, r.contact.fullName),
              r.contact.onPayroll
                ? el("span", { class: "pill good", style: "margin-left:6px" },
                    "on payroll") : null),
            el("td", { class: "muted" }, r.contact.headline || ""),
            el("td", {}, ageChip(r.quiet, 21)),
            el("td", { class: "muted" },
              (byId("users", r.contact.recruiterId) || {}).name || "house"),
            el("td", {}, logButton("Log a call", { contactId: r.contact.id,
              prompt: `What did ${r.contact.fullName} say?` })),
          ], { urgent: (r.quiet ?? 999) >= 21,
               onclick: () => go("contact", r.contact.id) })))
        )
      : el("p", { class: "muted" }, "Everyone in play has been spoken to recently.")),

    deskSection("Coming free",
      "Assignments ending. Each one is a redeployment now and a gap on the " +
      "account if nobody moves.", off.length
      ? el("table", { class: "grid" },
          el("thead", {}, el("tr", {}, ...["Consultant", "Leaving", "Ends", "Days",
            ""].map((h) => el("th", {}, h)))),
          el("tbody", {}, ...off.map((r) => actionRow([
            el("td", {}, el("strong", {}, r.contact.fullName)),
            el("td", { class: "muted" },
              `${r.account ? r.account.name : ""} · ${r.project.name}`),
            el("td", { class: "muted" }, day(r.placement.endDate)),
            el("td", {}, ageChip(r.left, 30)),
            el("td", {}, logButton("Log a redeployment call",
              { contactId: r.contact.id,
                prompt: `What is ${r.contact.fullName} looking for next?` })),
          ], { urgent: r.left <= 30, onclick: () => go("contact", r.contact.id) })))
        )
      : el("p", { class: "muted" }, "Nobody rolls off in the next two months.")),

    deskSection("Your pipelines",
      "People you have set aside, so you do not search for them twice.",
      pipes.length
      ? el("div", { class: "pipegrid" }, ...pipes.map((pl) =>
          el("div", { class: "card" },
            el("h3", {}, pl.name,
              !mineOnly && pl.ownerId !== me.id
                ? el("span", { class: "muted", style: "font-weight:400" },
                    " · " + ((byId("users", pl.ownerId) || {}).name || ""))
                : null),
            pl.notes ? el("div", { class: "meta" }, pl.notes) : null,
            el("div", { class: "pipemembers" }, ...pl.members.map((m) =>
              el("button", { class: "chip",
                onclick: () => go("contact", m.contact.id) },
                m.contact.fullName,
                m.note ? el("span", {}, " · " + m.note) : null))))))
      : el("p", { class: "muted" },
          "You have no pipelines yet. Tag people from a contact record.")));
}

/* ----------------------------------------------------------------- sales */

function salesDesk(me, mineOnly) {
  const scope = mineOnly ? ownedBy(me.id) : activeAccounts();
  const scopeIds = new Set(scope.map((a) => a.id));
  const inScope = (accountId) => scopeIds.has(accountId);

  const quiet = quietAccounts(21).filter((q) => inScope(q.account.id));
  const gaps = agreementGaps().filter((g) => inScope(g.account.id));
  const expiringPos = poBurndown().filter((p) => {
    const project = byId("projects", p.projectId);
    return project && inScope(project.accountId) &&
      p.daysRemaining !== null && p.daysRemaining <= 90;
  });
  const off = rollingOff(60).filter((r) => r.account && inScope(r.account.id));
  const unstaffed = seatsToFill().filter((r) =>
    r.submitted === 0 && r.account && inScope(r.account.id));
  const prospects = activeAccounts().filter((a) => inScope(a.id) &&
    (a.status === "prospect" || !where("accountOwners", (o) => o.accountId === a.id).length));

  /* One merged list, because a salesperson does not think in categories - they
   * think about who to ring and why. */
  const calls = [
    ...quiet.map((q) => ({
      why: "Gone quiet", detail: `no contact for ${q.quiet ?? "ever"} days` +
        (q.openProjects ? ` · ${q.openProjects} open project(s)` : ""),
      account: q.account, urgency: (q.quiet ?? 999), urgent: (q.quiet ?? 999) >= 30 })),
    ...gaps.map((g) => ({
      why: g.expired ? "Agreement lapsed" : "No agreement",
      detail: g.expired
        ? `MSA ran out ${day(g.msa.effectiveTo)}` +
          (g.openProjects ? ` and there ${g.openProjects === 1 ? "is" : "are"} ` +
            `${g.openProjects} open project(s)` : "")
        : "nothing signed, so we cannot staff it",
      account: g.account, urgency: 500 + g.openProjects * 100, urgent: true })),
    ...expiringPos.map((p) => ({
      why: p.projectedRemaining < 0 ? "PO over-committed" : "PO expiring",
      detail: `${p.poNumber} · ${money(p.remaining)} left · ` +
        `${p.daysRemaining} days` +
        (p.projectedRemaining < 0
          ? ` · already ${money(Math.abs(p.projectedRemaining))} past it` : ""),
      account: byId("accounts", (byId("projects", p.projectId) || {}).accountId),
      projectId: p.projectId,
      urgency: 400 - p.daysRemaining, urgent: p.daysRemaining <= 45 ||
        p.projectedRemaining < 0 })),
    ...off.map((r) => ({
      why: "Assignment ending", detail: `${r.contact.fullName} on ${r.project.name} ` +
        `ends ${day(r.placement.endDate)} · ${r.left} days`,
      account: r.account, contactId: r.contact.id, projectId: r.project.id,
      urgency: 300 - r.left, urgent: r.left <= 30 })),
  ].filter((c) => c.account).sort((a, b) => b.urgency - a.urgency);

  const weekly = sum(scope, (a) => runRate(a.id));
  const kpi = (k, v, sub, tone) => el("div", { class: "kpi" + (tone ? " " + tone : "") },
    el("div", { class: "k" }, k), el("div", { class: "v" }, v),
    sub ? el("div", { class: "meta", style: "font-size:11.5px" }, sub) : null);

  return el("div", {},
    el("div", { class: "kpis" },
      kpi(mineOnly ? "Your accounts" : "Accounts", scope.length,
          `${scope.filter((a) => a.status === "active").length} active`),
      kpi("Margin a week", money(weekly), "at today's rates"),
      kpi("Reasons to call", calls.length,
          calls.filter((c) => c.urgent).length + " urgent",
          calls.some((c) => c.urgent) ? "alarm" : null),
      kpi("Paperwork gaps", gaps.length, "cannot staff without it",
          gaps.length ? "alarm" : null),
      kpi("Unstaffed projects", unstaffed.length, "nobody submitted",
          unstaffed.length ? "alarm" : null)),

    !scope.length
      ? el("div", { class: "banner" },
          el("b", {}, "You do not own any accounts. "),
          "Switch to Everyone above to work the whole book.")
      : null,

    deskSection("Reasons to call", "Ranked by how much it costs to leave it.",
      calls.length
      ? el("table", { class: "grid" },
          el("thead", {}, el("tr", {}, ...["Account", "Why now", "Detail", ""]
            .map((h) => el("th", {}, h)))),
          el("tbody", {}, ...calls.map((c) => {
            const manager = where("contacts", (x) => x.accountId === c.account.id &&
              x.isManager && !x.archivedAt)[0];
            return actionRow([
              el("td", {}, el("strong", {}, c.account.name)),
              el("td", {}, el("span", { class: "pill" + (c.urgent ? " bad" : " warn") },
                c.why)),
              el("td", { class: "muted" }, c.detail),
              el("td", {}, manager
                ? logButton("Log a call", { contactId: c.contactId || manager.id,
                    accountId: c.account.id, projectId: c.projectId || null,
                    prompt: `What did ${manager.fullName} at ${c.account.name} say?` })
                : el("span", { class: "muted" }, "no contact on file")),
            ], { urgent: c.urgent, onclick: () => go("account", c.account.id) });
          }))
        )
      : el("p", { class: "muted" }, "Nothing needs chasing today.")),

    deskSection("Projects nobody is working on",
      "Open on your accounts with no candidate submitted. This is how an account " +
      "quietly goes elsewhere.", unstaffed.length
      ? el("table", { class: "grid" },
          el("thead", {}, el("tr", {}, ...["Project", "Account", "Seats", "Delivery",
            "Skills"].map((h) => el("th", {}, h)))),
          el("tbody", {}, ...unstaffed.map((r) => actionRow([
            el("td", {}, el("strong", {}, r.project.name)),
            el("td", { class: "muted" }, r.account.name),
            el("td", { class: "num" }, r.open),
            el("td", { class: "muted" }, r.project.deliveryType.replace(/_/g, " ")),
            el("td", { class: "muted" }, (r.project.skills || []).join(", ")),
          ], { urgent: true, onclick: () => go("project", r.project.id) })))
        )
      : el("p", { class: "muted" }, "Every open project has somebody out for it.")),

    deskSection("Where the money is",
      "Live consultants and what each account is worth a week in gross margin.",
      el("table", { class: "grid" },
        el("thead", {}, el("tr", {}, ...["Account", "Status", "Open projects",
          "Working", "Margin a week"].map((h) => el("th", {}, h)))),
        el("tbody", {}, ...scope.map((a) => {
          const projects = projectsOf(a.id);
          const working = sum(projects, (p) => activePlacements(p.id).length);
          return actionRow([
            el("td", {}, el("strong", {}, a.name)),
            el("td", {}, el("span", { class: "pill" }, a.status.replace(/_/g, " "))),
            el("td", { class: "num" },
              projects.filter((p) => p.status === "open").length),
            el("td", { class: "num" }, working),
            el("td", { class: "num" }, money(runRate(a.id))),
          ], { onclick: () => go("account", a.id) });
        }))
      )),

    prospects.length
      ? deskSection("Prospects to work",
          "No owner, or no agreement yet.",
          el("table", { class: "grid" }, el("tbody", {},
            ...prospects.map((a) => actionRow([
              el("td", {}, el("strong", {}, a.name)),
              el("td", { class: "muted" }, a.industry || ""),
              el("td", {}, where("accountOwners", (o) => o.accountId === a.id).length
                ? el("span", { class: "muted" }, "owned")
                : el("span", { class: "pill warn" }, "unassigned")),
            ], { onclick: () => go("account", a.id) })))))
      : null);
}

function deskSection(title, blurb, body) {
  if (!body) return null;
  return el("div", { class: "desksec" },
    el("div", { class: "navsec", style: "padding-left:0" }, title),
    blurb ? el("p", { class: "secblurb" }, blurb) : null,
    body);
}

/* The cycle walkthrough, kept but folded away - it is for learning the product,
 * not for running a desk. */
function tourSteps() {
  const step = (title, body, label, go2) => el("li", {},
    el("b", {}, title), el("span", {}, body),
    label ? el("button", { onclick: go2 }, label) : null);
  return el("div", {},
    el("p", { class: "muted", style: "margin:10px 0 14px" },
      "Everything Technical Source does is project-based work. Here is the whole " +
      "chain, from a resource need to money in the bank."),
    el("ol", { class: "steps-list" },
      step("Fill in a week and split a day",
        "Marcus is on two Globex projects, so his Tuesday splits between them.",
        "Open my week", () => go("timesheet")),
      step("Submit it, and see it fork",
        "One approval packet per project, each routed to that project's manager.",
        "Open approvals", () => go("approvals")),
      step("Approve one part and send the other back",
        "Approving freezes those days at the bill rate in force on each one.",
        "Open approvals", () => go("approvals")),
      step("Try to change an approved day",
        "You can't — it is locked, for everyone. The rejected part still is not.",
        "Open my week", () => go("timesheet")),
      step("Unlock it properly",
        "Request an unlock, then switch to an admin in the top left and grant it.",
        "Open unlock requests", () => go("unlocks")),
      step("Bill it and watch the PO",
        "A draft does not burn the purchase order. Issuing it does.",
        "Open purchase orders", () => go("pos")),
      step("Check the trail",
        "Every step you just took is recorded, with who did it.",
        "Open the audit trail", () => go("audit"))));
}

/* ---------------------------------------------------------------- accounts */

function accountsView() {
  const list = activeAccounts();
  return el("div", { class: "pane" },
    el("table", { class: "grid" },
      el("thead", {}, el("tr", {},
        ...["Account", "Status", "Owners", "Sites", "Managers", "Open projects"]
          .map((h) => el("th", {}, h)))),
      el("tbody", {}, ...list.map((a) => {
        const owners = ownersOf(a.id);
        return el("tr", { style: "cursor:pointer", onclick: () => go("account", a.id) },
          el("td", {}, el("strong", {}, a.name)),
          el("td", {}, el("span", { class: "pill" }, a.status.replace(/_/g, " "))),
          el("td", {}, owners.length
            ? owners.map((o) => `${o.name} ${o.splitPct}%`).join(", ")
            : el("span", { class: "muted" }, "unassigned")),
          el("td", { class: "num" }, locationsOf(a.id).length),
          el("td", { class: "num" }, contactsOf(a.id).filter((c) => c.isManager).length),
          el("td", { class: "num" },
            projectsOf(a.id).filter((p) => p.status === "open").length));
      }))));
}

function accountView(id) {
  const a = byId("accounts", id);
  if (!a) return el("div", { class: "pane muted" }, "That account is not on file.");
  const owners = ownersOf(id);
  return el("div", { class: "pane" },
    el("div", { class: "card" },
      el("h3", {}, a.name),
      el("div", { class: "meta" }, [a.industry, a.status].filter(Boolean).join(" · ")),
      owners.length
        ? el("p", {}, "Owned by " + owners.map((o) =>
            `${o.name} (${o.role.replace(/_/g, " ")}, ${o.splitPct}%)`).join(" and "))
        : el("p", { class: "muted" }, "No owner assigned."),
      a.bgCheckPolicy && el("p", {},
        el("strong", {}, "Background check. "), a.bgCheckPolicy),
      a.drugTestPolicy && el("p", {},
        el("strong", {}, "Drug screen. "), a.drugTestPolicy),
      a.onboardingNotes && el("p", {},
        el("strong", {}, "Onboarding. "), a.onboardingNotes)),

    section("Locations", locationsOf(id).map((l) =>
      el("div", { class: "card", style: "cursor:pointer",
                  onclick: () => go("location", l.id) },
        el("h3", {}, l.name),
        el("div", { class: "meta" }, [l.city, l.state].filter(Boolean).join(", "))))),

    section("Contacts", [el("table", { class: "grid" }, el("tbody", {},
      ...contactsOf(id).map((c) => el("tr", { style: "cursor:pointer",
          onclick: () => go("contact", c.id) },
        el("td", {}, el("strong", {}, c.fullName)),
        el("td", { class: "muted" }, c.title || ""),
        el("td", {}, roleChips(c)),
        el("td", { class: "muted" }, c.email || "")))))]),

    section("Projects", [el("table", { class: "grid" }, el("tbody", {},
      ...projectsOf(id).map((p) => el("tr", { style: "cursor:pointer",
          onclick: () => go("project", p.id) },
        el("td", {}, el("strong", {}, p.name)),
        el("td", {}, el("span", { class: "pill" }, p.deliveryType.replace(/_/g, " "))),
        el("td", {}, p.status),
        el("td", { class: "num" }, p.openings)))))]),

    section("Agreements", [el("table", { class: "grid" }, el("tbody", {},
      ...where("agreements", (g) => g.accountId === id).map((g) => el("tr", {},
        el("td", {}, el("strong", {}, g.kind.replace(/_/g, " "))),
        el("td", {}, g.locationId ? "Site specific" : "Account wide"),
        el("td", {}, g.status.replace(/_/g, " ")),
        el("td", { class: "muted" }, g.termsNotes || "")))))]),

    section("Documents", [el("table", { class: "grid" }, el("tbody", {},
      ...where("documents", (d) => d.accountId === id).map((d) => el("tr", {},
        el("td", {}, el("strong", {}, d.title)),
        el("td", {}, d.kind.replace(/_/g, " ")),
        el("td", {}, d.sharepointUrl
          ? el("a", { href: d.sharepointUrl, target: "_blank", rel: "noopener" },
               "Open in SharePoint")
          : el("span", { class: "muted" }, "no filed original"))))))]));
}

function locationView(id) {
  const l = byId("locations", id);
  if (!l) return el("div", { class: "pane muted" }, "That site is not on file.");
  const a = byId("accounts", l.accountId);
  const here = where("contacts", (c) => c.locationId === id && !c.archivedAt);
  return el("div", { class: "pane" },
    el("div", { class: "card" },
      el("h3", {}, l.name),
      el("div", { class: "meta" },
        [l.address1, l.city, l.state, l.postalCode].filter(Boolean).join(", ")),
      l.rulesOfEngagement && el("p", {},
        el("strong", {}, "Rules of engagement. "), l.rulesOfEngagement),
      el("p", {}, el("strong", {}, "Background check. "),
        a.bgCheckPolicy || "No account policy set.",
        l.bgCheckNotes ? " " + l.bgCheckNotes : ""),
      el("p", {}, el("strong", {}, "Drug screen. "),
        a.drugTestPolicy || "No account policy set.",
        l.drugTestNotes ? " " + l.drugTestNotes : ""),
      el("p", { class: "muted" },
        `Screening above comes from ${a.name} and applies here. Site notes add to ` +
        "it; they do not replace it.")),
    section("Contacts at this site", [el("table", { class: "grid" }, el("tbody", {},
      ...here.map((c) => el("tr", { style: "cursor:pointer",
          onclick: () => go("contact", c.id) },
        el("td", {}, el("strong", {}, c.fullName)),
        el("td", { class: "muted" }, c.title || ""),
        el("td", {}, roleChips(c))))))]));
}

/* ---------------------------------------------------------------- contacts */

function contactsView() {
  const list = where("contacts", (c) => !c.archivedAt && (c.isManager || c.isCandidate));
  const lastAt = (c) => where("activity", (x) => x.contactId === c.id)
    .map((x) => x.occurredAt).sort().pop() || null;
  return el("div", { class: "pane" },
    el("table", { class: "grid" },
      el("thead", {}, el("tr", {},
        ...["Name", "Roles", "Where", "Skills", "Last activity"]
          .map((h) => el("th", {}, h)))),
      el("tbody", {}, ...list.map((c) => {
        const acct = c.accountId ? byId("accounts", c.accountId) : null;
        const at = lastAt(c);
        return el("tr", { style: "cursor:pointer", onclick: () => go("contact", c.id) },
          el("td", {}, el("strong", {}, c.fullName),
            c.onPayroll ? el("span", { class: "pill good", style: "margin-left:7px" },
              "On payroll") : null),
          el("td", {}, roleChips(c)),
          el("td", { class: "muted" }, acct ? acct.name : (c.locationText || "")),
          el("td", { class: "muted" }, (c.skills || []).slice(0, 4).join(", ")),
          el("td", { class: "muted" }, at ? day(at.slice(0, 10)) : "—"));
      }))));
}

function contactView(id) {
  const c = byId("contacts", id);
  if (!c) return el("div", { class: "pane muted" }, "That person is not on file.");
  const acct = c.accountId ? byId("accounts", c.accountId) : null;
  const loc = c.locationId ? byId("locations", c.locationId) : null;
  const recruiter = c.recruiterId ? byId("users", c.recruiterId) : null;
  const acts = where("activity", (x) => x.contactId === id)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const approvesOn = where("projectApprovers", (pa) => pa.contactId === id)
    .map((pa) => byId("projects", pa.projectId)).filter(Boolean);
  return el("div", { class: "pane" },
    el("div", { class: "card" },
      el("h3", {}, c.fullName),
      el("div", { class: "meta" }, [c.title, c.headline].filter(Boolean).join(" · ")),
      el("p", {}, roleChips(c),
        c.onPayroll ? el("span", { class: "pill good" },
          "On our payroll" + (recruiter ? " · " + recruiter.name : "")) : null),
      acct && el("p", {}, "Works at ",
        el("a", { href: "#", onclick: (e) => { e.preventDefault(); go("account", acct.id); } },
          acct.name), loc ? ` · ${loc.name}` : ""),
      (c.email || c.phone) && el("p", { class: "muted" },
        [c.email, c.phone].filter(Boolean).join(" · ")),
      (c.skills || []).length ? el("p", {}, c.skills.join(" · ")) : null,
      approvesOn.length ? el("p", { class: "muted" },
        "Approves time on " + approvesOn.map((p) => p.name).join(", ")) : null),
    section("Activity", [el("div", {}, ...acts.map((x) =>
      el("div", { class: "card" },
        el("div", { class: "meta" },
          el("span", { class: "pill" },
            x.asRole === "manager" ? "As manager" : "As candidate"),
          ` ${x.kind} · ${day(x.occurredAt.slice(0, 10))}` +
          (x.actorId ? " · " + (byId("users", x.actorId) || {}).name : "") +
          (x.projectId ? " · " + (byId("projects", x.projectId) || {}).name : "")),
        el("p", { style: "margin:6px 0 0; white-space:pre-wrap" }, x.body))))]),
    section("Documents", [el("table", { class: "grid" }, el("tbody", {},
      ...where("documents", (d) => d.contactId === id).map((d) => el("tr", {},
        el("td", {}, el("strong", {}, d.title)),
        el("td", {}, d.kind.replace(/_/g, " "))))))]));
}

/* ---------------------------------------------------------------- projects */

function projectsView() {
  return el("div", { class: "pane" },
    el("table", { class: "grid" },
      el("thead", {}, el("tr", {},
        ...["Project", "Account", "Delivery", "Status", "Seats", "Placed", "Approver"]
          .map((h) => el("th", {}, h)))),
      el("tbody", {}, ...where("projects", (p) => !p.archivedAt).map((p) => {
        const s = projectSummary(p);
        return el("tr", { style: "cursor:pointer", onclick: () => go("project", p.id) },
          el("td", {}, el("strong", {}, p.name)),
          el("td", { class: "muted" }, s.accountName),
          el("td", {}, el("span", { class: "pill" }, p.deliveryType.replace(/_/g, " "))),
          el("td", {}, p.status),
          el("td", { class: "num" }, p.openings),
          el("td", { class: "num" }, s.placementCount),
          el("td", { class: "muted" }, s.approvers.join(", ") ||
            el("span", { class: "pill bad" }, "none on file")));
      }))));
}

function projectView(id) {
  const p = byId("projects", id);
  if (!p) return el("div", { class: "pane muted" }, "That project is not on file.");
  const s = projectSummary(p);
  const placements = where("placements", (x) => x.projectId === id);
  return el("div", { class: "pane" },
    el("div", { class: "card" },
      el("h3", {}, p.name),
      el("div", { class: "meta" },
        `${s.accountName}${s.locationName ? " · " + s.locationName : ""} · ` +
        `${p.deliveryType.replace(/_/g, " ")} · ${p.status}`),
      p.description && el("p", { style: "white-space:pre-wrap" }, p.description),
      el("p", { class: "muted" },
        `${p.openings} seat${p.openings === 1 ? "" : "s"}` +
        (p.startDate ? ` · starts ${day(p.startDate)}` : "")),
      el("p", {}, el("strong", {}, "Approves time: "),
        s.approvers.length ? s.approvers.join(", ")
          : el("span", { class: "pill bad" },
              "nobody — submitted time here cannot be approved"))),

    section("Placements and rates", placements.map((pl) => {
      const contact = byId("contacts", pl.contactId);
      const rates = where("rates", (r) => r.placementId === pl.id)
        .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
      return el("div", { class: "card" },
        el("h3", {}, contact.fullName),
        el("div", { class: "meta" }, `${pl.status} · started ${day(pl.startDate)}`),
        el("table", { class: "grid", style: "margin-top:8px" },
          el("thead", {}, el("tr", {},
            ...["Effective", "Pay", "Bill", "Burden", "Gross margin", "GM %"]
              .map((h) => el("th", {}, h)))),
          el("tbody", {}, ...rates.map((r) => {
            const m = grossMargin(r.payRate, r.billRate, r.burdenPct);
            return el("tr", {},
              el("td", {}, day(r.effectiveFrom) +
                (r.effectiveTo ? " – " + day(r.effectiveTo) : " – open")),
              el("td", { class: "num" }, money2(r.payRate)),
              el("td", { class: "num" }, money2(r.billRate)),
              el("td", { class: "num" }, r.burdenPct + "%"),
              el("td", { class: "num" }, money2(m.gm)),
              el("td", { class: "num" }, m.gmPct.toFixed(2) + "%"));
          }))),
        el("p", { class: "muted", style: "margin-bottom:0" },
          "Rates are never edited in place. A change writes a new row and closes " +
          "the previous one, so old invoices still reconcile."));
    })),

    section("Purchase orders", poBurndown({ projectId: id }).map((po) => poCard(po))),

    section("Documents", [el("table", { class: "grid" }, el("tbody", {},
      ...where("documents", (d) => d.projectId === id).map((d) => el("tr", {},
        el("td", {}, el("strong", {}, d.title)),
        el("td", {}, d.kind.replace(/_/g, " "))))))]));
}

function documentsView() {
  return el("div", { class: "pane" },
    el("table", { class: "grid" },
      el("thead", {}, el("tr", {},
        ...["Document", "Kind", "Attached to", "Filed original"].map((h) => el("th", {}, h)))),
      el("tbody", {}, ...S.documents.map((d) => {
        const to = d.accountId ? byId("accounts", d.accountId)
          : d.contactId ? byId("contacts", d.contactId)
          : d.projectId ? byId("projects", d.projectId) : null;
        return el("tr", {},
          el("td", {}, el("strong", {}, d.title),
            d.contentText ? el("div", { class: "meta" },
              d.contentText.slice(0, 110) + "…") : null),
          el("td", {}, d.kind.replace(/_/g, " ")),
          el("td", { class: "muted" }, to ? (to.name || to.fullName) : ""),
          el("td", {}, d.sharepointUrl
            ? el("a", { href: d.sharepointUrl, target: "_blank", rel: "noopener" },
                 "Open in SharePoint")
            : el("span", { class: "muted" }, "not filed")));
      }))));
}

/* --------------------------------------------------------- purchase orders */

const leg = (tone, label, amount, opacity) => el("span", {},
  el("i", { style: `background:var(--${tone});opacity:${opacity ?? 1}` }),
  `${label} ${money(amount)}`);

function poCard(po, opts = {}) {
  const amt = num(po.amount) || 1;
  const pct = (n) => Math.max(0, Math.min(100, num(n) / amt * 100));
  const paid = pct(po.paid);
  const billedUnpaid = Math.max(0, pct(po.invoiced) - paid);
  const drafted = pct(po.drafted);
  const earned = pct(po.approvedUnbilled);
  const over = po.projectedRemaining < 0;
  const soon = po.daysRemaining !== null && po.daysRemaining <= 90;

  return el("div", { class: "card" },
    el("h3", {}, po.poNumber),
    el("div", { class: "meta" },
      `${money(po.amount)} committed` +
      (po.daysRemaining !== null
        ? ` · expires ${day(po.endDate)} (${po.daysRemaining} days)` : "")),

    el("div", { class: "stack", style: "margin:11px 0 0" },
      el("i", { class: "paid", style: `width:${paid}%` }),
      el("i", { class: "billed", style: `width:${billedUnpaid}%` }),
      el("i", { class: "draft", style: `width:${drafted}%` }),
      el("i", { class: "earned", style: `width:${earned}%` })),

    num(po.invoiced) || drafted || earned
      ? el("div", { class: "legend" },
          num(po.paid) ? leg("good", "Paid", po.paid) : null,
          num(po.invoiced) - num(po.paid)
            ? leg("accent", "Billed, unpaid", num(po.invoiced) - num(po.paid)) : null,
          drafted ? leg("accent", "Drafted, not sent", po.drafted, .42) : null,
          earned ? leg("warn", "Approved, not billed", po.approvedUnbilled) : null)
      : el("div", { class: "legend" },
          el("span", { class: "muted" }, "Nothing billed against this one yet")),

    el("div", { class: "money" },
      cell("Invoiced", money(po.invoiced),
           `${po.pctInvoiced}% of the PO — this is the burn`),
      cell("Approved, unbilled", money(po.approvedUnbilled),
           "earned, sitting in our queue"),
      cell("Submitted, pending", money(po.submittedPending),
           "not approved, not earned"),
      cell("Remaining", money(po.remaining), "against invoiced"),
      cell("Projected remaining", money(po.projectedRemaining),
           "once the backlog is billed", over)),

    over ? el("p", { class: "pill bad", style: "margin-top:11px" },
      `Already over-committed by ${money(Math.abs(po.projectedRemaining))}`) : null,
    !over && soon ? el("p", { class: "pill warn", style: "margin-top:11px" },
      po.daysRemaining <= 30 ? "Expires within a month" : "Expires within 90 days") : null,

    opts.actions === false ? null
      : el("div", { style: "margin-top:13px;display:flex;gap:8px;flex-wrap:wrap" },
          num(po.approvedUnbilled) > 0
            ? el("button", { class: "send", onclick: () => {
                const r = draftInvoice({ purchaseOrderId: po.id });
                if (r.nothingToBill) return alert(r.message);
                commit(); go("invoice", r.id);
              } }, `Draft an invoice for ${money(po.approvedUnbilled)}`)
            : null,
          el("button", { class: "ghost", onclick: () => go("invoices") }, "Invoices")));
}

function poView() {
  const list = poBurndown();
  return el("div", { class: "pane" }, ...list.map((po) =>
    el("div", {},
      el("div", { class: "navsec", style: "padding-left:0" },
        po.accountName + " · " + po.projectName),
      poCard(po))));
}

/* ------------------------------------------------------------- my week */

function timesheetView() {
  const consultants = where("contacts", (c) => c.onPayroll && !c.archivedAt);
  const who = UI.who || (consultants[0] && consultants[0].id);
  if (!who) {
    return el("div", { class: "pane muted" },
      "Nobody is on payroll yet, so there is no week to fill in.");
  }
  const we = UI.week || iso(weekEndingOf());
  const ts = getOrCreateTimesheet(who, we);
  const targets = allocationTargets(who, we);
  const dates = daysOfWeek(we);
  const editable = ["draft", "rejected"].includes(ts.status);
  const locked = lockedProjectsFor(ts.id);
  const entries = where("entries", (e) => e.timesheetId === ts.id);

  const key = (t) => `${t.placementId}|${t.purchaseOrderId || ""}`;
  const rows = new Map();
  for (const t of targets) rows.set(key(t), { target: t, hours: {} });
  for (const e of entries) {
    const k = `${e.placementId}|${e.purchaseOrderId || ""}`;
    if (!rows.has(k)) {
      const project = byId("projects", e.projectId);
      const account = byId("accounts", project.accountId);
      rows.set(k, { target: { placementId: e.placementId,
        purchaseOrderId: e.purchaseOrderId, projectId: e.projectId,
        projectName: project.name, accountName: account.name,
        poNumber: e.purchaseOrderId ? (byId("pos", e.purchaseOrderId) || {}).poNumber : null },
        hours: {} });
    }
    rows.get(k).hours[e.workDate] = num(e.hours);
  }
  if (!UI.shownRows || UI.shownWeek !== we || UI.shownWho !== who) {
    UI.shownRows = new Set([...rows.entries()]
      .filter(([, r]) => Object.values(r.hours).some((h) => h > 0)).map(([k]) => k));
    if (!UI.shownRows.size && rows.size) UI.shownRows.add([...rows.keys()][0]);
    UI.shownWeek = we; UI.shownWho = who;
  }
  const shown = UI.shownRows;

  const table = el("table", { class: "wk" });
  const dayCards = el("div", { class: "daycards" });
  const totalOut = el("span", { class: "muted" }, "");

  const totals = () => {
    const perDay = {}, perRow = {};
    for (const k of shown) {
      const r = rows.get(k);
      if (!r) continue;
      perRow[k] = 0;
      for (const d of dates) {
        const h = num(r.hours[d.date]);
        perDay[d.date] = (perDay[d.date] || 0) + h;
        perRow[k] += h;
      }
    }
    return { perDay, perRow, week: sum(Object.values(perDay), (x) => x) };
  };

  /* Two layouts over one set of numbers: a grid on a desktop, a card per day on
   * a phone. Both are built once; a keystroke only updates the totals, because
   * rebuilding from inside an input's handler tears out the element that is
   * mid-edit and loses the caret. */
  const rowTotalCells = new Map();
  const dayTotalCells = new Map();
  const dayCardTotals = new Map();
  let weekTotalCell = null;
  let weekCardTotal = null;

  function refreshTotals() {
    const { perDay, perRow, week } = totals();
    for (const [k, td] of rowTotalCells) td.textContent = perRow[k] || "";
    for (const [d, td] of dayTotalCells) {
      td.textContent = perDay[d] || "";
      td.classList.toggle("over", num(perDay[d]) > 24);
    }
    for (const [d, node] of dayCardTotals) {
      const t = perDay[d] || 0;
      node.textContent = t || "";
      node.classList.toggle("over", t > 24);
      const card = node.closest(".daycard");
      if (card) card.classList.toggle("blank", !t);
    }
    if (weekTotalCell) weekTotalCell.textContent = week || "";
    if (weekCardTotal) weekCardTotal.textContent = (week || 0) + " hours";
    totalOut.textContent = week ? `${week} hours this week` : "Nothing entered yet";
  }

  const hourInput = (r, date, label) => {
    const isLocked = locked.has(r.target.projectId);
    const v = r.hours[date] || 0;
    return el("input", {
      class: "h" + (v ? "" : " zero"), type: "number", min: "0", max: "24",
      step: "0.25", inputmode: "decimal", value: v || "",
      "aria-label": label,
      disabled: (!editable || isLocked) ? "" : null,
      oninput: (e) => {
        r.hours[date] = num(e.target.value);
        e.target.classList.toggle("zero", !num(e.target.value));
        refreshTotals();
      },
    });
  };

  const shownRows = () => [...shown].map((k) => ({ k, r: rows.get(k) }))
    .filter((x) => x.r);

  function drawGrid() {
    rowTotalCells.clear(); dayTotalCells.clear();
    table.replaceChildren(
      el("thead", {}, el("tr", {},
        el("th", { class: "tgt" }, "Charged to"),
        ...dates.map((d) => el("th", {}, d.label,
          el("div", { class: "muted", style: "font-weight:400" },
            new Date(d.date + "T12:00:00").toLocaleDateString(undefined,
              { day: "numeric", month: "short" })))),
        el("th", {}, "Total"))),
      el("tbody", {}, ...shownRows().map(({ k, r }) => {
        const isLocked = locked.has(r.target.projectId);
        const rowTotal = el("td", { class: "rowtot" });
        rowTotalCells.set(k, rowTotal);
        return el("tr", {},
          el("td", { class: "tgt" },
            el("strong", {}, r.target.projectName),
            el("span", {},
              [r.target.accountName, r.target.poNumber || "no PO"]
                .filter(Boolean).join(" · "),
              isLocked ? " · approved and locked" : "")),
          ...dates.map((d) => el("td", {},
            hourInput(r, d.date, `${r.target.projectName}, ${d.label}`))),
          rowTotal);
      })),
      el("tfoot", {}, el("tr", {},
        el("td", { class: "tgt" }, "Total"),
        ...dates.map((d) => {
          const td = el("td", { class: "rowtot" });
          dayTotalCells.set(d.date, td);
          return td;
        }),
        weekTotalCell = el("td", { class: "rowtot" }))));
    refreshTotals();
  }

  /* On a phone a week reads as one card per day. Eight columns of number inputs
   * is a spreadsheet, not something you fill in on a train. */
  function drawDayCards() {
    dayCardTotals.clear();
    dayCards.replaceChildren(
      ...dates.map((d) => {
        const dt = el("span", { class: "dt" });
        dayCardTotals.set(d.date, dt);
        return el("div", { class: "daycard" },
          el("div", { class: "dh" },
            el("b", {}, d.label),
            el("span", { class: "dd" },
              new Date(d.date + "T12:00:00").toLocaleDateString(undefined,
                { day: "numeric", month: "short" })),
            dt),
          ...shownRows().map(({ r }) => {
            const isLocked = locked.has(r.target.projectId);
            return el("div", { class: "alloc" },
              el("div", { class: "what" },
                el("strong", {}, r.target.projectName),
                el("span", {}, [r.target.poNumber || "no PO",
                  isLocked ? "approved and locked" : null]
                  .filter(Boolean).join(" · "))),
              hourInput(r, d.date, `${r.target.projectName}, ${d.label}`));
          }));
      }),
      el("div", { class: "weektot" }, "Week total",
        weekCardTotal = el("span", { class: "n" })));
    refreshTotals();
  }

  const narrow = isNarrow();
  if (narrow) drawDayCards(); else drawGrid();

  const unused = targets.filter((t) => !shown.has(key(t)));
  const addRow = el("select", { class: "ghost", onchange: (e) => {
    if (!e.target.value) return;
    shown.add(e.target.value);
    render();
  } }, el("option", { value: "" }, "Charge to another project…"),
     ...unused.map((t) => el("option", { value: key(t) },
       `${t.projectName}${t.poNumber ? " · " + t.poNumber : ""}`)));

  function save(thenSubmit) {
    const out = [];
    for (const k of shown) {
      const r = rows.get(k);
      if (!r || locked.has(r.target.projectId)) continue;
      for (const d of dates) {
        const h = num(r.hours[d.date]);
        if (!h) continue;
        out.push({ placementId: r.target.placementId,
                   purchaseOrderId: r.target.purchaseOrderId || null,
                   workDate: d.date, hours: h });
      }
    }
    try {
      saveTimesheet(ts.id, out);
      if (thenSubmit) {
        const packets = submitTimesheet(ts.id);
        const unrouted = packets.filter((p) => !p.approverContactId);
        if (unrouted.length) {
          alert(`Submitted, but ${unrouted.length} project has no approving manager ` +
                `on file. Somebody has to name one before that part can be approved.`);
        }
      }
      commit();
      UI.shownRows = null;
      render();
    } catch (e) { alert(e.message); }
  }

  const shift = (n) => {
    const d = new Date(we + "T12:00:00");
    d.setDate(d.getDate() + n * 7);
    UI.week = iso(d); UI.shownRows = null; render();
  };

  const packets = where("approvals", (a) => a.timesheetId === ts.id);

  return el("div", { class: "pane" },
    el("div", { class: "wkbar" },
      el("button", { class: "ghost", onclick: () => shift(-1) }, "← Previous"),
      el("strong", {}, "Week ending " +
        new Date(we + "T12:00:00").toLocaleDateString(undefined,
          { day: "numeric", month: "long", year: "numeric" })),
      el("button", { class: "ghost", onclick: () => shift(1) }, "Next →"),
      consultants.length > 1
        ? el("select", { class: "ghost", onchange: (e) => {
            UI.who = e.target.value; UI.shownRows = null; render(); } },
            ...consultants.map((c) => el("option",
              { value: c.id, selected: c.id === who ? "" : null }, c.fullName)))
        : el("span", { class: "muted" }, consultants[0].fullName),
      el("span", { class: "pill" }, ts.status.replace(/_/g, " ")),
      el("span", { class: "grow" }), totalOut),

    narrow ? dayCards : table,

    el("div", { class: "wkbar", style: "margin-top:16px" },
      editable && unused.length ? addRow : null,
      el("span", { class: "grow" }),
      editable ? el("button", { class: "ghost", onclick: () => save(false) },
        "Save draft") : null,
      editable
        ? el("button", { class: "send", onclick: () => save(true) },
            "Submit for approval")
        : el("span", { class: "muted" },
            ts.status === "submitted"
              ? "Waiting on the client. It cannot be changed while it is out."
              : "This week has been decided.")),

    packets.length
      ? section("Approval", packets.map((a) => {
          const project = byId("projects", a.projectId);
          const rowEntries = where("entries",
            (e) => e.timesheetId === ts.id && e.projectId === a.projectId);
          const approver = a.approverContactId
            ? byId("contacts", a.approverContactId) : null;
          return el("div", { class: "packet" },
            el("div", { class: "hd" },
              el("h3", {}, project.name),
              el("span", { class: "pill " + (a.status === "approved" ? "good"
                : a.status === "rejected" ? "bad" : "warn") }, a.status),
              el("span", { class: "muted" },
                `${sum(rowEntries, (e) => num(e.hours) + num(e.otHours))} hours · ` +
                money(sum(rowEntries, entryValue))),
              el("span", { class: "grow" }),
              el("span", { class: "muted" },
                a.decidedBy ? "decided by " + a.decidedBy
                  : approver ? "with " + approver.fullName
                  : "no approver on file")),
            a.note ? el("p", { style: "margin:8px 0 0" }, a.note) : null,
            a.status === "approved"
              ? el("p", { class: "muted", style: "margin:8px 0 0" },
                  "These days are locked. Changing them needs an admin unlock.")
              : null);
        }))
      : null,

    ts.status === "rejected"
      ? el("p", { class: "pill bad", style: "margin-top:12px" },
          "Sent back. Fix the rejected part and submit again — the approved part " +
          "stays as it is.")
      : null);
}

/* ------------------------------------------------------------- approvals */

function approvalsView() {
  const pending = approvalQueue("pending");
  const approved = approvalQueue("approved");
  const rejected = approvalQueue("rejected");

  const card = (a) => {
    const decide = (decision) => {
      const by = a.approverName ||
        prompt("Which manager at the client is deciding?");
      if (!by) return;
      const note = decision === "rejected"
        ? prompt("Why is it going back? The consultant will see this.") : null;
      if (decision === "rejected" && !note) return;
      try { decideApproval(a.id, decision, by, note); commit(); render(); }
      catch (e) { alert(e.message); }
    };
    const askUnlock = () => {
      const reason = prompt("This time is locked. Why does it need to be reopened?");
      if (!reason) return;
      try { requestUnlock(a.id, reason); commit(); go("unlocks"); }
      catch (e) { alert(e.message); }
    };
    return el("div", { class: "packet" },
      el("div", { class: "hd" },
        el("h3", {}, a.consultant),
        el("span", { class: "muted" },
          `week ending ${day(a.weekEnding)} · ${a.projectName}`),
        el("span", { class: "grow" }),
        el("span", {}, el("strong", {}, a.hours + " hours"), " · ", money(a.value))),
      el("div", { class: "meta", style: "margin-top:4px" },
        a.accountName + " · " +
        (a.approverName ? "with " + a.approverName
          : "no approving manager on file")),
      el("div", { class: "days" }, ...a.days.map((d) =>
        el("span", { class: "day" }, shortDay(d.workDate), " ",
          el("b", {}, d.hours), "h"))),
      a.status === "pending"
        ? el("div", { style: "margin-top:12px;display:flex;gap:8px" },
            el("button", { class: "send", onclick: () => decide("approved") },
              "Approve " + money(a.value)),
            el("button", { class: "ghost", onclick: () => decide("rejected") },
              "Send back"))
        : el("div", { style: "margin-top:10px;display:flex;gap:10px;align-items:center;" +
                             "flex-wrap:wrap" },
            el("span", { class: "meta" },
              `${a.status} by ${a.decidedBy || "—"}` + (a.note ? " — " + a.note : "")),
            a.billedOn
              ? el("span", { class: "pill good" }, "billed on " + a.billedOn) : null,
            a.status === "approved"
              ? el("button", { class: "ghost", onclick: askUnlock },
                  "Request an unlock")
              : null));
  };

  const owed = sum(pending, (p) => p.value);
  const unrouted = pending.filter((p) => !p.approverName);

  return el("div", { class: "pane" },
    el("div", { class: "card" },
      el("h3", {}, money(owed) + " waiting on client approval"),
      el("div", { class: "meta" },
        `${pending.length} week${pending.length === 1 ? "" : "s"} of work across ` +
        `${new Set(pending.map((p) => p.projectName)).size} project(s). ` +
        "None of it can be billed until it is approved."),
      unrouted.length
        ? el("p", { class: "pill bad", style: "margin-top:10px" },
            `${unrouted.length} of these has no approving manager on file`)
        : null),
    pending.length ? el("div", {}, ...pending.map(card))
      : el("p", { class: "muted" }, "Nothing is waiting on the client."),
    rejected.length ? section("Sent back", rejected.map(card)) : null,
    approved.length ? section("Approved and locked", approved.slice(0, 8).map(card))
      : null);
}

/* --------------------------------------------------------------- unlocks */

function unlocksView() {
  const pending = unlockQueue("pending");
  const granted = unlockQueue("granted");
  const decided = [...unlockQueue("denied"), ...unlockQueue("used")];
  const me = actingUser();
  const isAdmin = me.role === "admin";

  const decide = (u, decision) => {
    const note = prompt(decision === "granted"
      ? "Note for the record (optional)" : "Why is this being denied?");
    if (decision === "denied" && !note) return;
    try { decideUnlock(u.id, decision, note); commit(); render(); }
    catch (e) { alert(e.message); }
  };

  const card = (u) => el("div", { class: "packet" },
    el("div", { class: "hd" },
      el("h3", {}, u.consultant),
      el("span", { class: "muted" },
        `week ending ${day(u.weekEnding)} · ${u.projectName}`),
      el("span", { class: "grow" }),
      el("span", {}, money(u.value), " locked")),
    el("div", { class: "meta", style: "margin-top:4px" },
      `${u.accountName} · asked by ${u.requestedByName}`),
    el("p", { style: "margin:10px 0 0" }, u.reason),
    u.billedLines > 0
      ? el("p", { class: "pill bad", style: "margin-top:10px" },
          "Already invoiced — this cannot be unlocked until the invoice is voided")
      : null,
    u.status === "pending"
      ? el("div", { style: "margin-top:12px;display:flex;gap:8px;align-items:center;" +
                           "flex-wrap:wrap" },
          isAdmin && u.requestedBy !== me.id
            ? el("button", { class: "send", onclick: () => decide(u, "granted") },
                "Grant the unlock") : null,
          isAdmin && u.requestedBy !== me.id
            ? el("button", { class: "ghost", onclick: () => decide(u, "denied") },
                "Deny") : null,
          !isAdmin
            ? el("span", { class: "muted" },
                "Only an admin can decide this. You are acting as " +
                me.role.replace(/_/g, " ") + " — switch user at the top left.")
            : null,
          isAdmin && u.requestedBy === me.id
            ? el("span", { class: "muted" },
                "You raised this one, so somebody else has to grant it.")
            : null)
      : u.status === "granted"
        ? el("div", { style: "margin-top:12px;display:flex;gap:8px;align-items:center;" +
                             "flex-wrap:wrap" },
            el("span", { class: "pill good" }, "granted by " + (u.decidedByName || "—")),
            el("button", { class: "ghost", onclick: () => {
              try { reopenApproval(u.approvalId); commit(); go("timesheet"); }
              catch (e) { alert(e.message); }
            } }, "Reopen the week now"),
            el("span", { class: "muted" }, "one use only"))
        : el("div", { class: "meta", style: "margin-top:10px" },
            `${u.status}${u.decidedByName ? " by " + u.decidedByName : ""}` +
            (u.decisionNote ? " — " + u.decisionNote : "")));

  return el("div", { class: "pane" },
    el("div", { class: "card" },
      el("h3", {}, "Approved time is locked"),
      el("div", { class: "meta" },
        "Once a client manager approves a week, those days are frozen — nobody can " +
        "change or delete them, including the consultant who entered them. Opening " +
        "them again takes an admin, and the grant works once."),
      !isAdmin
        ? el("p", { class: "pill warn", style: "margin-top:10px" },
            "You are acting as " + me.role.replace(/_/g, " ") +
            ", so you can raise a request but not grant one")
        : null),
    pending.length ? section("Waiting on an admin", pending.map(card))
      : el("p", { class: "muted" }, "No unlock requests are waiting."),
    granted.length ? section("Granted, not yet used", granted.map(card)) : null,
    decided.length ? section("Settled", decided.slice(0, 6).map(card)) : null);
}

/* --------------------------------------------------------------- invoices */

function invoicesView() {
  const aging = invoiceAging();
  const owed = sum(aging, (i) => i.outstanding);
  const late = aging.filter((i) => i.daysOverdue > 0);
  const list = [...S.invoices].sort((a, b) =>
    (b.issueDate || "9999").localeCompare(a.issueDate || "9999") ||
    b.invoiceNumber.localeCompare(a.invoiceNumber));
  return el("div", { class: "pane" },
    el("div", { class: "card" },
      el("h3", {}, money(owed) + " outstanding"),
      el("div", { class: "meta" },
        late.length
          ? `${late.length} invoice${late.length === 1 ? "" : "s"} past due, ` +
            money(sum(late, (i) => i.outstanding))
          : "Nothing past due.")),
    el("table", { class: "grid" },
      el("thead", {}, el("tr", {},
        ...["Invoice", "Account", "PO", "Period", "Total", "Outstanding", "Status"]
          .map((h) => el("th", {}, h)))),
      el("tbody", {}, ...list.map((i) => {
        const t = invoiceTotals(i.id);
        const account = byId("accounts", i.accountId);
        const po = i.purchaseOrderId ? byId("pos", i.purchaseOrderId) : null;
        const age = aging.find((x) => x.id === i.id);
        return el("tr", { style: "cursor:pointer", onclick: () => go("invoice", i.id) },
          el("td", {}, el("strong", {}, i.invoiceNumber)),
          el("td", { class: "muted" }, account ? account.name : "—"),
          el("td", { class: "muted" }, po ? po.poNumber : "—"),
          el("td", { class: "muted" },
            i.periodStart ? `${day(i.periodStart)} – ${day(i.periodEnd)}` : "—"),
          el("td", { class: "num" }, money(t.total)),
          el("td", { class: "num" },
            i.status === "draft" ? "—" : money(t.outstanding)),
          el("td", {}, el("span", {
            class: "pill " + (i.status === "paid" ? "good"
              : age && age.daysOverdue > 0 ? "bad"
              : i.status === "draft" || i.status === "void" ? "" : "warn") },
            i.status === "part_paid" ? "part paid" : i.status,
            age && age.daysOverdue > 0 ? ` · ${age.daysOverdue}d late` : "")));
      }))));
}

function invoiceView(id) {
  const inv = byId("invoices", id);
  if (!inv) return el("div", { class: "pane muted" }, "That invoice is not on file.");
  const t = invoiceTotals(id);
  const account = byId("accounts", inv.accountId);
  const project = inv.projectId ? byId("projects", inv.projectId) : null;
  const po = inv.purchaseOrderId ? byId("pos", inv.purchaseOrderId) : null;
  const lines = where("invoiceLines", (l) => l.invoiceId === id)
    .sort((a, b) => num(a.sortOrder) - num(b.sortOrder));
  const payments = where("payments", (p) => p.invoiceId === id);

  const act = (fn) => { try { fn(); commit(); render(); } catch (e) { alert(e.message); } };

  return el("div", { class: "pane" },
    el("div", { class: "card" },
      el("h3", {}, inv.invoiceNumber),
      el("div", { class: "meta" },
        `${account.name}${project ? " · " + project.name : ""}` +
        (po ? " · " + po.poNumber : "")),
      el("div", { class: "money" },
        cell("Total", money(t.total),
             inv.periodStart ? `${day(inv.periodStart)} – ${day(inv.periodEnd)}` : ""),
        cell("Paid", money(t.paid), payments.length + " payment(s)"),
        inv.status === "draft"
          ? cell("Outstanding", "—", "nothing is owed until it is issued")
          : cell("Outstanding", money(t.outstanding),
                 inv.dueDate ? "due " + day(inv.dueDate) : "no due date")),
      el("div", { style: "margin-top:14px;display:flex;gap:8px;flex-wrap:wrap" },
        inv.status === "draft"
          ? el("button", { class: "send",
              onclick: () => act(() => sendInvoice(id, null)) },
              "Send it — this burns the PO")
          : null,
        ["sent", "part_paid"].includes(inv.status)
          ? el("button", { class: "send", onclick: () => {
              const a = prompt(`Payment amount (outstanding ${money(t.outstanding)})`,
                               String(t.outstanding));
              if (a) act(() => recordPayment(id, Number(a), "ACH"));
            } }, "Record a payment")
          : null,
        !["void", "paid"].includes(inv.status)
          ? el("button", { class: "ghost", onclick: () => {
              const r = prompt("Why is this being voided?");
              if (r) act(() => voidInvoice(id, r));
            } }, "Void")
          : null),
      inv.status === "draft"
        ? el("p", { class: "muted", style: "margin:12px 0 0" },
            "A draft has not gone to the client, so it does not count against the " +
            "purchase order yet.")
        : null,
      inv.status === "void"
        ? el("p", { class: "pill bad", style: "margin-top:12px" },
            "Voided" + (inv.voidReason ? " — " + inv.voidReason : "") +
            ". Its days are billable again.")
        : null),

    section("Lines", [el("table", { class: "grid" },
      el("thead", {}, el("tr", {},
        ...["Description", "Hours", "Rate", "Amount"].map((h) => el("th", {}, h)))),
      el("tbody", {}, ...lines.map((l) => el("tr", {},
        el("td", {}, l.description),
        el("td", { class: "num" }, l.quantity ?? "—"),
        el("td", { class: "num" }, l.unitRate ? money2(l.unitRate) : "—"),
        el("td", { class: "num" }, money(l.amount))))))]),

    section("Payments", [el("table", { class: "grid" }, el("tbody", {},
      ...payments.map((p) => el("tr", {},
        el("td", {}, day(p.receivedAt)),
        el("td", { class: "muted" }, p.method || ""),
        el("td", { class: "num" }, money(p.amount))))))]));
}

/* ------------------------------------------------------------ audit trail */

const AUDIT_ACTION = { insert: "created", update: "changed", delete: "removed" };

function auditView() {
  const f = UI.auditFilter || {};
  let rows = S.audit;
  if (f.action) rows = rows.filter((r) => r.action === f.action);
  if (f.q) {
    const q = f.q.toLowerCase();
    rows = rows.filter((r) =>
      (r.table + " " + JSON.stringify(r.after || r.before || {}) + " " +
       (r.actorLabel || "") + " " + (r.reason || "")).toLowerCase().includes(q));
  }
  const shown = rows.slice(0, 250);

  const label = (r) => {
    const o = r.after || r.before || {};
    return o.name || o.fullName || o.invoiceNumber || o.poNumber || o.title ||
      (o.weekEnding ? "week ending " + o.weekEnding : "") ||
      (o.workDate ? o.workDate : "") || "";
  };

  return el("div", { class: "pane" },
    el("div", { class: "wkbar" },
      el("input", { placeholder: "Search the trail…", value: f.q || "",
        style: "flex:1;max-width:22rem;padding:7px 11px;border:1px solid var(--line);" +
               "border-radius:8px;background:var(--panel);color:var(--ink);font:inherit",
        onkeydown: (e) => {
          if (e.key === "Enter") { UI.auditFilter = { ...f, q: e.target.value }; render(); }
        } }),
      el("select", { class: "ghost", onchange: (e) => {
        UI.auditFilter = { ...f, action: e.target.value }; render(); } },
        ...[["", "Everything"], ["insert", "Created"], ["update", "Changed"],
            ["delete", "Removed"]].map(([v, txt]) =>
          el("option", { value: v, selected: (f.action || "") === v ? "" : null }, txt))),
      el("span", { class: "grow" }),
      el("span", { class: "muted" },
        `${shown.length} of ${rows.length} entr${rows.length === 1 ? "y" : "ies"}`)),

    el("p", { class: "muted", style: "margin:0 0 14px" },
      "Every change goes through one write path that records it, so nothing in the " +
      "page changes without a line here. In the server build this is a database " +
      "trigger, which is stronger: it also catches a change made outside the app."),

    el("table", { class: "grid" },
      el("thead", {}, el("tr", {},
        ...["When", "Who", "What", "Record", "Fields", "Why"].map((h) => el("th", {}, h)))),
      el("tbody", {}, ...shown.map((r) => el("tr", {},
        el("td", { class: "muted", style: "white-space:nowrap" },
          new Date(r.at).toLocaleString(undefined,
            { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })),
        el("td", {}, r.actorLabel || el("span", { class: "muted" }, "unattributed")),
        el("td", {}, AUDIT_ACTION[r.action] || r.action, " ",
          el("strong", {}, TABLE_LABEL[r.table] || r.table)),
        el("td", { class: "muted" }, label(r)),
        el("td", { class: "muted" }, (r.changed || []).join(", ")),
        el("td", { class: "muted" }, r.reason || ""))))));
}

/* ------------------------------------------------------------ persistence */

/* The page is the record. State is embedded in the document, and a change
 * publishes a new version of the page with the new state in it. Read-only
 * viewers keep working; their changes just are not kept. */
let ART = null;
let canWrite = null;          // null = unknown yet
let pendingSave = false;
let savingNote = null;

function noteSaving(text, tone) {
  if (savingNote) savingNote.remove();
  if (!text) { savingNote = null; return; }
  savingNote = el("div", { class: "saving" },
    tone === "bad" ? el("span", { class: "err" }, text) : text);
  document.body.append(savingNote);
  if (tone !== "bad") setTimeout(() => { if (savingNote) noteSaving(null); }, 2200);
}

function serialize() {
  const css = document.getElementById("app-css").textContent;
  const src = document.getElementById("app-src").textContent;
  const esc = (s) => s.replace(/<\/script/gi, "<\\/script");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TS Workspace</title></head><body>
<div id="root"></div>
<script type="text/plain" id="app-css">${esc(css)}<\/script>
<script type="application/json" id="app-state">${
  esc(JSON.stringify(S))}<\/script>
<script type="text/plain" id="app-src">${esc(src)}<\/script>
<script>(${BOOT.toString()})();<\/script>
</body></html>`;
}

/* Called after every change. Batches rapid edits into one publish. */
let saveTimer = null;
function commit() {
  if (!ART) { noteSaving("Preview — changes are not kept"); return; }
  pendingSave = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 700);
}

async function flush() {
  if (!ART || !pendingSave) return;
  pendingSave = false;
  noteSaving("Saving…");
  try {
    await ART.publish(serialize());
    noteSaving("Saved");
  } catch (e) {
    const code = e && (e.code || e.name);
    if (code === "conflict") {
      noteSaving("Someone else saved first — reloading to their version", "bad");
    } else if (code === "not_writer" || code === "not_granted") {
      canWrite = false;
      noteSaving("You can look but not save — this artifact is shared read-only", "bad");
    } else {
      noteSaving("Could not save: " + (e && e.message ? e.message : "unknown"), "bad");
    }
  }
}

/* ---------------------------------------------------------------- routing */

/* Narrow enough that the sidebar has to get out of the way. Matches the CSS
 * breakpoint, and the page re-renders when it changes so the week view can swap
 * between a grid and day cards. */
const narrowQuery = window.matchMedia("(max-width: 860px)");
const isNarrow = () => narrowQuery.matches;
if (narrowQuery.addEventListener) {
  narrowQuery.addEventListener("change", () => { UI.drawer = false; render(); });
}

function go(view, sel) {
  UI.view = view;
  if (sel !== undefined) UI.sel = sel;
  UI.drawer = false;          // navigating closes the drawer
  render();
}

const NAV = [
  ["Workspace", [["home", "My desk"]]],
  ["Records", [["accounts", "Accounts"], ["projects", "Projects"],
               ["contacts", "Contacts"], ["documents", "Documents"]]],
  ["Time and money", [["timesheet", "My week"], ["approvals", "Approvals"],
                      ["unlocks", "Unlock requests"], ["pos", "Purchase orders"],
                      ["invoices", "Invoices"]]],
  ["Governance", [["audit", "Audit trail"]]],
];

function render() {
  const me = actingUser();
  const pendingApprovals = where("approvals", (a) => a.status === "pending").length;
  const pendingUnlocks = where("unlocks", (u) => u.status === "pending").length;

  const nav = el("aside", { class: "nav" + (UI.drawer ? " open" : "") },
    el("div", { class: "brand" },
      el("div", { class: "mark" }, "TS"),
      el("h1", {}, "TS Workspace")),
    el("div", { class: "actbar" },
      el("select", { onchange: (e) => {
        S.actingUserId = e.target.value;
        // Each person's desk defaults to their own view, not whoever was here
        // before. Their week and their filters go with them too.
        UI.desk = null; UI.scope = null; UI.who = null; UI.shownRows = null;
        audit("users", "update", null, me, "switched acting user");
        commit(); render();
      } }, ...S.users.map((u) => el("option",
        { value: u.id, selected: u.id === me.id ? "" : null },
        `${u.name} — ${u.role.replace(/_/g, " ")}`)))),
    ...NAV.flatMap(([group, items]) => [
      el("div", { class: "navsec" }, group),
      ...items.map(([view, label]) => el("button", {
        class: "item" + (UI.view === view ? " on" : ""),
        onclick: () => go(view, null),
      }, label,
        view === "approvals" && pendingApprovals
          ? el("span", { class: "pill warn", style: "margin-left:auto" },
              pendingApprovals) : null,
        view === "unlocks" && pendingUnlocks
          ? el("span", { class: "pill warn", style: "margin-left:auto" },
              pendingUnlocks) : null)),
    ]),
    el("div", { class: "spacer" }),
    el("div", { class: "foot" },
      canWrite === false ? "Read-only view — changes are not kept"
        : ART ? "Changes are saved to this page" : "Preview — changes are not kept"));

  let body;
  try {
    body =
      UI.view === "home" ? homeView() :
      UI.view === "accounts" ? accountsView() :
      UI.view === "account" ? accountView(UI.sel) :
      UI.view === "location" ? locationView(UI.sel) :
      UI.view === "contacts" ? contactsView() :
      UI.view === "contact" ? contactView(UI.sel) :
      UI.view === "projects" ? projectsView() :
      UI.view === "project" ? projectView(UI.sel) :
      UI.view === "documents" ? documentsView() :
      UI.view === "pos" ? poView() :
      UI.view === "timesheet" ? timesheetView() :
      UI.view === "approvals" ? approvalsView() :
      UI.view === "unlocks" ? unlocksView() :
      UI.view === "invoices" ? invoicesView() :
      UI.view === "invoice" ? invoiceView(UI.sel) :
      UI.view === "audit" ? auditView() :
      el("div", { class: "pane muted" }, "Nothing here.");
  } catch (e) {
    body = el("div", { class: "pane" },
      el("div", { class: "card" },
        el("h3", { class: "err" }, "That screen hit a problem"),
        el("p", {}, e && e.message ? e.message : String(e)),
        el("button", { class: "ghost", onclick: () => go("home") }, "Back to start")));
  }

  const menu = el("button", {
    class: "menubtn", "aria-label": "Menu", "aria-expanded": UI.drawer ? "true" : "false",
    onclick: () => { UI.drawer = !UI.drawer; render(); },
    html: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" ' +
          'stroke-width="1.7" stroke-linecap="round" aria-hidden="true">' +
          '<path d="M3 5h14M3 10h14M3 15h14"/></svg>',
  });

  const main = el("main", {},
    el("div", { class: "topbar" },
      menu,
      el("h2", {}, TITLES[UI.view] || ""),
      el("span", { class: "grow" }),
      el("span", { class: "rolechip" }, "acting as " + me.role.replace(/_/g, " "))),
    body);

  const scrim = el("button", {
    class: "scrim" + (UI.drawer ? " on" : ""), "aria-label": "Close menu",
    onclick: () => { UI.drawer = false; render(); },
  });

  // Wide content gets its own scroller so the page body never scrolls sideways.
  for (const t of body.querySelectorAll ? body.querySelectorAll("table") : []) {
    if (t.parentElement && t.parentElement.classList.contains("scrollx")) continue;
    const wrap = el("div", { class: "scrollx" });
    t.replaceWith(wrap);
    wrap.append(t);
  }

  const root = document.getElementById("root");
  root.replaceChildren(el("div", { class: "shell" }, nav, main), scrim);
}

/* ------------------------------------------------------------------- start */

async function start() {
  const raw = document.getElementById("app-state").textContent.trim();
  let loaded = null;
  try { loaded = raw && raw !== "null" ? JSON.parse(raw) : null; } catch { loaded = null; }
  S = loaded && loaded.users && loaded.users.length ? loaded : seedState();
  if (!S.audit) S.audit = [];
  UI.week = iso(weekEndingOf());
  UI.drawer = false;
  render();

  // Capabilities resolve later, never on the first run. The page works without.
  try {
    ART = await window.claude.use("artifact");
    if (ART) canWrite = true;
  } catch { ART = null; }
  render();
}
start();
