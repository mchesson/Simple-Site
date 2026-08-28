const candidateOptions = () => where("contacts", (c) => c.isCandidate && !c.archivedAt)
  .map((c) => ({ contact: c, status: workStatus(c.id) }))
  .sort((a, b) => {
    const rank = (r) => r.status.code === "bench" ? 0
      : r.status.code === "resource" ? 1
      : (r.status.freeIn ?? 9999) <= 45 ? 2 : 3;
    return rank(a) - rank(b) || a.contact.fullName.localeCompare(b.contact.fullName);
  })
  .map(({ contact: c, status }) => ({
    value: c.id,
    label: c.fullName + (status.label ? ` (${status.label})` : "") +
           (c.headline ? ` — ${c.headline}` : ""),
  }));

const openProjectOptions = () => where("projects", (p) => !p.archivedAt &&
    ["open", "draft"].includes(p.status))
  .map((p) => ({ value: p.id, label: `${(byId("accounts", p.accountId) || {}).name} — ${p.name}` }))
  .sort((a, b) => a.label.localeCompare(b.label));

/* ----------------------------------------------------------- submit a person */

async function submitFlow({ projectId = null, contactId = null } = {}) {
  const project = projectId ? byId("projects", projectId) : null;
  const contact = contactId ? byId("contacts", contactId) : null;
  const fields = [];
  if (!contactId) {
    fields.push({ name: "contactId", label: "Resource", type: "select",
                  options: candidateOptions(), wide: true,
                  hint: "on the bench means a redeployment - ours already, and "
                        + "the cheapest seat you will fill all month" });
  }
  if (!projectId) {
    fields.push({ name: "projectId", label: "For which project", type: "select",
                  options: openProjectOptions(), wide: true });
  }
  const hint = project && (project.billRateMin || project.billRateMax)
    ? `this project is scoped ${project.billRateMin ? money2(project.billRateMin) : "—"}` +
      ` to ${project.billRateMax ? money2(project.billRateMax) : "—"}`
    : null;
  fields.push(
    { name: "payRate", label: "Pay rate", type: "number", step: "0.01", min: "0",
      value: project && project.payRateMax ? project.payRateMax : "",
      hint: "what we pay them, per hour" },
    { name: "billRate", label: "Bill rate", type: "number", step: "0.01", min: "0",
      value: project && project.billRateMin ? project.billRateMin : "",
      hint: hint || "what the client pays us, per hour" },
    { name: "burdenPct", label: "Burden", type: "number", step: "0.5", min: "0",
      value: 22, hint: "as a percentage of pay" },
    { name: "notes", label: "Why this person", type: "textarea", wide: true,
      placeholder: "For whoever reads this next — the account manager, or you in " +
                   "three weeks." });

  const answer = await askFor(
    contact ? `Put ${contact.fullName} forward` : "Submit a resource", fields,
    { submitLabel: "Submit",
      note: project
        ? `${(byId("accounts", project.accountId) || {}).name} · ${project.name}`
        : null,
      onChange: (v) => {
        const m = marginOf(v.payRate, v.billRate, v.burdenPct);
        if (m.gmPct === null) return "Fill in both rates to see what it leaves.";
        const wrap = el("span", {},
          `Gross margin ${money2(m.gm)} an hour, `,
          el("b", { class: m.gmPct < 15 ? "err" : "" }, m.gmPct.toFixed(1) + "%"));
        if (m.gmPct < 15) wrap.append(" — thin for the desk.");
        return wrap;
      } });
  if (!answer) return;

  const out = attempt(() => submitCandidate({
    projectId: projectId || answer.projectId,
    contactId: contactId || answer.contactId,
    payRate: answer.payRate === "" ? null : Number(answer.payRate),
    billRate: answer.billRate === "" ? null : Number(answer.billRate),
    burdenPct: answer.burdenPct === "" ? 0 : Number(answer.burdenPct),
    notes: answer.notes || null,
  }));
  if (out && out.advisories && out.advisories.length) {
    noteSaving("Submitted — " + out.advisories.join("; "), "warn");
  } else if (out) {
    noteSaving("Submitted.", "good");
  }
  if (out) go("submission", out.id);
}

/* ------------------------------------------------------------- move a stage */

async function moveFlow(submissionId, move) {
  const r = submissionRow(byId("submissions", submissionId));
  const target = stageOf(move.to);
  const isLoss = !target.open && !target.won;
  const fields = [];
  if (isLoss) {
    fields.push({ name: "lossReasonCode", label: "Why did we lose it", type: "select",
      wide: true,
      options: LOSS_REASONS.map((l) => ({ value: l.code,
        label: `${l.label} (${l.side === "us" ? "on us" : l.side})` })) });
  }
  if (move.needsReason || isLoss) {
    fields.push({ name: "reason", label: "In your own words", type: "textarea", wide: true,
      placeholder: isLoss
        ? "What the client or the candidate actually said."
        : "Why this is moving. Whoever picks this up next will read it." });
  }

  if (!fields.length) {
    attempt(() => advanceSubmission(submissionId, move.to));
    return;
  }
  const answer = await askFor(`${move.label} — ${r.contact.fullName}`, fields,
    { submitLabel: move.label,
      note: `${r.account ? r.account.name : ""} · ${r.project.name} · ` +
            `at ${r.stageLabel} for ${r.daysInStage} days` });
  if (!answer) return;
  attempt(() => advanceSubmission(submissionId, move.to,
    answer.reason || null, answer.lossReasonCode || null));
}

