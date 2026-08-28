
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
  ["Recruiting", [["pipeline", "Pipeline"], ["interviews", "Interviews"]]],
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
  // Scoped the way the desk is scoped: an admin sees the business, everybody
  // else sees their own. An unscoped badge on a desk of 75 recruiters is a
  // number nobody can act on, which is a number nobody reads.
  const noFeedback = interviewsAwaitingFeedback(
    me.role === "admin" ? null : me.id).length;

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
        UI.pipeScope = null; UI.pipeClosed = false;
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
              pendingUnlocks) : null,
        view === "interviews" && noFeedback
          ? el("span", { class: "pill warn", style: "margin-left:auto" },
              noFeedback) : null)),
    ]),
    el("div", { class: "spacer" }),
    el("div", { class: "foot" },
      canWrite === false ? "Read-only view — changes are not kept"
        : ART ? "Changes are saved to this page" : "Preview — changes are not kept"));

  let body;
  try {
    body =
      UI.view === "home" ? homeView() :
      UI.view === "pipeline" ? pipelineView() :
      UI.view === "submission" ? submissionView(UI.sel) :
      UI.view === "interviews" ? interviewsView() :
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
