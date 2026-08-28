/* ------------------------------------------------------- forms and dialogs
 *
 * A browser prompt takes one line of text, which is fine for "what did they
 * say" and useless for a rate and a start date. This is the smallest thing that
 * is not that: a field list in, an object out, Escape closes it.
 */
function askFor(title, fields, { submitLabel = "Save", note = null, onChange = null } = {}) {
  return new Promise((resolve) => {
    const inputs = {};
    const readAll = () => Object.fromEntries(
      Object.entries(inputs).map(([k, node]) => [k, node.value]));
    const live = el("div", { class: "livenote" });

    const refresh = () => {
      if (!onChange) return;
      const out = onChange(readAll());
      live.replaceChildren(out ? (out.nodeType ? out : document.createTextNode(out)) : "");
    };

    const rows = fields.map((f) => {
      let node;
      if (f.type === "select") {
        node = el("select", { class: "fi" }, ...(f.options || []).map((o) =>
          el("option", { value: o.value,
                         selected: String(o.value) === String(f.value ?? "") ? "" : null },
             o.label)));
      } else if (f.type === "textarea") {
        node = el("textarea", { class: "fi", rows: f.rows || 3,
                                placeholder: f.placeholder || "" }, f.value || "");
      } else {
        node = el("input", { class: "fi", type: f.type || "text",
                             value: f.value ?? "", step: f.step || null,
                             min: f.min ?? null, placeholder: f.placeholder || "" });
      }
      node.addEventListener("input", refresh);
      node.addEventListener("change", refresh);
      inputs[f.name] = node;
      return el("label", { class: "field" + (f.wide ? " wide" : "") },
        el("span", { class: "flab" }, f.label),
        node,
        f.hint ? el("span", { class: "fhint" }, f.hint) : null);
    });

    const dlg = el("dialog", { class: "ask" },
      el("form", { method: "dialog", onsubmit: (e) => {
        e.preventDefault();
        dlg.close();
        resolve(readAll());
      } },
        el("h3", {}, title),
        note ? el("p", { class: "askmeta" }, note) : null,
        el("div", { class: "fields" }, ...rows),
        onChange ? live : null,
        el("div", { class: "askbtns" },
          el("button", { type: "button", class: "ghost",
                         onclick: () => { dlg.close(); resolve(null); } }, "Cancel"),
          el("button", { type: "submit", class: "send" }, submitLabel))));

    dlg.addEventListener("close", () => { dlg.remove(); });
    dlg.addEventListener("cancel", () => resolve(null));
    document.body.append(dlg);
    dlg.showModal();
    refresh();
    const first = Object.values(inputs)[0];
    if (first) first.focus();
  });
}

/* Every write from a screen funnels through here so a refusal always lands the
 * same way: the message the rule gave, in front of the person who tried. */
function attempt(fn) {
  try { const out = fn(); commit(); render(); return out; }
  catch (e) { alert(e.message); return null; }
}

const candidateOptions = () => where("contacts", (c) => c.isCandidate && !c.archivedAt)
  .sort((a, b) => a.fullName.localeCompare(b.fullName))
  .map((c) => ({ value: c.id, label: c.fullName + (c.headline ? ` — ${c.headline}` : "") }));

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
    fields.push({ name: "contactId", label: "Who", type: "select",
                  options: candidateOptions(), wide: true });
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
    contact ? `Put ${contact.fullName} forward` : "Submit a candidate", fields,
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
  if (!answer.date) { alert("An interview needs a date."); return; }
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

function pipelineView() {
  const me = actingUser();
  const mineOnly = UI.pipeScope === undefined || UI.pipeScope === null
    ? me.role !== "admin" : UI.pipeScope === "mine";
  const showClosed = !!UI.pipeClosed;
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
        el("h2", { class: "dtitle" }, "Pipeline"),
        el("p", { class: "dsub" },
          "Everybody we have out, and how long they have been sitting there. " +
          "The buttons on a submission are the moves the rules allow from where it is.")),
      el("div", { class: "segs" },
        seg([["mine", "Mine"], ["all", "Everyone"]], mineOnly ? "mine" : "all",
            (k) => { UI.pipeScope = k; }),
        seg([["open", "In play"], ["all", "Everything"]], showClosed ? "all" : "open",
            (k) => { UI.pipeClosed = k === "all"; }),
        el("button", { class: "send", onclick: () => submitFlow() }, "Submit somebody"))),

    !rows.length
      ? el("div", { class: "banner" },
          el("b", {}, "Nothing out. "),
          mineOnly
            ? "Nothing of yours is in play — switch to Everyone to see the whole desk, " +
              "or put somebody forward."
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
          "Counted from the history, not from where things ended up — somebody " +
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
