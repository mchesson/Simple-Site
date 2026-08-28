
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
