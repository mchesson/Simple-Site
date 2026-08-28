/* ---------------------------------------------------------------- pipeline
 *
 * Submissions: putting a resource forward, moving them through, booking the
 * conversations, and the handover to payroll when it comes off.
 *
 * Every operation here refuses the same things the server refuses, and for the
 * same reasons. A page cannot enforce a rule the way a database can - anyone can
 * open the console - but a rule that is only in a screen is a rule that gets
 * forgotten by the next screen, so they live in one place here too.
 */

const submissionsOf = (contactId) => where("submissions", (s) => s.contactId === contactId);
const interviewsOf = (submissionId) => where("interviews", (i) => i.submissionId === submissionId)
  .sort((a, b) => a.round - b.round);
const historyOf = (submissionId) => where("submissionEvents",
  (e) => e.submissionId === submissionId).sort((a, b) => a.at.localeCompare(b.at));

/* The one number a recruiter needs before they commit to a rate. */
function marginOf(payRate, billRate, burdenPct) {
  const pay = num(payRate), bill = num(billRate), burden = num(burdenPct);
  if (!payRate || !billRate) return { gm: null, gmPct: null };
  const gm = bill - pay - (pay * burden / 100);
  return { gm, gmPct: bill ? (gm / bill) * 100 : null };
}

/* A submission, with everything a screen wants to say about it in one object. */
function submissionRow(s) {
  const project = byId("projects", s.projectId);
  const contact = byId("contacts", s.contactId);
  const account = project ? byId("accounts", project.accountId) : null;
  const st = stageOf(s.stage) || { label: s.stage, sort: 99 };
  const ivs = interviewsOf(s.id);
  const nextIv = ivs.filter((i) => i.status === "scheduled" &&
    new Date(i.scheduledAt).getTime() >= Date.now() - 2 * DAY)
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))[0] || null;
  return {
    ...s, project, contact, account, stageLabel: st.label, stageSort: st.sort,
    isOpen: !!st.open, isWon: !!st.won,
    daysInStage: daysSince(s.stageSince) ?? 0,
    daysSinceSubmitted: daysSince(s.createdAt) ?? 0,
    ...marginOf(s.payRate, s.billRate, s.burdenPct),
    interviews: ivs, nextInterview: nextIv,
    lastTouch: lastTouch(s.contactId),
    loss: s.lossReasonCode ? lossReason(s.lossReasonCode) : null,
  };
}

function board({ ownerId = null, projectId = null, accountId = null,
                 contactId = null, openOnly = true } = {}) {
  return where("submissions", (s) =>
      (!projectId || s.projectId === projectId) &&
      (!contactId || s.contactId === contactId))
    .map(submissionRow)
    .filter((r) => r.project && r.contact)
    .filter((r) => !accountId || r.project.accountId === accountId)
    .filter((r) => !openOnly || r.isOpen)
    .filter((r) => !ownerId || r.submittedBy === ownerId || r.project.ownerId === ownerId)
    .sort((a, b) => (a.stageSort - b.stageSort) || (b.daysInStage - a.daysInStage));
}

/* ------------------------------------------------------------- operations */

/* Putting a resource forward. Refuses what the server refuses, in the same words,
 * and hands back advisories rather than blocking on a thin margin - a rate
 * decision belongs to the person making it, they just should not make it blind. */