async function interviewFlow(submissionId) {
  const r = submissionRow(byId("submissions", submissionId));
  const soon = new Date(Date.now() + 2 * DAY);
  // Skip the weekend rather than proposing a Sunday interview.
  while (soon.getDay() === 0 || soon.getDay() === 6) soon.setDate(soon.getDate() + 1);
  const answer = await askFor(`Book an interview — ${r.contact.fullName}`, [
    { name: "date", label: "Date", type: "date", value: iso(soon) },
    { name: "time", label: "Time", type: "time", value: "10:00" },
    { name: "durationMins", label: "Minutes", type: "number", min: "15", value: 60 },
    { name: "mode", label: "How", type: "select", value: "video",
      options: [["video", "Video"], ["phone", "Phone"], ["onsite", "On site"],
                ["panel", "Panel"]].map(([value, label]) => ({ value, label })) },
    { name: "whereText", label: "Where", type: "text", wide: true,
      placeholder: "A link, a room, or the site address and who to ask for." },
    { name: "interviewers", label: "Who from the client", type: "text", wide: true,
      placeholder: "Names and titles, so the candidate knows the room." },
    { name: "prepNotes", label: "What they should know", type: "textarea", wide: true,
      placeholder: "The prep that makes the difference." },
  ], { submitLabel: "Book it",
       note: `${r.account ? r.account.name : ""} · ${r.project.name}` });
  if (!answer) return;
  if (!answer.date) { say("An interview needs a date.", "bad"); return; }
  attempt(() => scheduleInterview({
    submissionId, scheduledAt: `${answer.date}T${answer.time || "10:00"}:00`,
    durationMins: Number(answer.durationMins) || 60, mode: answer.mode,
    whereText: answer.whereText || null, interviewers: answer.interviewers || null,
    prepNotes: answer.prepNotes || null,
  }));
}

async function outcomeFlow(interviewId) {
  const iv = byId("interviews", interviewId);
  const r = submissionRow(byId("submissions", iv.submissionId));
  const answer = await askFor(`Round ${iv.round} — what happened`, [
    { name: "status", label: "Did it happen", type: "select", value: "completed",
      options: [["completed", "Yes, it happened"], ["no_show", "Somebody did not show"],
                ["cancelled", "Cancelled"], ["rescheduled", "Being rescheduled"]]
        .map(([value, label]) => ({ value, label })) },
    { name: "outcome", label: "Where it leaves us", type: "select", value: "advance",
      options: [["advance", "They want to go on"], ["reject", "They passed"],
                ["hold", "On hold"], ["pending", "No word yet"]]
        .map(([value, label]) => ({ value, label })) },
    { name: "feedback", label: "What they actually said", type: "textarea", wide: true,
      rows: 4, placeholder: "Their words, not your summary — it is worth more later." },
  ], { submitLabel: "Record it",
       note: `${r.contact.fullName} · ${r.account ? r.account.name : ""} · ${r.project.name}. ` +
             "Recording this does not move the submission — that is your call, below." });
  if (!answer) return;
  attempt(() => recordInterviewOutcome(interviewId, {
    status: answer.status, outcome: answer.outcome, feedback: answer.feedback || null,
  }));
}

async function placeFlow(submissionId) {
  const r = submissionRow(byId("submissions", submissionId));
  const today = iso(new Date());
  const projectStart = r.project && r.project.startDate ? r.project.startDate : null;
  const answer = await askFor(`Place ${r.contact.fullName}`, [
    { name: "startDate", label: "Start date", type: "date",
      // Never default into the past: a placement that started weeks ago would
      // accept time for weeks nobody worked.
      value: projectStart && projectStart > today ? projectStart : today,
      hint: projectStart && projectStart <= today
        ? "the project started " + day(projectStart) + " - this is a later start"
        : null },
    { name: "endDate", label: "End date", type: "date",
      value: r.project && r.project.endDate ? r.project.endDate : "",
      hint: "leave empty if it is open ended" },
    { name: "payRate", label: "Pay rate", type: "number", step: "0.01",
      value: r.payRate ?? "" },
    { name: "billRate", label: "Bill rate", type: "number", step: "0.01",
      value: r.billRate ?? "" },
    { name: "burdenPct", label: "Burden", type: "number", step: "0.5",
      value: r.burdenPct ?? 22 },
  ], { submitLabel: "Place them",
       note: "This creates the placement and its opening rate, then marks the " +
             "submission placed. From here the assignment is real: time can be " +
             "entered against it and it can be invoiced.",
       onChange: (v) => {
         const m = marginOf(v.payRate, v.billRate, v.burdenPct);
         return m.gmPct === null ? "Both rates are needed."
           : `Gross margin ${money2(m.gm)} an hour, ${m.gmPct.toFixed(1)}%.`;
       } });
  if (!answer) return;
  const out = attempt(() => placeSubmission({
    submissionId, startDate: answer.startDate, endDate: answer.endDate || null,
    payRate: answer.payRate === "" ? null : Number(answer.payRate),
    billRate: answer.billRate === "" ? null : Number(answer.billRate),
    burdenPct: answer.burdenPct === "" ? 0 : Number(answer.burdenPct),
  }));
  if (out) noteSaving("Placed. The assignment can take time from its start date.", "good");
}

