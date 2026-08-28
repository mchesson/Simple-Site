// The workspace front end. Talks to the same API the assistant does.

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
};
const api = async (p, opts) => {
  const r = await fetch(p, {
    ...opts,
    headers: opts?.body ? { "content-type": "application/json" } : undefined,
  });
  return r.json();
};
const money = (n) => n === null || n === undefined ? "—" :
  "$" + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
const day = (d) => d ? new Date(d).toLocaleDateString(undefined,
  { month: "short", day: "numeric", year: "numeric" }) : "—";

const state = { view: "chat", conversationId: null, streaming: false };

// ------------------------------------------------------------------- markup
// A small Markdown renderer. The assistant writes tables and lists; anything
// beyond that is not worth a dependency. Everything is escaped first, so no
// model output can inject markup.
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function md(src) {
  const lines = esc(src).split("\n");
  const out = [];
  let i = 0;
  const inline = (s) => s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
             '<a href="$2" target="_blank" rel="noopener">$1</a>');

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${buf.join("\n")}</code></pre>`);
      continue;
    }
    // A table needs a header row and a separator row of dashes.
    if (/^\s*\|/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || "")) {
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(
        "<table><thead><tr>" + head.map((h) => `<th>${inline(h)}</th>`).join("") +
        "</tr></thead><tbody>" +
        rows.map((r) => "<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>").join("") +
        "</tbody></table>");
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]))
        items.push(inline(lines[i++].replace(/^\s*[-*]\s+/, "")));
      out.push("<ul>" + items.map((t) => `<li>${t}</li>`).join("") + "</ul>");
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i]))
        items.push(inline(lines[i++].replace(/^\s*\d+\.\s+/, "")));
      out.push("<ol>" + items.map((t) => `<li>${t}</li>`).join("") + "</ol>");
      continue;
    }
    if (/^\s*#{1,4}\s+/.test(line)) {
      out.push(`<p><strong>${inline(line.replace(/^\s*#{1,4}\s+/, ""))}</strong></p>`);
      i++; continue;
    }
    if (!line.trim()) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])
           && !/^\s*\|/.test(lines[i]) && !/^```/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("");
}

// --------------------------------------------------------------------- chat
function chatView() {
  const thread = el("div", { class: "thread", id: "thread" });
  const ta = el("textarea", {
    placeholder: "Ask about accounts, projects, people, documents or POs. " +
                 "Or just tell it what happened and it will log it.",
    rows: 3,
    onkeydown: (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
    },
  });
  const btn = el("button", { class: "send", onclick: () => submit() }, "Send");
  const composer = el("div", { class: "composer" },
    el("div", { class: "box" }, ta,
      el("div", { class: "row" },
        el("span", { class: "hint" }, "Ctrl/⌘ + Enter to send"),
        btn)));

  const wrap = el("div", { class: "chatwrap" }, thread, composer);

  function empty() {
    thread.replaceChildren(el("div", { class: "empty" },
      el("h3", {}, "What are we working on?"),
      el("p", {},
        "I can read every account, project, person, document and purchase order in " +
        "the workspace, and write to it. Nothing gets deleted — changes keep the " +
        "previous version."),
      el("div", { class: "sugg" },
        ...[
          "Which purchase orders run out in the next 90 days?",
          "Show me the unassigned accounts",
          "What's our margin on the Globex plant data platform?",
          "Who do we know with Airflow and Snowflake?",
          "What are the rules of engagement at Globex Reno?",
          "Log a call with Dana Reyes — she wants a controls engineer before the October shutdown",
        ].map((s) => el("button", { onclick: () => { ta.value = s; submit(); } }, s)))));
  }
  empty();

  function addTurn(role, node) {
    if ($(".empty", thread)) thread.replaceChildren();
    const t = el("div", { class: `turn ${role}` },
      el("div", { class: "who" }, role === "user" ? "You" : "Assistant"),
      node);
    thread.append(t);
    thread.scrollTop = thread.scrollHeight;
    return t;
  }

  async function submit() {
    const prompt = ta.value.trim();
    if (!prompt || state.streaming) return;
    ta.value = "";
    state.streaming = true;
    btn.disabled = true;

    addTurn("user", el("div", { class: "bubble" }, prompt));

    const steps = el("div", { class: "steps" });
    const think = el("div", { class: "thinking", style: "display:none" });
    const bubble = el("div", { class: "bubble" });
    addTurn("assistant", el("div", {}, steps, think, bubble));

    let text = "";
    const stepNodes = new Map();

    await streamChat(prompt, (ev, data) => {
      if (ev === "conversation") {
        state.conversationId = data.id;
        loadConversations();
      } else if (ev === "thinking") {
        think.style.display = "";
        think.textContent += data.text;
      } else if (ev === "tool_start") {
        const n = el("div", { class: "stepline" },
          el("span", { class: "dot" }),
          el("span", { class: "tool" }, humanTool(data.tool)),
          el("span", {}, "…"));
        stepNodes.set(data.tool + JSON.stringify(data.input), n);
        steps.append(n);
      } else if (ev === "tool_end") {
        const n = [...stepNodes.values()].pop();
        const line = el("div", { class: "stepline" },
          el("span", { class: "dot", style: `color:var(--${data.ok ? "good" : "bad"})` }),
          el("span", { class: "tool" }, humanTool(data.tool)),
          el("span", {}, data.summary || (data.ok ? "done" : "failed")));
        if (n) n.replaceWith(line); else steps.append(line);
      } else if (ev === "text") {
        think.style.display = "none";
        text += data.text;
        bubble.innerHTML = md(text);
        thread.scrollTop = thread.scrollHeight;
      } else if (ev === "error") {
        bubble.append(el("p", { class: "err" }, data.message));
      } else if (ev === "trace_end") {
        const t = data.trace;
        steps.append(el("div", { class: "stepline" },
          el("a", { href: `/inspect.html#${t.id}`, class: "muted" },
            `${(t.durationMs / 1000).toFixed(1)}s · ` +
            `${t.usage.input_tokens + t.usage.output_tokens} tokens · ` +
            `$${t.costUsd.toFixed(4)} · see inside`)));
      }
    });

    state.streaming = false;
    btn.disabled = false;
    ta.focus();
  }

  setTimeout(() => ta.focus(), 30);
  return wrap;
}