function submitCandidate({ projectId, contactId, payRate = null, billRate = null,
                           burdenPct = 22, notes = null }) {
  const project = byId("projects", projectId);
  if (!project) throw new Error("that project is not on file");
  if (project.archivedAt) throw new Error("that project is archived");
  if (!["open", "draft"].includes(project.status)) {
    throw new Error(`that project is ${project.status} — reopen it before submitting anybody`);
  }
  const contact = byId("contacts", contactId);
  if (!contact) throw new Error("that person is not on file");
  if (!contact.isCandidate) {
    throw new Error(`${contact.fullName} is not marked as a candidate — mark them as one ` +
      "on their record first, which is a change to the person we already have, " +
      "not a second record");
  }
  if (where("submissions", (s) => s.projectId === projectId &&
                                  s.contactId === contactId).length) {
    throw new Error(`${contact.fullName} has already been put forward for this project`);
  }

  /* Two recruiters working the same person into the same client is the call
   * nobody wants to make. The same recruiter putting them up for a second role
   * at that client is ordinary work, so only a different one is stopped. */
  const me = actingUser();
  const clash = where("submissions", (s) => s.contactId === contactId &&
      stageIsOpen(s.stage) && s.submittedBy && s.submittedBy !== me.id)
    .map(submissionRow)
    .find((r) => r.project && r.project.accountId === project.accountId);
  if (clash) {
    const who = (byId("users", clash.submittedBy) || {}).name || "somebody";
    throw new Error(`${contact.fullName} is already out to ` +
      `${clash.account ? clash.account.name : "this client"} — ${who} submitted them ` +
      `for ${clash.project.name} on ${day(iso(clash.createdAt))}. ` +
      "Speak to them before going round it.");
  }

  const now = new Date().toISOString();
  const row = insert("submissions", {
    projectId, contactId, stage: "submitted", stageSince: now, createdAt: now,
    submittedBy: me.id, payRate, billRate, burdenPct, lossReasonCode: null, notes,
  }, "submitted a candidate");
  insert("submissionEvents", {
    submissionId: row.id, fromStage: null, toStage: "submitted", reason: null,
    actorId: me.id, at: now,
  }, "submission history");

  const account = byId("accounts", project.accountId);
  logActivity({ contactId, accountId: project.accountId, projectId, kind: "submission",
    body: `Submitted to ${account ? account.name : "the client"} for ${project.name}` +
      (billRate ? ` at ${money2(billRate)} an hour` : "") });

  const m = marginOf(payRate, billRate, burdenPct);
  const advisories = [];
  if (billRate && project.billRateMax && num(billRate) > num(project.billRateMax)) {
    advisories.push(`that bill rate is above the ${money2(project.billRateMax)} ceiling ` +
      "on this project");
  }
  if (billRate && project.billRateMin && num(billRate) < num(project.billRateMin)) {
    advisories.push(`that bill rate is below the ${money2(project.billRateMin)} floor ` +
      "on this project");
  }
  if (m.gmPct !== null && m.gmPct < 15) {
    advisories.push(`that leaves ${m.gmPct.toFixed(1)}% gross margin`);
  }
  return { ...row, ...m, advisories };
}

/* Moving a stage. The machine decides, not the caller. */
function advanceSubmission(submissionId, toStage, reason = null, lossReasonCode = null) {
  const s = byId("submissions", submissionId);
  if (!s) throw new Error("that submission is not on file");
  if (s.stage === toStage) throw new Error(`it is already at ${STAGE_LABEL[toStage]}`);

  const move = FLOW.find((f) => f.from === s.stage && f.to === toStage);
  if (!move) {
    const legal = movesFrom(s.stage).map((f) => f.label).join(", ");
    throw new Error(`a submission at ${STAGE_LABEL[s.stage]} cannot go to ` +
      `${STAGE_LABEL[toStage] || toStage}. From here you can: ` +
      (legal || "nothing — it is finished"));
  }
  if (move.needsReason && !(reason || "").trim()) {
    throw new Error(`moving this to ${STAGE_LABEL[toStage]} needs a reason`);
  }
  const target = stageOf(toStage);
  if (!target.open && !target.won && !lossReasonCode) {
    throw new Error("say why we lost this one — a loss nobody wrote down teaches " +
      "the desk nothing");
  }
  /* "Placed" is a claim that a consultant is starting work, and the placement is
   * what payroll and billing hang off. The word cannot get ahead of the record. */
  if (target.won && !where("placements", (p) => p.submissionId === submissionId).length) {
    throw new Error("create the placement first — a submission is not placed until " +
      "the consultant has a start date");
  }

  const me = actingUser();
  const now = new Date().toISOString();
  const row = update("submissions", submissionId, {
    stage: toStage, stageSince: now,
    // Back in play means the old explanation of how it died no longer applies.
    lossReasonCode: target.open ? null : (lossReasonCode || s.lossReasonCode),
  }, reason || `moved to ${STAGE_LABEL[toStage]}`);
  insert("submissionEvents", {
    submissionId, fromStage: s.stage, toStage, reason: reason || null,
    actorId: me.id, at: now,
  }, "submission history");
  return row;
}