/* ------------------------------------------------------------- the board */

const gmChip = (gmPct) => gmPct === null || gmPct === undefined
  ? el("span", { class: "muted" }, "no rate")
  : el("span", { class: "pill" + (gmPct < 15 ? " bad" : gmPct < 22 ? " warn" : " good") },
      gmPct.toFixed(1) + "%");

function subCard(r) {
  const nextIv = r.nextInterview;
  const waiting = r.interviews.some((i) => i.outcome === "pending" &&
    new Date(i.scheduledAt).getTime() < Date.now());
  return el("button", { class: "subcard" + (r.daysInStage >= 7 && r.isOpen ? " stale" : ""),
                        onclick: () => go("submission", r.id) },
    el("div", { class: "sctop" },
      el("strong", {}, r.contact.fullName),
      ageChip(r.daysInStage, 7)),
    el("div", { class: "scmeta" },
      `${r.account ? r.account.name : ""} · ${r.project.name}`),
    el("div", { class: "scfoot" },
      gmChip(r.gmPct),
      r.billRate ? el("span", { class: "muted" }, money2(r.billRate) + " an hour") : null),
    nextIv
      ? el("div", { class: "scnote" },
          `${nextIv.mode} interview ${new Date(nextIv.scheduledAt).toLocaleDateString(
            undefined, { weekday: "short", month: "short", day: "numeric" })}`)
      : waiting
        ? el("div", { class: "scnote warnnote" }, "interview done, no feedback recorded")
        : null,
    r.loss ? el("div", { class: "scnote" }, r.loss.label) : null);
}

function submissionsView() {
  const me = actingUser();
  const mineOnly = UI.subScope === undefined || UI.subScope === null
    ? me.role !== "admin" : UI.subScope === "mine";
  const showClosed = !!UI.subClosed;
  const rows = board({ ownerId: mineOnly ? me.id : null, openOnly: !showClosed });
  const stages = STAGES.filter((st) => showClosed || st.open);
  const f = funnel(mineOnly ? me.id : null);
  const losses = lossBreakdown(120, mineOnly ? me.id : null);

  const seg = (items, current, set) => el("div", { class: "deskswitch" },
    ...items.map(([k, label]) => el("button",
      { class: "seg" + (current === k ? " on" : ""), onclick: () => { set(k); render(); } },
      label)));

  return el("div", { class: "pane" },
    el("div", { class: "deskhead" },
      el("div", {},
        el("h2", { class: "dtitle" }, "Submissions"),
        el("p", { class: "dsub" },
          "Every resource we have out with a client, and how long they have been " +
          "sitting there. The buttons on a submission are the moves the rules allow " +
          "from where it is.")),
      el("div", { class: "segs" },
        seg([["mine", "Mine"], ["all", "Everyone"]], mineOnly ? "mine" : "all",
            (k) => { UI.subScope = k; }),
        seg([["open", "In play"], ["all", "Everything"]], showClosed ? "all" : "open",
            (k) => { UI.subClosed = k === "all"; }),
        el("button", { class: "send", onclick: () => submitFlow() },
          "Submit a resource"))),

    !rows.length
      ? el("div", { class: "banner" },
          el("b", {}, "Nothing out. "),
          mineOnly
            ? "Nothing of yours is in play — switch to Everyone to see the whole desk, " +
              "or put a resource forward."
            : "Nobody has been submitted anywhere yet.")
      : null,

    el("div", { class: "scrollx" },
      el("div", { class: "board", style: `--cols:${stages.length}` },
        ...stages.map((st) => {
          const inStage = rows.filter((r) => r.stage === st.code);
          return el("div", { class: "bcol" },
            el("div", { class: "bhead" },
              el("span", {}, st.label),
              el("span", { class: "bcount" }, inStage.length)),
            ...inStage.map(subCard),
            inStage.length ? null : el("div", { class: "bempty" }, "—"));
        }))),

    section("The funnel", [
      el("div", { class: "card" },
        el("p", { class: "meta", style: "margin:0 0 10px" },
          "Counted from the history, not from where things ended up — a resource " +
          "rejected after two interviews still counts as two interviews. Where the " +
          "number falls away is where the desk is losing."),
        el("table", { class: "grid" },
          el("thead", {},
            el("tr", {}, ...["Stage", "Ever reached", "Sitting there now", ""]
              .map((h) => el("th", {}, h)))),
          el("tbody", {}, ...f.map((r, i) => {
            const top = f[0].reached || 1;
            const drop = i === 0 || !f[i - 1].reached ? null
              : Math.round((1 - r.reached / f[i - 1].reached) * 100);
            return el("tr", {},
              el("td", {}, el("strong", {}, r.label)),
              el("td", { class: "num" }, r.reached),
              el("td", { class: "num" }, r.sittingHere),
              el("td", {},
                el("div", { class: "bar", style: "min-width:120px" },
                  el("i", { style: `width:${Math.round(r.reached / top * 100)}%` })),
                drop !== null && drop > 0
                  ? el("div", { class: "meta" },
                      `lost ${drop}% of the stage above`)
                  : null));
          }))))]),

    losses.length
      ? section("Why we have been losing", [
          el("div", { class: "card" },
            el("p", { class: "meta", style: "margin:0 0 10px" },
              "Last four months. A client reason is a rate and sales conversation, a " +
              "candidate reason is a closing conversation, and one on us is a process " +
              "problem — three different fixes, so they are counted apart."),
            el("table", { class: "grid" },
              el("thead", {},
                el("tr", {}, ...["Reason", "Whose call", "Times",
                  "Average days before we knew"].map((h) => el("th", {}, h)))),
              el("tbody", {}, ...losses.map((l) => el("tr", {},
                el("td", {}, el("strong", {}, l.label)),
                el("td", {},
                  el("span", { class: "pill" }, l.side === "us" ? "on us" : l.side)),
                el("td", { class: "num" }, l.losses),
                el("td", { class: "num" },
                  l.avgDays === null ? "—" : l.avgDays))))))])
      : null);
}