const TOOL_WORDS = {
  list_accounts: "Looking through accounts", get_account: "Reading the account",
  create_account: "Creating the account", set_account_owners: "Setting owners",
  get_location: "Reading the site", create_location: "Adding the site",
  list_contacts: "Searching people", get_contact: "Reading the person",
  create_contact: "Creating the person", update_contact: "Updating the person",
  list_projects: "Looking through projects", get_project: "Reading the project",
  create_project: "Creating the project", update_project: "Updating the project",
  log_activity: "Logging the interaction", search_documents: "Searching documents",
  po_burndown: "Checking PO burn-down", tag_to_pipeline: "Adding to a pipeline",
  get_pipeline: "Reading the pipeline", list_users: "Checking workspace users",
  record_history: "Reading the change history", describe_schema: "Reading the schema",
  sql_query: "Querying the database",
};
const humanTool = (t) => TOOL_WORDS[t] || t;

// Server-sent events over POST, so the prompt travels in the body.
async function streamChat(prompt, onEvent) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, conversation_id: state.conversationId }),
  });
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let cut;
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, cut); buf = buf.slice(cut + 2);
      if (raw.startsWith(":")) continue;
      const ev = /^event: (.+)$/m.exec(raw)?.[1];
      const dataLine = /^data: ([\s\S]*)$/m.exec(raw)?.[1];
      if (!ev || dataLine === undefined) continue;
      try { onEvent(ev, JSON.parse(dataLine)); } catch { /* partial frame */ }
    }
  }
}

// ------------------------------------------------------------------ records
async function accountsView() {
  const list = await api("/api/accounts");
  return el("div", { class: "pane" },
    el("table", { class: "grid" },
      el("thead", {}, el("tr", {},
        ...["Account", "Status", "Owners", "Sites", "Managers", "Open projects"]
          .map((h) => el("th", {}, h)))),
      el("tbody", {}, ...list.map((a) => el("tr", { style: "cursor:pointer",
          onclick: () => go("account", a.id) },
        el("td", {}, el("strong", {}, a.name)),
        el("td", {}, el("span", { class: "pill" }, a.status.replace("_", " "))),
        el("td", {}, a.owners.length
          ? a.owners.map((o) => `${o.name} ${o.split_pct}%`).join(", ")
          : el("span", { class: "muted" }, "unassigned")),
        el("td", { class: "num" }, a.location_count),
        el("td", { class: "num" }, a.manager_count),
        el("td", { class: "num" }, a.open_projects))))));
}