/* Booking the conversation. This is what puts a submission in the interview
 * stage - nobody has to remember two steps - and it never drags a stage
 * backwards, so a second round while an offer is out leaves the offer alone. */
function scheduleInterview({ submissionId, scheduledAt, durationMins = 60, mode = "video",
                             whereText = null, interviewers = null, prepNotes = null }) {
  const s = byId("submissions", submissionId);
  if (!s) throw new Error("that submission is not on file");
  if (!scheduledAt) throw new Error("an interview needs a date and a time");
  if (!stageIsOpen(s.stage)) {
    throw new Error(`that submission is closed (${STAGE_LABEL[s.stage]}) — ` +
      "reopen it before booking anything");
  }
  const round = interviewsOf(submissionId).reduce((n, i) => Math.max(n, i.round), 0) + 1;
  const me = actingUser();
  const row = insert("interviews", {
    submissionId, round, scheduledAt, durationMins: num(durationMins) || 60, mode,
    whereText, interviewers, prepNotes, status: "scheduled", outcome: "pending",
    feedback: null, arrangedBy: me.id, createdAt: new Date().toISOString(),
  }, `booked interview round ${round}`);

  if ((stageOf(s.stage).sort) < stageOf("interview").sort) {
    advanceSubmission(submissionId, "interview", "interview booked");
  }
  const project = byId("projects", s.projectId);
  const account = project ? byId("accounts", project.accountId) : null;
  logActivity({ contactId: s.contactId, projectId: s.projectId,
    accountId: project ? project.accountId : null, kind: "interview",
    body: `Round ${round} ${mode} interview with ${account ? account.name : "the client"} ` +
      `booked for ${new Date(scheduledAt).toLocaleString()}` });
  return row;
}

/* What the client said. Deliberately does not move the stage: the next move is a
 * decision a person makes with a reason attached. */
function recordInterviewOutcome(interviewId, { status = "completed", outcome = null,
                                               feedback = null }) {
  const iv = byId("interviews", interviewId);
  if (!iv) throw new Error("that interview is not on file");
  return update("interviews", interviewId, {
    status, outcome: outcome || iv.outcome, feedback: feedback || iv.feedback,
  }, "recorded what happened at the interview");
}

/* The handover to payroll and billing: the placement, its opening rate, and only
 * then the word "placed". */
function placeSubmission({ submissionId, startDate, endDate = null, payRate = null,
                           billRate = null, burdenPct = null }) {
  const s = byId("submissions", submissionId);
  if (!s) throw new Error("that submission is not on file");
  if (!startDate) throw new Error("a placement needs a start date");
  if (where("placements", (p) => p.submissionId === submissionId).length) {
    throw new Error("that submission already has a placement");
  }
  const pay = payRate ?? s.payRate;
  const bill = billRate ?? s.billRate;
  const burden = burdenPct ?? s.burdenPct ?? 0;
  if (pay === null || pay === undefined || pay === "" ||
      bill === null || bill === undefined || bill === "") {
    throw new Error("a placement needs a pay rate and a bill rate — they are what " +
      "payroll and the invoice are built from");
  }
  const placement = insert("placements", {
    projectId: s.projectId, contactId: s.contactId, submissionId,
    // A start date that has already arrived means the assignment is running.
    // Deriving this beats a status somebody has to remember to change.
    status: startDate <= iso(new Date()) ? "active" : "pending",
    startDate, endDate,
    recruiterId: s.submittedBy || actingUser().id,
  }, "placed a submission");
  insert("rates", {
    placementId: placement.id, rateType: "standard", unit: "hour",
    payRate: num(pay), billRate: num(bill), burdenPct: num(burden),
    effectiveFrom: startDate, effectiveTo: null, supersedesId: null,
  }, "opening rate for a new placement");
  advanceSubmission(submissionId, "placed", "placed");

  const contact = byId("contacts", s.contactId);
  if (contact && !contact.onPayroll) {
    update("contacts", contact.id, { onPayroll: true },
      "started an assignment, so on our payroll from today");
  }
  return { placement, submission: byId("submissions", submissionId) };
}