/* ------------------------------------------------------- one submission */

function submissionView(id) {
  const s = byId("submissions", id);
  if (!s) return el("div", { class: "pane muted" }, "That submission is not on file.");
  const r = submissionRow(s);
  const moves = movesFrom(r.stage);
  const history = historyOf(id);
  const placement = where("placements", (p) => p.submissionId === id)[0] || null;

  return el("div", { class: "pane" },
    el("div", { class: "card" },
      el("h3", {}, r.contact.fullName,
        el("span", { class: "pill", style: "margin-left:8px" }, r.stageLabel)),
      el("div", { class: "meta" },
        `${r.account ? r.account.name : ""} · ${r.project.name} · ` +
        `${r.project.deliveryType.replace(/_/g, " ")}`),
      el("div", { class: "money", style: "margin-top:14px" },
        cell("At this stage", r.daysInStage + " days",
             r.daysInStage >= 7 && r.isOpen ? "needs a phone call" : null,
             r.daysInStage >= 7 && r.isOpen),
        cell("Out for", r.daysSinceSubmitted + " days"),
        cell("Pay", r.payRate ? money2(r.payRate) : "—"),
        cell("Bill", r.billRate ? money2(r.billRate) : "—"),
        cell("Gross margin", r.gm === null ? "—" : money2(r.gm),
             r.gmPct === null ? null : r.gmPct.toFixed(1) + "% of bill",
             r.gmPct !== null && r.gmPct < 15)),
      r.notes ? el("p", { style: "white-space:pre-wrap; margin-top:12px" },
        el("strong", {}, "Why this person: "), r.notes) : null,
      r.loss
        ? el("p", { class: "meta" },
            `Lost: ${r.loss.label} — ` +
            (r.loss.side === "us" ? "on us" : `the ${r.loss.side}'s call`))
        : null,
      el("div", { class: "rowbtns" },
        el("button", { class: "linkbtn",
          onclick: () => go("contact", r.contact.id) }, "Open the person"),
        el("button", { class: "linkbtn",
          onclick: () => go("project", r.project.id) }, "Open the project"))),

    el("div", { class: "card" },
      el("h3", {}, "What can happen next"),
      el("p", { class: "meta" },
        moves.length
          ? "These are the only moves the rules allow from " + r.stageLabel +
            ". A move marked with a reason will ask you for one."
          : "This one is finished. There is nothing left to move."),
      el("div", { class: "rowbtns" },
        r.isOpen
          ? el("button", { class: "ghost", onclick: () => interviewFlow(id) },
              "Book an interview")
          : null,
        ...moves.map((m) => {
          const target = stageOf(m.to);
          const isLoss = !target.open && !target.won;
          // Placing goes through the placement form, not a bare stage move: the
          // word follows the record, never the other way round.
          if (target.won) {
            return el("button", { class: "send", onclick: () => placeFlow(id) },
              "Place them");
          }
          return el("button", { class: isLoss ? "ghost danger" : "ghost",
            onclick: () => moveFlow(id, m) },
            m.label, m.needsReason || isLoss
              ? el("span", { class: "needs" }, "needs a reason") : null);
        }))),

    section("Interviews", r.interviews.length
      ? r.interviews.map((iv) => el("div", { class: "card" },
          el("h3", {}, `Round ${iv.round}`,
            el("span", { class: "pill", style: "margin-left:8px" },
              iv.status.replace(/_/g, " ")),
            iv.outcome !== "pending"
              ? el("span", { class: "pill" + (iv.outcome === "reject" ? " bad"
                  : iv.outcome === "advance" ? " good" : " warn"),
                  style: "margin-left:6px" },
                  iv.outcome === "advance" ? "going on"
                    : iv.outcome === "reject" ? "they passed" : iv.outcome)
              : null),
          el("div", { class: "meta" },
            `${iv.mode} · ${new Date(iv.scheduledAt).toLocaleString(undefined,
              { weekday: "long", month: "short", day: "numeric",
                hour: "numeric", minute: "2-digit" })}` +
            ` · ${iv.durationMins} minutes`),
          iv.whereText ? el("p", { class: "meta" }, iv.whereText) : null,
          iv.interviewers
            ? el("p", {}, el("strong", {}, "Client side: "), iv.interviewers) : null,
          iv.prepNotes
            ? el("p", {}, el("strong", {}, "Prep: "), iv.prepNotes) : null,
          iv.feedback
            ? el("p", { style: "white-space:pre-wrap" },
                el("strong", {}, "What they said: "), iv.feedback)
            : null,
          iv.outcome === "pending"
            ? el("div", { class: "rowbtns" },
                el("button", { class: "ghost", onclick: () => outcomeFlow(iv.id) },
                  "Record what happened"))
            : null))
      : [el("p", { class: "muted" }, "No interviews booked.")]),

    placement
      ? section("The placement this became", [el("div", { class: "card" },
          el("h3", {}, "Placement"),
          el("div", { class: "meta" },
            `${placement.status} · starts ${day(placement.startDate)}` +
            (placement.endDate ? ` · ends ${day(placement.endDate)}` : " · open ended")),
          el("p", { class: "meta" },
            "Time can be entered against this from its start date, and what is " +
            "approved on it is what burns the purchase order."))])
      : null,

    section("How it got here", [
      el("div", { class: "card" },
        el("table", { class: "grid" },
          el("thead", {},
            el("tr", {}, ...["When", "Move", "Who", "Why"]
              .map((h) => el("th", {}, h)))),
          el("tbody", {}, ...history.map((e) => el("tr", {},
            el("td", { class: "muted" },
              new Date(e.at).toLocaleDateString(undefined,
                { month: "short", day: "numeric", year: "numeric" })),
            el("td", {}, e.fromStage
              ? `${STAGE_LABEL[e.fromStage]} \u2192 ${STAGE_LABEL[e.toStage]}`
              : "Submitted"),
            el("td", { class: "muted" }, (byId("users", e.actorId) || {}).name || "\u2014"),
            el("td", { class: "muted" }, e.reason || ""))))))]));
}

