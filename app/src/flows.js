
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