/* ------------------------------------------------------------ the numbers */

/* How many submissions ever reached each stage, read off the history rather than
 * the current stage - so a candidate who was later rejected still counts towards
 * the interviews they got. That is the difference between a funnel and a
 * snapshot, and it is the difference between "we do not get interviews" and
 * "we get interviews and lose them". */
function funnel(ownerId = null) {
  const mine = (subId) => {
    if (!ownerId) return true;
    const s = byId("submissions", subId);
    if (!s) return false;
    const p = byId("projects", s.projectId);
    return s.submittedBy === ownerId || (p && p.ownerId === ownerId);
  };
  return STAGES.filter((st) => st.open || st.won).map((st) => ({
    ...st,
    reached: new Set(where("submissionEvents",
      (e) => e.toStage === st.code && mine(e.submissionId))
      .map((e) => e.submissionId)).size,
    sittingHere: where("submissions", (s) => s.stage === st.code && mine(s.id)).length,
  }));
}

function lossBreakdown(days = 90, ownerId = null) {
  const cutoff = Date.now() - days * DAY;
  const out = new Map();
  for (const s of where("submissions", (x) => x.lossReasonCode &&
      new Date(x.stageSince).getTime() >= cutoff)) {
    const p = byId("projects", s.projectId);
    if (ownerId && s.submittedBy !== ownerId && !(p && p.ownerId === ownerId)) continue;
    const lr = lossReason(s.lossReasonCode);
    if (!lr) continue;
    const cur = out.get(lr.code) || { ...lr, losses: 0, days: [] };
    cur.losses += 1;
    cur.days.push(Math.max(0, daysSince(s.createdAt) - daysSince(s.stageSince)));
    out.set(lr.code, cur);
  }
  return [...out.values()]
    .map((r) => ({ ...r, avgDays: r.days.length
      ? Math.round(r.days.reduce((a, b) => a + b, 0) / r.days.length) : null }))
    .sort((a, b) => b.losses - a.losses);
}

/* Interviews coming up, and separately the ones that happened where nobody has
 * written down the answer. The second list is how a submission dies quietly. */
function upcomingInterviews(days = 14, ownerId = null) {
  const now = Date.now();
  return where("interviews", (i) => i.status === "scheduled")
    .map((i) => ({ ...i, sub: submissionRow(byId("submissions", i.submissionId) || {}) }))
    .filter((r) => r.sub && r.sub.contact &&
      new Date(r.scheduledAt).getTime() >= now - 2 * DAY &&
      new Date(r.scheduledAt).getTime() <= now + days * DAY &&
      (!ownerId || r.sub.submittedBy === ownerId ||
        (r.sub.project && r.sub.project.ownerId === ownerId)))
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
}

function interviewsAwaitingFeedback(ownerId = null) {
  return where("interviews", (i) => i.outcome === "pending" &&
      ["scheduled", "completed"].includes(i.status) &&
      new Date(i.scheduledAt).getTime() < Date.now())
    .map((i) => ({ ...i, sub: submissionRow(byId("submissions", i.submissionId) || {}),
                   daysAgo: daysSince(i.scheduledAt) }))
    .filter((r) => r.sub && r.sub.contact && r.sub.isOpen &&
      (!ownerId || r.sub.submittedBy === ownerId ||
        (r.sub.project && r.sub.project.ownerId === ownerId)))
    .sort((a, b) => b.daysAgo - a.daysAgo);
}