/* ------------------------------------------------------------- pipelines
 *
 * A recruiter's own categories, which they name themselves. This screen is the
 * other half of recruiting from the submission board: submissions are what is
 * out with a client, and this is what a recruiter has in reserve.
 */

/* What to call somebody's situation in one chip. outCount is how many live
 * submissions they have: being out with a client is not being on assignment, but
 * it is not "available" either, and a recruiter about to ring them should see
 * the difference before they do. */
const statusChip = (st, outCount = 0) => {
  if (st.code === "on_assignment") {
    const warn = st.freeIn !== null && st.freeIn <= 45;
    return el("span", { class: "pill" + (warn ? " warn" : " good") },
      st.freeIn === null ? "on assignment" : `free in ${st.freeIn}d`);
  }
  if (st.code === "starting") return el("span", { class: "pill good" }, st.label);
  if (st.code === "bench") return el("span", { class: "pill warn" }, "on the bench");
  if (outCount) return el("span", { class: "pill" }, "out with a client");
  return el("span", { class: "pill" }, "available");
};

async function newPipelineFlow() {
  const answer = await askFor("New category", [
    { name: "name", label: "Call it", type: "text", wide: true,
      placeholder: "Reno controls bench, PLC people I trust, night shift…" },
    { name: "notes", label: "What goes in it", type: "textarea", wide: true,
      placeholder: "For you, in six months, when you cannot remember why you " +
                   "made this one." },
  ], { submitLabel: "Create it",
       note: "Your own category, named however you think about the work. It holds " +
             "resources you know are good and who are not out working, so you do " +
             "not go looking for them twice." });
  if (!answer) return;
  const pl = attempt(() => createPipeline(answer.name, answer.notes || null));
  if (pl) noteSaving(`Created ${pl.name}.`, "good");
}

async function renamePipelineFlow(pipelineId) {
  const pl = byId("pipelines", pipelineId);
  const answer = await askFor(`Edit ${pl.name}`, [
    { name: "name", label: "Call it", type: "text", wide: true, value: pl.name },
    { name: "notes", label: "What goes in it", type: "textarea", wide: true,
      value: pl.notes || "" },
  ], { submitLabel: "Save" });
  if (!answer) return;
  attempt(() => renamePipeline(pipelineId, answer.name, answer.notes || null));
}

