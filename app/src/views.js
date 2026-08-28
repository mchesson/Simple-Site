
/* ------------------------------------------------------------------- views */

const TITLES = {
  home: "Desk", accounts: "Accounts", account: "Account", location: "Site",
  contacts: "Contacts", contact: "Contact", projects: "Projects", project: "Project",
  documents: "Documents", pos: "Purchase orders", timesheet: "My week",
  approvals: "Approvals", invoices: "Invoices", invoice: "Invoice",
  unlocks: "Unlock requests", audit: "Audit trail",
  pipeline: "Pipeline", submission: "Submission", interviews: "Interviews",
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

  const coming = upcomingInterviews(14, who);
  const noWriteUp = interviewsAwaitingFeedback(who);

  const kpi = (k, v, sub, tone, onclick) => el(onclick ? "button" : "div",
    { class: "kpi" + (tone ? " " + tone : "") + (onclick ? " clickable" : ""),
      onclick: onclick || null },
    el("div", { class: "k" }, k), el("div", { class: "v" }, v),
    sub ? el("div", { class: "meta", style: "font-size:11.5px" }, sub) : null);

  return el("div", {},
    el("div", { class: "kpis" },
      kpi("Seats to fill", sum(seats, (r) => r.open),
          `${seats.length} project${seats.length === 1 ? "" : "s"}`),
      kpi("Nobody submitted", noSubs.length, "no candidate out yet",
          noSubs.length ? "alarm" : null),
      kpi("With the client", waiting.length,
          waiting.length ? `oldest ${waiting[0].waiting} days` : "nothing out",
          null, () => go("pipeline")),
      kpi("Interviews booked", coming.length,
          coming.length ? "next " + new Date(coming[0].scheduledAt).toLocaleDateString(
            undefined, { month: "short", day: "numeric" }) : "none this fortnight",
          null, () => go("interviews")),
      kpi("No write-up", noWriteUp.length, "interviews with no outcome",
          noWriteUp.length ? "alarm" : null, () => go("interviews")),
      kpi("Going quiet", cold.length, "no contact in 14 days",
          cold.length ? "alarm" : null),
      kpi("Coming free", off.length, "within 60 days")),

    noWriteUp.length
      ? deskSection("Interviews nobody has written up",
          "Until somebody records what was said, the submission cannot move. This is " +
          "the quietest way a placement is lost.",
          el("table", { class: "grid" },
            el("thead", {},
              el("tr", {}, ...["Candidate", "Where", "When", "Waiting", ""]
                .map((h) => el("th", {}, h)))),
            el("tbody", {}, ...noWriteUp.map((r) => actionRow([
              el("td", {}, el("strong", {}, r.sub.contact.fullName)),
              el("td", { class: "muted" },
                `${r.sub.account ? r.sub.account.name : ""} · ${r.sub.project.name}`),
              el("td", { class: "muted" }, new Date(r.scheduledAt).toLocaleDateString(
                undefined, { weekday: "short", month: "short", day: "numeric" })),
              el("td", {}, ageChip(r.daysAgo, 3)),
              el("td", {}, el("button", { class: "linkbtn", onclick: (e) => {
                e.stopPropagation(); outcomeFlow(r.id);
              } }, "Record it")),
            ], { urgent: r.daysAgo >= 3,
                 onclick: () => go("submission", r.sub.id) })))))
      : null,

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
        "Approves time on " + approvesOn.map((p) => p.name).join(", ")) : null,
      c.isCandidate
        ? el("div", { class: "rowbtns" },
            el("button", { class: "send",
              onclick: () => submitFlow({ contactId: id }) }, "Put them forward"))
        : null),

    section("Where they are out", (() => {
      const out = board({ contactId: id, openOnly: false });
      if (!out.length) {
        return c.isCandidate
          ? [el("p", { class: "muted" }, "Not submitted anywhere yet.")]
          : [];
      }
      return [el("table", { class: "grid" },
        el("thead", {},
          el("tr", {}, ...["Project", "Stage", "At this stage", "Bill", "Margin", "Why"]
            .map((h) => el("th", {}, h)))),
        el("tbody", {}, ...out.map((r) => el("tr", {
            style: "cursor:pointer",
            class: r.isOpen && r.daysInStage >= 7 ? "urgent" : null,
            onclick: () => go("submission", r.id) },
          el("td", {}, el("strong", {}, r.project.name),
            el("div", { class: "meta" }, r.account ? r.account.name : "")),
          el("td", {}, el("span", { class: "pill" + (r.isOpen ? "" : " muted") },
            r.stageLabel)),
          el("td", {}, r.isOpen ? ageChip(r.daysInStage, 7)
            : el("span", { class: "muted" }, "closed")),
          el("td", { class: "num" }, r.billRate ? money2(r.billRate) : "\u2014"),
          el("td", {}, gmChip(r.gmPct)),
          el("td", { class: "muted" }, r.loss ? r.loss.label : "")))))];
    })()),

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

    section("Who is out for this", (() => {
      const out = board({ projectId: id, openOnly: false });
      const head = el("div", { class: "rowbtns", style: "margin-bottom:10px" },
        el("button", { class: "send",
          onclick: () => submitFlow({ projectId: id }) }, "Submit somebody"));
      if (!out.length) {
        return [head, el("p", { class: "muted" },
          "Nobody has been put forward yet. That is the thing that loses a project.")];
      }
      return [head, el("table", { class: "grid" },
        el("thead", {},
          el("tr", {}, ...["Candidate", "Stage", "At this stage", "Pay", "Bill",
            "Margin", "Next"].map((h) => el("th", {}, h)))),
        el("tbody", {}, ...out.map((r) => el("tr", {
            style: "cursor:pointer",
            class: r.isOpen && r.daysInStage >= 7 ? "urgent" : null,
            onclick: () => go("submission", r.id) },
          el("td", {}, el("strong", {}, r.contact.fullName),
            r.contact.headline
              ? el("div", { class: "meta" }, r.contact.headline) : null),
          el("td", {}, el("span", { class: "pill" + (r.isOpen ? "" : " muted") },
            r.stageLabel)),
          el("td", {}, r.isOpen ? ageChip(r.daysInStage, 7)
            : el("span", { class: "muted" }, "closed")),
          el("td", { class: "num" }, r.payRate ? money2(r.payRate) : "\u2014"),
          el("td", { class: "num" }, r.billRate ? money2(r.billRate) : "\u2014"),
          el("td", {}, gmChip(r.gmPct)),
          el("td", { class: "muted" },
            r.nextInterview
              ? `${r.nextInterview.mode} ${new Date(r.nextInterview.scheduledAt)
                  .toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
              : r.loss ? r.loss.label : "")))))];
    })()),

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