async function accountView(id) {
  const a = await api(`/api/accounts/${id}`);
  return el("div", { class: "pane" },
    el("div", { class: "card" },
      el("h3", {}, a.name),
      el("div", { class: "meta" },
        [a.industry, a.status].filter(Boolean).join(" · ")),
      a.owners.length ? el("p", {}, "Owned by " +
        a.owners.map((o) => `${o.full_name} (${o.role.replace("_", " ")}, ${o.split_pct}%)`)
          .join(" and ")) : el("p", { class: "muted" }, "No owner assigned."),
      a.bg_check_policy && el("p", {}, el("strong", {}, "Background check. "),
        a.bg_check_policy),
      a.drug_test_policy && el("p", {}, el("strong", {}, "Drug screen. "),
        a.drug_test_policy),
      a.onboarding_notes && el("p", {}, el("strong", {}, "Onboarding. "),
        a.onboarding_notes)),
    section("Locations", a.locations.map((l) =>
      el("div", { class: "card", style: "cursor:pointer",
                  onclick: () => go("location", l.id) },
        el("h3", {}, l.name),
        el("div", { class: "meta" }, [l.city, l.state].filter(Boolean).join(", "))))),
    section("Contacts", [el("table", { class: "grid" }, el("tbody", {},
      ...a.contacts.map((c) => el("tr", { style: "cursor:pointer",
          onclick: () => go("contact", c.id) },
        el("td", {}, el("strong", {}, c.full_name)),
        el("td", { class: "muted" }, c.title || ""),
        el("td", {}, roles(c)),
        el("td", { class: "muted" }, c.email || "")))))]),
    section("Projects", [el("table", { class: "grid" }, el("tbody", {},
      ...a.projects.map((p) => el("tr", { style: "cursor:pointer",
          onclick: () => go("project", p.id) },
        el("td", {}, el("strong", {}, p.name)),
        el("td", {}, el("span", { class: "pill" }, p.delivery_type.replace(/_/g, " "))),
        el("td", {}, p.status),
        el("td", { class: "num" }, p.openings)))))]),
    section("Agreements", [el("table", { class: "grid" }, el("tbody", {},
      ...a.agreements.map((g) => el("tr", {},
        el("td", {}, el("strong", {}, g.kind.replace("_", " "))),
        el("td", {}, g.location_id ? "Site specific" : "Account wide"),
        el("td", {}, g.status.replace(/_/g, " ")),
        el("td", { class: "muted" }, g.terms_notes || "")))))]),
    section("Documents", [el("table", { class: "grid" }, el("tbody", {},
      ...a.documents.map((d) => el("tr", {},
        el("td", {}, el("strong", {}, d.title)),
        el("td", {}, d.kind.replace("_", " ")),
        el("td", {}, d.sharepoint_url
          ? el("a", { href: d.sharepoint_url, target: "_blank", rel: "noopener" },
               "Open in SharePoint")
          : el("span", { class: "muted" }, "no filed original"))))))]));
}

const roles = (c) => {
  const r = [];
  if (c.is_manager) r.push("Manager");
  if (c.is_candidate) r.push("Candidate");
  return r.map((x) => el("span", { class: "pill", style: "margin-right:5px" }, x));
};

function section(title, kids) {
  // Drop a section whose only content is an empty table, so a project with no
  // placements does not show a heading over nothing.
  const body = kids.filter(Boolean).filter((n) => {
    const tb = n.querySelector ? n.querySelector("tbody") : null;
    return !tb || tb.children.length > 0;
  });
  if (!body.length) return el("div", {});
  return el("div", { style: "margin:18px 0" },
    el("div", { class: "navsec", style: "padding-left:0" }, title), ...body);
}