async function addToPipelineFlow(pipelineId, contactId = null) {
  const pl = pipelineId ? byId("pipelines", pipelineId) : null;
  const me = actingUser();
  const mine = pipelinesOwnedBy(me.id);
  const fields = [];

  if (!pipelineId) {
    if (!mine.length) {
      say("You have no categories yet. Make one on the Pipelines screen first.",
        "bad");
      return;
    }
    fields.push({ name: "pipelineId", label: "Which category", type: "select", wide: true,
      options: mine.map((x) => ({ value: x.id, label: x.name })) });
  }
  if (!contactId) {
    const already = new Set(where("pipelineMembers",
      (m) => m.pipelineId === pipelineId).map((m) => m.contactId));
    const options = candidateOptions().filter((o) => !already.has(o.value));
    if (!options.length) {
      say("Everybody on file is already in this one.", "bad");
      return;
    }
    fields.push({ name: "contactId", label: "Who", type: "select", wide: true,
                  options });
  }
  fields.push({ name: "note", label: "Why you are keeping them", type: "textarea",
    wide: true,
    placeholder: "Free after October. Day shift only. Would not send back to Globex." });

  const contact = contactId ? byId("contacts", contactId) : null;
  const answer = await askFor(
    contact ? `Keep ${contact.fullName} in a category` : `Add to ${pl.name}`, fields,
    { submitLabel: "Add",
      note: "The note is the point. It is what you will have forgotten by the time " +
            "this person becomes the answer to something." });
  if (!answer) return;
  const out = attempt(() => addToPipeline(
    pipelineId || answer.pipelineId, contactId || answer.contactId,
    answer.note || null));
  if (out) noteSaving("Added.", "good");
}

function pipelinesView() {
  const me = actingUser();
  const mineOnly = UI.pipeWho === undefined || UI.pipeWho === null
    ? me.role !== "admin" : UI.pipeWho === "mine";
  const pipes = mineOnly ? pipelinesOwnedBy(me.id)
    : [...S.pipelines].sort((a, b) =>
        ((byId("users", a.ownerId) || {}).name || "").localeCompare(
          (byId("users", b.ownerId) || {}).name || "") ||
        a.name.localeCompare(b.name));

  return el("div", { class: "pane" },
    el("div", { class: "deskhead" },
      el("div", {},
        el("h2", { class: "dtitle" }, "Pipelines"),
        el("p", { class: "dsub" },
          "Your own categories, named however you think about the work. They hold " +
          "resources you know are good and who are not out working — so when a " +
          "project lands you go to a list, not to a search.")),
      el("div", { class: "segs" },
        el("div", { class: "deskswitch" },
          ...[["mine", "Mine"], ["all", "Everyone"]].map(([k, label]) =>
            el("button", { class: "seg" + ((mineOnly ? "mine" : "all") === k ? " on" : ""),
                           onclick: () => { UI.pipeWho = k; render(); } }, label))),
        el("button", { class: "send", onclick: () => newPipelineFlow() },
          "New category"))),

    !pipes.length
      ? el("div", { class: "banner" },
          el("b", {}, mineOnly ? "You have no categories yet. " : "Nobody has one yet. "),
          "A category is whatever grouping you actually work from — a site, a skill, " +
          "a shift, people you would put in front of anyone. Make one and tag people " +
          "into it from here or from their record.")
      : null,

    ...pipes.map((pl) => {
      const members = pipelineMembers(pl.id);
      const owner = byId("users", pl.ownerId);
      const project = pl.projectId ? byId("projects", pl.projectId) : null;
      // Free to work on something means not on assignment and not already out
      // with a client, plus anyone rolling off soon enough to matter.
      const free = members.filter((m) =>
        (m.status.code === "on_assignment" &&
         m.status.freeIn !== null && m.status.freeIn <= 45) ||
        (m.status.code !== "on_assignment" && m.status.code !== "starting" &&
         !m.out.length)).length;

      return el("div", { class: "card" },
        el("div", { class: "pipehead" },
          el("div", {},
            el("h3", {}, pl.name),
            el("div", { class: "meta" },
              `${members.length} ${members.length === 1 ? "person" : "people"}` +
              (free ? ` · ${free} free or coming free` : " · nobody free") +
              (owner && !mineOnly ? " · " + owner.name : "") +
              (project ? " · for " + project.name : ""))),
          pl.ownerId === me.id
            ? el("div", { class: "rowbtns", style: "margin:0" },
                el("button", { class: "linkbtn",
                  onclick: () => addToPipelineFlow(pl.id) }, "Add a resource"),
                el("button", { class: "linkbtn",
                  onclick: () => renamePipelineFlow(pl.id) }, "Edit"))
            : null),
        pl.notes ? el("p", { class: "meta", style: "margin:6px 0 0" }, pl.notes) : null,

        members.length
          ? el("table", { class: "grid", style: "margin-top:12px" },
              el("thead", {},
                el("tr", {}, ...["Resource", "Right now", "Last spoken to",
                  "Out with a client", "Why you kept them", ""]
                  .map((h) => el("th", {}, h)))),
              el("tbody", {}, ...members.map((m) => el("tr", {},
                el("td", {},
                  el("button", { class: "linkbtn",
                    onclick: () => go("contact", m.contact.id) }, m.contact.fullName),
                  m.contact.headline
                    ? el("div", { class: "meta" }, m.contact.headline) : null),
                el("td", {}, statusChip(m.status, m.out.length),
                  m.status.label && m.status.code === "on_assignment"
                    ? el("div", { class: "meta" }, m.status.label) : null),
                el("td", {}, ageChip(m.quiet, 21)),
                el("td", { class: "muted" },
                  m.out.length
                    ? m.out.map((s) => `${s.account ? s.account.name : ""} (${s.stageLabel})`)
                        .join(", ")
                    : "—"),
                el("td", { class: "muted" }, m.note || ""),
                el("td", {},
                  el("div", { class: "rowbtns", style: "margin:0" },
                    el("button", { class: "linkbtn",
                      onclick: () => submitFlow({ contactId: m.contact.id }) },
                      "Submit"),
                    pl.ownerId === me.id
                      ? el("button", { class: "linkbtn danger", onclick: async () => {
                          const ok = await askConfirm(
                            `Drop ${m.contact.fullName} out of ${pl.name}?`,
                            "Their record is untouched - this only removes the tag, " +
                            "and the removal is kept in the audit trail.",
                            { confirmLabel: "Drop them", danger: true });
                          if (!ok) return;
                          attempt(() => dropFromPipeline(pl.id, m.contact.id));
                        } }, "Drop")
                      : null)))))) 
          : el("p", { class: "muted", style: "margin:10px 0 0" },
              "Nobody in this one yet."));
    }));
}

