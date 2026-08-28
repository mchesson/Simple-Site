
/* ------------------------------------------------------------------- seed */

/* Demo data shaped like the real business: a consultant on two engagements at
 * one client so weeks split, two approving managers so a week can be half
 * approved, and money at every stage from claimed to collected. */
function seedState() {
  const st = {
    v: 5, seeded: true, actingUserId: null,
    users: [], accounts: [], accountOwners: [], locations: [], contacts: [],
    projects: [], projectApprovers: [], placements: [], rates: [], pos: [],
    submissions: [], submissionEvents: [], interviews: [],
    pipelines: [], pipelineMembers: [],
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
  //
  // Each one is given the history it would have if somebody had walked it
  // through, because the funnel is counted off that history rather than off
  // where things ended up. Fabricating it here is the only way a fresh page has
  // a funnel to read at all; every submission made after this one goes through
  // the guards like anything else.
  const ago = (days) => new Date(Date.now() - days * 864e5).toISOString();
  const ROAD = ["submitted", "client_review", "interview", "offer", "placed"];
  const pathTo = (stage) => {
    if (stage === "rejected" || stage === "withdrawn") return null;   // set per call
    return ROAD.slice(0, ROAD.indexOf(stage) + 1);
  };

  const sub = (projectId, contactId, stage, submittedBy, days, rates, opts = {}) => {
    const path = opts.path || pathTo(stage);
    const createdDays = days + (opts.age || 6);
    const row = insert("submissions", {
      projectId, contactId, stage, submittedBy,
      payRate: rates ? rates[0] : null, billRate: rates ? rates[1] : null,
      burdenPct: rates && rates[0] ? 22 : 0,
      lossReasonCode: opts.lossReasonCode || null,
      notes: opts.notes || null,
      createdAt: ago(createdDays), stageSince: ago(days),
    }, "seeded");
    // Spread the moves across the life of the submission, oldest first.
    path.forEach((to, n) => {
      const span = createdDays - days;
      const at = ago(createdDays - (path.length > 1 ? span * n / (path.length - 1) : 0));
      insert("submissionEvents", {
        submissionId: row.id, fromStage: n === 0 ? null : path[n - 1], toStage: to,
        reason: n === path.length - 1 ? opts.reason || null : null,
        actorId: submittedBy, at,
      }, "seeded");
    });
    return row;
  };

  const subPlatform = sub(platform.id, marcus.id, "placed", dev.id, 74, [68, 108], {
    age: 12,
    notes: "Ran the historian migration at his last two sites." });
  // With the client for eleven days and nobody has chased it. The interview
  // happened and nobody wrote down what was said, which is how this dies.
  const subJo = sub(line4.id, jo.id, "interview", dev.id, 11, [56, 90], {
    age: 6, notes: "Strong on Allen-Bradley. Free from the second week of September." });
  insert("interviews", { submissionId: subJo.id, round: 1,
    scheduledAt: ago(11).slice(0, 16), durationMins: 90, mode: "onsite",
    whereText: "Reno plant, gate 2 \u2014 ask for the controls office",
    interviewers: "Priya Raman (distribution director), Sal Ortega (controls lead)",
    prepNotes: "They will ask about the line 3 outage. Walk them through the rollback.",
    status: "scheduled", outcome: "pending", feedback: null, arrangedBy: dev.id,
    createdAt: ago(14) }, "seeded");

  const subNia = sub(line4.id, nia.id, "client_review", dev.id, 4, [52, 86], {
    notes: "Day shift only. Wants to be close to home." });

  // Offer out, and the client's finance director wants one more conversation
  // before signing. Booking that round does not drag the offer backwards.
  const subTess = sub(erp.id, tess.id, "offer", sam.id, 6, [null, 140], {
    age: 14, reason: "Walter confirmed verbally, requisition sitting in finance",
    notes: "Ran the same cutover at a manufacturer of similar size." });
  insert("interviews", { submissionId: subTess.id, round: 1,
    scheduledAt: ago(9).slice(0, 16), durationMins: 60, mode: "video",
    whereText: null, interviewers: "Walter Sandoval (programme director)",
    prepNotes: null, status: "completed", outcome: "advance",
    feedback: "Walter wants her. Asked us to hold the rate while finance signs " +
      "the requisition.",
    arrangedBy: sam.id, createdAt: ago(13) }, "seeded");
  insert("interviews", { submissionId: subTess.id, round: 2,
    scheduledAt: new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 11) + "09:00",
    durationMins: 30, mode: "video", whereText: null,
    interviewers: "Renata Cole (finance director)",
    prepNotes: "Half an hour on the programme budget. She signs the requisition.",
    status: "scheduled", outcome: "pending", feedback: null, arrangedBy: sam.id,
    createdAt: ago(2) }, "seeded");

  const subRavi = sub(platform.id, ravi.id, "submitted", dev.id, 1, [62, 100], {
    age: 1, notes: "Cheaper than Marcus and nearly as strong on Airflow." });

  // Lost on rate a month ago. This is the row the loss breakdown reads.
  sub(erp.id, ben.id, "rejected", sam.id, 30, [null, 155], {
    age: 2,
    path: ["submitted", "client_review", "rejected"],
    lossReasonCode: "rate_too_high",
    reason: "Walter said 155 was 20 dollars over what finance would sign off",
    notes: "Stronger on finance transformation, lighter on change management." });

  // Marcus's placement came out of his submission, so the recruiting side and
  // the money side join up on one record.
  update("placements", plPlatform.id, { submissionId: subPlatform.id }, "seeded");

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