async function locationView(id) {
  const l = await api(`/api/locations/${id}`);
  return el("div", { class: "pane" },
    el("div", { class: "card" },
      el("h3", {}, l.name),
      el("div", { class: "meta" },
        [l.address1, l.city, l.state, l.postal_code].filter(Boolean).join(", ")),
      l.rules_of_engagement && el("p", {}, el("strong", {}, "Rules of engagement. "),
        l.rules_of_engagement),
      el("p", {}, el("strong", {}, "Background check. "),
        l.inherited_bg_check || "No account policy set.",
        l.bg_check_notes ? " " + l.bg_check_notes : ""),
      el("p", {}, el("strong", {}, "Drug screen. "),
        l.inherited_drug_test || "No account policy set.",
        l.drug_test_notes ? " " + l.drug_test_notes : ""),
      el("p", { class: "muted" },
        "Screening above comes from " + l.account.name +
        " and applies here. Site notes add to it; they do not replace it.")),
    section("Contacts at this site", [el("table", { class: "grid" }, el("tbody", {},
      ...l.contacts.map((c) => el("tr", { style: "cursor:pointer",
          onclick: () => go("contact", c.id) },
        el("td", {}, el("strong", {}, c.full_name)),
        el("td", { class: "muted" }, c.title || ""),
        el("td", {}, roles(c))))))]));
}

async function contactsView() {
  const list = await api("/api/contacts?limit=100");
  return el("div", { class: "pane" },
    el("table", { class: "grid" },
      el("thead", {}, el("tr", {}, ...["Name", "Roles", "Where", "Skills", "Last activity"]
        .map((h) => el("th", {}, h)))),
      el("tbody", {}, ...list.map((c) => el("tr", { style: "cursor:pointer",
          onclick: () => go("contact", c.id) },
        el("td", {}, el("strong", {}, c.full_name),
          c.on_payroll ? el("span", { class: "pill good", style: "margin-left:7px" },
            "On payroll") : null),
        el("td", {}, roles(c)),
        el("td", { class: "muted" },
          c.account_name || c.location_text || ""),
        el("td", { class: "muted" }, (c.skills || []).slice(0, 4).join(", ")),
        el("td", { class: "muted" }, day(c.last_activity_at)))))));
}

async function contactView(id) {
  const c = await api(`/api/contacts/${id}`);
  return el("div", { class: "pane" },
    el("div", { class: "card" },
      el("h3", {}, c.full_name),
      el("div", { class: "meta" }, [c.title, c.headline].filter(Boolean).join(" · ")),
      el("p", {}, roles(c),
        c.on_payroll ? el("span", { class: "pill good" },
          "On our payroll" + (c.recruiter ? " · " + c.recruiter.full_name : "")) : null),
      c.account && el("p", {}, "Works at ",
        el("a", { href: "#", onclick: (e) => { e.preventDefault(); go("account", c.account.id); } },
          c.account.name),
        c.location ? ` · ${c.location.name}` : ""),
      (c.email || c.phone) && el("p", { class: "muted" },
        [c.email, c.phone].filter(Boolean).join(" · ")),
      (c.skills || []).length && el("p", {}, c.skills.join(" · "))),
    section("Activity", [el("div", {}, ...c.activity.map((a) =>
      el("div", { class: "card" },
        el("div", { class: "meta" },
          el("span", { class: "pill" }, a.as_role === "manager" ? "As manager" : "As candidate"),
          " " + a.kind + " · " + day(a.occurred_at) + (a.actor_name ? " · " + a.actor_name : "") +
          (a.project_name ? " · " + a.project_name : "")),
        el("p", { style: "margin:6px 0 0; white-space:pre-wrap" }, a.body))))]),
    section("Documents", [el("table", { class: "grid" }, el("tbody", {},
      ...c.documents.map((d) => el("tr", {},
        el("td", {}, el("strong", {}, d.title)),
        el("td", {}, d.kind.replace("_", " ")),
        el("td", {}, d.sharepoint_url
          ? el("a", { href: d.sharepoint_url, target: "_blank", rel: "noopener" }, "Open")
          : el("span", { class: "muted" }, "—"))))))]),
    section("Pipelines", c.pipelines.map((p) =>
      el("div", { class: "card" }, el("h3", {}, p.name),
        el("div", { class: "meta" }, "kept by " + p.owner)))));
}