/* --------------------------------------------------------------- interviews
 *
 * A recruiter's morning in two lists: what is coming, and what has happened
 * that nobody has written down. The second one is the whole point of the
 * screen - an interview with no recorded outcome is a submission quietly dying.
 */
function interviewsView() {
  const me = actingUser();
  const mineOnly = UI.ivScope === undefined || UI.ivScope === null
    ? me.role !== "admin" : UI.ivScope === "mine";
  const who = mineOnly ? me.id : null;
  const coming = upcomingInterviews(21, who);
  const waiting = interviewsAwaitingFeedback(who);

  const whenText = (iso) => new Date(iso).toLocaleString(undefined,
    { weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit" });

  return el("div", { class: "pane" },
    el("div", { class: "deskhead" },
      el("div", {},
        el("h2", { class: "dtitle" }, "Interviews"),
        el("p", { class: "dsub" },
          "What is booked, and what happened that nobody has written up yet.")),
      el("div", { class: "segs" },
        el("div", { class: "deskswitch" },
          ...[["mine", "Mine"], ["all", "Everyone"]].map(([k, label]) =>
            el("button", { class: "seg" + ((mineOnly ? "mine" : "all") === k ? " on" : ""),
                           onclick: () => { UI.ivScope = k; render(); } }, label))))),

    waiting.length
      ? el("div", { class: "banner warn" },
          el("b", {}, waiting.length === 1
            ? "One interview has happened with nothing written down. "
            : `${waiting.length} interviews have happened with nothing written down. `),
          "Until somebody records what was said, nobody can decide what to do next.")
      : null,

    section("Nobody has written down what happened", waiting.length
      ? [el("table", { class: "grid" },
          el("thead", {},
            el("tr", {}, ...["Candidate", "Where", "Round", "When", "Waiting", ""]
              .map((h) => el("th", {}, h)))),
          el("tbody", {}, ...waiting.map((r) => el("tr", { class: "urgent" },
            el("td", {},
              el("button", { class: "linkbtn",
                onclick: () => go("submission", r.sub.id) }, r.sub.contact.fullName)),
            el("td", { class: "muted" },
              `${r.sub.account ? r.sub.account.name : ""} · ${r.sub.project.name}`),
            el("td", { class: "num" }, r.round),
            el("td", { class: "muted" }, whenText(r.scheduledAt)),
            el("td", {}, ageChip(r.daysAgo, 3)),
            el("td", {},
              el("button", { class: "linkbtn", onclick: () => outcomeFlow(r.id) },
                "Record it"))))))]
      : [el("p", { class: "muted" },
          "Every interview that has happened has an outcome against it.")]),

    section("Coming up", coming.length
      ? coming.map((r) => el("div", { class: "card" },
          el("h3", {}, r.sub.contact.fullName,
            el("span", { class: "pill", style: "margin-left:8px" },
              `round ${r.round}`)),
          el("div", { class: "meta" },
            `${r.sub.account ? r.sub.account.name : ""} · ${r.sub.project.name} · ` +
            `${r.mode} · ${r.durationMins} minutes`),
          el("p", { style: "margin:8px 0 4px" },
            el("strong", {}, whenText(r.scheduledAt)),
            el("span", { class: "muted" },
              (() => {
                const d = Math.round(
                  (new Date(r.scheduledAt).getTime() - Date.now()) / DAY);
                return d <= 0 ? " · today" : d === 1 ? " · tomorrow" : ` · in ${d} days`;
              })())),
          r.whereText ? el("p", { class: "meta" }, r.whereText) : null,
          r.interviewers
            ? el("p", {}, el("strong", {}, "Client side: "), r.interviewers) : null,
          r.prepNotes
            ? el("p", {}, el("strong", {}, "Prep: "), r.prepNotes)
            : el("p", { class: "meta err" },
                "No prep written. The candidate is walking in cold."),
          el("div", { class: "rowbtns" },
            el("button", { class: "linkbtn",
              onclick: () => go("submission", r.sub.id) }, "Open the submission"),
            el("button", { class: "linkbtn", onclick: () => outcomeFlow(r.id) },
              "It has happened"))))
      : [el("p", { class: "muted" }, "Nothing booked in the next three weeks.")]));
}

/* --------------------------------------------------------------- paperwork
 *
 * What sales lives on. An account with open projects and no master agreement is
 * work we cannot invoice, and a lapsed one is worse than none because everybody
 * assumes it is fine. Both were visible only as a widget on the desk, which is
 * the wrong place for the thing somebody has to chase.
 */
function paperworkView() {
  const me = actingUser();
  const mineOnly = UI.bookScope === undefined || UI.bookScope === null
    ? true : UI.bookScope === "mine";
  const mine = (accountId) => !mineOnly ||
    ownersOf(accountId).some((o) => o.userId === me.id);
  const today = iso(new Date());

  const accounts = activeAccounts().filter((a) => mine(a.id));
  const rows = accounts.map((a) => {
    const all = where("agreements", (g) => g.accountId === a.id);
    const msa = all.filter((g) => g.kind === "MSA" && g.status === "executed")[0] || null;
    const expired = !!(msa && msa.effectiveTo && msa.effectiveTo < today);
    const expiringIn = msa && msa.effectiveTo ? daysUntil(msa.effectiveTo) : null;
    const openProjects = projectsOf(a.id).filter((p) => p.status === "open").length;
    const working = where("placements", (pl) => pl.status === "active" &&
      (byId("projects", pl.projectId) || {}).accountId === a.id).length;
    return { account: a, agreements: all, msa, expired, expiringIn,
             openProjects, working };
  });

  const urgent = rows.filter((r) => (!r.msa || r.expired) &&
    (r.openProjects > 0 || r.working > 0));
  const soon = rows.filter((r) => r.msa && !r.expired &&
    r.expiringIn !== null && r.expiringIn <= 90);

  const agreementRow = (r) => el("tr", {
      class: (!r.msa || r.expired) && (r.openProjects || r.working) ? "urgent" : null,
      style: "cursor:pointer", onclick: () => go("account", r.account.id) },
    el("td", {}, el("strong", {}, r.account.name),
      el("div", { class: "meta" },
        ownersOf(r.account.id).map((o) => o.name).join(", ") || "unassigned")),
    el("td", {},
      !r.msa ? el("span", { class: "pill bad" }, "no master agreement")
        : r.expired ? el("span", { class: "pill bad" },
            "lapsed " + day(r.msa.effectiveTo))
        : r.expiringIn !== null && r.expiringIn <= 90
          ? el("span", { class: "pill warn" }, `expires in ${r.expiringIn} days`)
          : el("span", { class: "pill good" }, "in force")),
    el("td", { class: "num" }, r.openProjects),
    el("td", { class: "num" }, r.working),
    el("td", { class: "muted" },
      r.agreements.length
        ? r.agreements.map((g) => g.kind.replace(/_/g, " ")).join(", ")
        : "nothing on file"),
    el("td", { class: "muted" }, r.msa && r.msa.termsNotes ? r.msa.termsNotes : ""));

  return el("div", { class: "pane" },
    el("div", { class: "deskhead" },
      el("div", {},
        el("h2", { class: "dtitle" }, "Paperwork"),
        el("p", { class: "dsub" },
          "Master agreements, and which accounts are working without one. " +
          "An account with people on site and no agreement in force is revenue " +
          "we cannot bill for.")),
      el("div", { class: "segs" },
        el("div", { class: "deskswitch" },
          ...[["mine", "My accounts"], ["all", "Everyone's"]].map(([k, label]) =>
            el("button", { class: "seg" + ((mineOnly ? "mine" : "all") === k ? " on" : ""),
                           onclick: () => { UI.bookScope = k; render(); } }, label))))),

    urgent.length
      ? el("div", { class: "banner warn" },
          el("b", {}, urgent.length === 1
            ? "One account is working without an agreement in force. "
            : `${urgent.length} accounts are working without an agreement in force. `),
          "That is delivery we may not be able to invoice. It is the first call to make.")
      : null,

    soon.length
      ? el("div", { class: "banner" },
          el("b", {}, "Renewals coming. "),
          soon.map((r) => `${r.account.name} in ${r.expiringIn} days`).join(", ") + ".")
      : null,

    !rows.length
      ? el("div", { class: "banner" },
          el("b", {}, "No accounts are yours. "),
          "Switch to Everyone's above to see the whole book.")
      : el("table", { class: "grid" },
          el("thead", {},
            el("tr", {}, ...["Account", "Master agreement", "Open projects",
              "People on site", "On file", "Terms"].map((h) => el("th", {}, h)))),
          el("tbody", {}, ...rows
            .sort((a, b) =>
              (Number(!b.msa || b.expired) - Number(!a.msa || a.expired)) ||
              (b.openProjects + b.working) - (a.openProjects + a.working))
            .map(agreementRow))));
}