async function projectsView() {
  const list = await api("/api/projects");
  return el("div", { class: "pane" },
    el("table", { class: "grid" },
      el("thead", {}, el("tr", {}, ...["Project", "Account", "Delivery", "Status",
        "Seats", "Submissions", "Placed"].map((h) => el("th", {}, h)))),
      el("tbody", {}, ...list.map((p) => el("tr", { style: "cursor:pointer",
          onclick: () => go("project", p.id) },
        el("td", {}, el("strong", {}, p.name)),
        el("td", { class: "muted" }, p.account_name),
        el("td", {}, el("span", { class: "pill" }, p.delivery_type.replace(/_/g, " "))),
        el("td", {}, p.status),
        el("td", { class: "num" }, p.openings),
        el("td", { class: "num" }, p.submission_count),
        el("td", { class: "num" }, p.active_placements))))));
}

async function projectView(id) {
  const p = await api(`/api/projects/${id}`);
  return el("div", { class: "pane" },
    el("div", { class: "card" },
      el("h3", {}, p.name),
      el("div", { class: "meta" },
        `${p.account_name}${p.location_name ? " · " + p.location_name : ""} · ` +
        `${p.delivery_type.replace(/_/g, " ")} · ${p.status}`),
      p.description && el("p", { style: "white-space:pre-wrap" }, p.description),
      el("p", { class: "muted" },
        `${p.openings} seat${p.openings === 1 ? "" : "s"}` +
        (p.start_date ? ` · starts ${day(p.start_date)}` : ""))),
    section("Placements and rates", p.placements.map((pl) =>
      el("div", { class: "card" },
        el("h3", {}, pl.full_name),
        el("div", { class: "meta" },
          `${pl.status} · started ${day(pl.start_date)}`),
        el("table", { class: "grid", style: "margin-top:8px" },
          el("thead", {}, el("tr", {}, ...["Effective", "Pay", "Bill", "Burden",
            "Gross margin", "GM %"].map((h) => el("th", {}, h)))),
          el("tbody", {}, ...(pl.rates || []).map((r) => el("tr", {},
            el("td", {}, day(r.effective_from) +
              (r.effective_to ? " – " + day(r.effective_to) : " – open")),
            el("td", { class: "num" }, "$" + r.pay_rate),
            el("td", { class: "num" }, "$" + r.bill_rate),
            el("td", { class: "num" }, r.burden_pct + "%"),
            el("td", { class: "num" }, "$" + Number(r.gm).toFixed(2)),
            el("td", { class: "num" }, r.gm_pct + "%"))))),
        el("p", { class: "muted", style: "margin-bottom:0" },
          "Rates are never edited in place. A change writes a new row and closes " +
          "the previous one, so old invoices still reconcile.")))),
    section("Purchase orders", p.purchase_orders.map((po) => poCard(po))),
    section("Rate verifications (Exhibit A)", [el("table", { class: "grid" }, el("tbody", {},
      ...p.rate_verifications.map((v) => el("tr", {},
        el("td", {}, el("strong", {}, v.full_name)),
        el("td", {}, v.status),
        el("td", { class: "num" }, `$${v.pay_rate} / $${v.bill_rate}`),
        el("td", { class: "muted" }, v.confirmed_by
          ? "confirmed by " + v.confirmed_by : "not confirmed")))))]),
    section("Submissions", [el("table", { class: "grid" }, el("tbody", {},
      ...p.submissions.map((s) => el("tr", { style: "cursor:pointer",
          onclick: () => go("contact", s.contact_id) },
        el("td", {}, el("strong", {}, s.full_name)),
        el("td", {}, el("span", { class: "pill" }, s.stage.replace("_", " "))),
        el("td", { class: "num" }, s.bill_rate ? "$" + s.bill_rate : "")))))]));
}

function poCard(po) {
  const pct = Number(po.pct_burned || 0);
  const soon = po.days_remaining !== null && po.days_remaining <= 90;
  return el("div", { class: "card" },
    el("h3", {}, po.po_number),
    el("div", { class: "meta" },
      `${money(po.amount)} committed · ${money(po.remaining)} left` +
      (po.days_remaining !== null
        ? ` · expires ${day(po.end_date)} (${po.days_remaining} days)` : "")),
    el("div", { class: "bar", style: "margin:9px 0 6px" },
      el("i", { style: `width:${Math.min(100, pct)}%` })),
    el("div", { class: "meta" },
      `${pct}% burned · ${money(po.pending_approval)} submitted but not yet approved`),
    soon ? el("p", { class: "pill warn", style: "margin-top:9px" },
      po.days_remaining <= 30 ? "Expires within a month" : "Expires within 90 days") : null);
}

async function poView() {
  const list = await api("/api/po-burndown");
  return el("div", { class: "pane" }, ...list.map((po) =>
    el("div", {}, el("div", { class: "navsec", style: "padding-left:0" },
      po.account_name + " · " + po.project_name), poCard(po))));
}

async function documentsView() {
  const list = await api("/api/documents?limit=100");
  return el("div", { class: "pane" },
    el("table", { class: "grid" },
      el("thead", {}, el("tr", {}, ...["Document", "Kind", "Attached to", "Filed original"]
        .map((h) => el("th", {}, h)))),
      el("tbody", {}, ...list.map((d) => el("tr", {},
        el("td", {}, el("strong", {}, d.title),
          d.excerpt ? el("div", { class: "meta" }, d.excerpt.slice(0, 110) + "…") : null),
        el("td", {}, d.kind.replace("_", " ")),
        el("td", { class: "muted" },
          d.account_name || d.contact_name || d.project_name || ""),
        el("td", {}, d.sharepoint_url
          ? el("a", { href: d.sharepoint_url, target: "_blank", rel: "noopener" },
               "Open in SharePoint")
          : el("span", { class: "muted" }, "not filed")))))));
}

// ------------------------------------------------------------------ routing
const TITLES = { chat: "Project Assistant", accounts: "Accounts", projects: "Projects",
  contacts: "Contacts", documents: "Documents", pos: "Purchase orders" };

async function go(view, id = null) {
  state.view = view;
  const body = $("#body");
  body.replaceChildren(el("div", { class: "pane muted" }, "Loading…"));
  $("#title").textContent = TITLES[view] || "";
  $("#subtitle").textContent = "";
  document.querySelectorAll(".nav .item").forEach((b) =>
    b.classList.toggle("on", b.dataset.view === view));

  let node;
  if (view === "chat") node = chatView();
  else if (view === "accounts") node = await accountsView();
  else if (view === "account") { node = await accountView(id); $("#title").textContent = "Account"; }
  else if (view === "location") { node = await locationView(id); $("#title").textContent = "Site"; }
  else if (view === "contacts") node = await contactsView();
  else if (view === "contact") { node = await contactView(id); $("#title").textContent = "Contact"; }
  else if (view === "projects") node = await projectsView();
  else if (view === "project") { node = await projectView(id); $("#title").textContent = "Project"; }
  else if (view === "documents") node = await documentsView();
  else if (view === "pos") node = await poView();
  body.replaceChildren(node);
  body.className = view === "chat" ? "chatwrap" : "";
}

async function loadConversations() {
  const list = await api("/api/conversations");
  const box = $("#convs");
  box.replaceChildren(...list.slice(0, 6).map((c) =>
    el("button", { class: "item" + (c.id === state.conversationId ? " on" : ""),
      onclick: () => { state.conversationId = c.id; go("chat"); loadConversations(); } },
      el("span", { style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap" },
        c.title))));
}

document.querySelectorAll(".nav .item[data-view]").forEach((b) =>
  b.addEventListener("click", () => go(b.dataset.view)));
$("#newchat").addEventListener("click", () => {
  state.conversationId = null; go("chat"); loadConversations();
});

(async () => {
  const [me, health] = await Promise.all([api("/api/me"), api("/api/health")]);
  $("#whoami").textContent = me ? `${me.full_name} · ${me.role.replace("_", " ")}` : "";
  const k = $("#keystate");
  if (health.anthropic_key === "present") {
    k.className = "pill good";
    k.textContent = health.model;
  } else {
    k.className = "pill bad";
    k.textContent = "No API key — chat will not run";
  }
  await loadConversations();
  go("chat");
})();
