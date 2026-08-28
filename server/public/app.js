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

function poCard(po, opts = {}) {
  const amt = Number(po.amount) || 1;
  const pct = (n) => Math.max(0, Math.min(100, (Number(n) || 0) / amt * 100));
  const paid = pct(po.paid);
  const billedUnpaid = Math.max(0, pct(po.invoiced) - paid);
  const drafted = pct(po.drafted_not_sent);
  const earned = pct(po.approved_unbilled);
  const over = Number(po.projected_remaining) < 0;
  const soon = po.days_remaining !== null && po.days_remaining <= 90;

  return el("div", { class: "card" },
    el("h3", {}, po.po_number),
    el("div", { class: "meta" },
      `${money(po.amount)} committed` +
      (po.days_remaining !== null
        ? ` · expires ${day(po.end_date)} (${po.days_remaining} days)` : "")),

    el("div", { class: "stack", style: "margin:11px 0 0" },
      el("i", { class: "paid", style: `width:${paid}%` }),
      el("i", { class: "billed", style: `width:${billedUnpaid}%` }),
      el("i", { class: "draft", style: `width:${drafted}%` }),
      el("i", { class: "earned", style: `width:${earned}%` })),

    Number(po.invoiced) || drafted || earned
      ? el("div", { class: "legend" },
          Number(po.paid) ? leg("good", "Paid", po.paid) : null,
          Number(po.invoiced) - Number(po.paid)
            ? leg("accent", "Billed, unpaid", Number(po.invoiced) - Number(po.paid)) : null,
          drafted ? leg("accent", "Drafted, not sent", po.drafted_not_sent, .42) : null,
          earned ? leg("warn", "Approved, not billed", po.approved_unbilled) : null)
      : el("div", { class: "legend" },
          el("span", { class: "muted" }, "Nothing billed against this one yet")),

    el("div", { class: "money" },
      cell("Invoiced", money(po.invoiced),
           `${po.pct_invoiced}% of the PO — this is the burn`),
      cell("Approved, unbilled", money(po.approved_unbilled),
           "earned, sitting in our queue"),
      cell("Submitted, pending", money(po.submitted_pending),
           "not approved, not earned"),
      cell("Remaining", money(po.remaining), "against invoiced"),
      cell("Projected remaining", money(po.projected_remaining),
           "once the backlog is billed", over)),

    over ? el("p", { class: "pill bad", style: "margin-top:11px" },
      `Already over-committed by ${money(Math.abs(po.projected_remaining))}`) : null,
    !over && soon ? el("p", { class: "pill warn", style: "margin-top:11px" },
      po.days_remaining <= 30 ? "Expires within a month" : "Expires within 90 days") : null,

    opts.actions !== false ? el("div", { style: "margin-top:13px;display:flex;gap:8px" },
      Number(po.approved_unbilled) > 0
        ? el("button", { class: "send", onclick: () => draftFor(po) },
            `Draft an invoice for ${money(po.approved_unbilled)}`)
        : null,
      el("button", { class: "send", style: "background:var(--panel-2);color:var(--ink)",
        onclick: () => go("invoices") }, "Invoices")) : null);
}

const leg = (tone, label, amount, opacity) => el("span", {},
  el("i", { style: `background:var(--${tone});opacity:${opacity ?? 1}` }),
  `${label} ${money(amount)}`);

const cell = (k, v, sub, neg) => el("div", {},
  el("div", { class: "k" }, k),
  el("div", { class: "v" + (neg ? " neg" : "") }, v),
  el("div", { class: "meta", style: "font-size:11.5px" }, sub));

async function draftFor(po) {
  const r = await api("/api/invoices/draft", {
    method: "POST", body: JSON.stringify({ purchase_order_id: po.purchase_order_id }) });
  if (r.nothing_to_bill) return alert(r.message);
  if (r.error) return alert(r.error);
  go("invoice", r.id);
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


// ------------------------------------------------------------ timesheets

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const isoDay = (d) => d.toISOString().slice(0, 10);
// Weeks end on Sunday. Given any date, the Sunday that closes its week.
function weekEndingOf(date = new Date()) {
  const d = new Date(date);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + ((7 - d.getDay()) % 7));
  return d;
}
function daysOfWeek(weekEnding) {
  const end = new Date(weekEnding);
  end.setHours(12, 0, 0, 0);
  return DAYS.map((_, i) => {
    const d = new Date(end);
    d.setDate(end.getDate() - 6 + i);
    return d;
  });
}

// The consultant's week. Rows are what the time was charged to; columns are the
// seven days. Adding a row is how you allocate to a second project or PO.
async function timesheetView(weekEnding, contactId) {
  const me = await api("/api/me");
  // Without a signed-in consultant, work on behalf of whoever is on payroll.
  const consultants = await api("/api/contacts?on_payroll=1&limit=50");
  const who = contactId || consultants[0]?.id;
  if (!who) {
    return el("div", { class: "pane muted" },
      "Nobody is on payroll yet, so there is no week to fill in.");
  }
  const we = weekEnding || isoDay(weekEndingOf());

  const [ts, targets] = await Promise.all([
    api("/api/timesheets", { method: "POST",
      body: JSON.stringify({ contact_id: who, week_ending: we }) }),
    api(`/api/allocation-targets?contact_id=${who}&week_ending=${we}`),
  ]);
  const full = await api(`/api/timesheets/${ts.id}`);
  const dates = daysOfWeek(we);
  const editable = ["draft", "rejected"].includes(full.status);

  // A row is one allocation target. Start from what is already on the week, then
  // offer the rest so a consultant can add a project without hunting for it.
  const key = (t) => `${t.placement_id}|${t.purchase_order_id || ""}`;
  const rows = new Map();
  for (const t of targets) rows.set(key(t), { target: t, hours: {} });
  for (const e of full.entries) {
    const k = `${e.placement_id}|${e.purchase_order_id || ""}`;
    if (!rows.has(k)) {
      rows.set(k, { target: {
        placement_id: e.placement_id, purchase_order_id: e.purchase_order_id,
        project_name: e.project_name, account_name: e.account_name,
        po_number: e.po_number }, hours: {} });
    }
    rows.get(k).hours[isoDay(new Date(e.work_date))] = Number(e.hours);
  }
  // Only show rows that have time on them, plus the ones the consultant adds.
  const shown = new Set([...rows.entries()]
    .filter(([, r]) => Object.values(r.hours).some((h) => h > 0))
    .map(([k]) => k));
  if (!shown.size && rows.size) shown.add([...rows.keys()][0]);

  const table = el("table", { class: "wk" });
  const status = el("span", { class: "pill" }, full.status.replace(/_/g, " "));
  const totalOut = el("span", { class: "muted" }, "");

  function totals() {
    const perDay = {}, perRow = {};
    for (const k of shown) {
      const r = rows.get(k);
      perRow[k] = 0;
      for (const d of dates) {
        const h = Number(r.hours[isoDay(d)]) || 0;
        perDay[isoDay(d)] = (perDay[isoDay(d)] || 0) + h;
        perRow[k] += h;
      }
    }
    const week = Object.values(perDay).reduce((a, b) => a + b, 0);
    return { perDay, perRow, week };
  }

  function draw() {
    const { perDay, perRow, week } = totals();
    table.replaceChildren(
      el("thead", {}, el("tr", {},
        el("th", { class: "tgt" }, "Charged to"),
        ...dates.map((d, i) => el("th", {},
          DAYS[i], el("div", { class: "muted", style: "font-weight:400" },
            d.toLocaleDateString(undefined, { day: "numeric", month: "short" })))),
        el("th", {}, "Total"))),
      el("tbody", {}, ...[...shown].map((k) => {
        const r = rows.get(k);
        return el("tr", {},
          el("td", { class: "tgt" },
            el("strong", {}, r.target.project_name),
            el("span", {},
              [r.target.account_name, r.target.po_number || "no PO"]
                .filter(Boolean).join(" · "))),
          ...dates.map((d) => {
            const iso = isoDay(d);
            const v = r.hours[iso] || 0;
            return el("td", {}, el("input", {
              class: "h" + (v ? "" : " zero"), type: "number", min: "0", max: "24",
              step: "0.25", value: v || "", disabled: editable ? null : "",
              onchange: (e) => {
                r.hours[iso] = Number(e.target.value) || 0;
                draw();
              },
            }));
          }),
          el("td", { class: "rowtot" }, perRow[k] || ""));
      })),
      el("tfoot", {}, el("tr", {},
        el("td", { class: "tgt" }, "Total"),
        ...dates.map((d) => el("td", {
          class: "rowtot" + ((perDay[isoDay(d)] || 0) > 24 ? " over" : "") },
          perDay[isoDay(d)] || "")),
        el("td", { class: "rowtot" }, week || ""))));
    totalOut.textContent = week
      ? `${week} hours this week` : "Nothing entered yet";
  }
  draw();

  const unusedTargets = () => targets.filter((t) => !shown.has(key(t)));

  const addRow = el("select", {
    class: "ghost", onchange: (e) => {
      if (!e.target.value) return;
      shown.add(e.target.value);
      e.target.value = "";
      go("timesheet", null, { week: we, contact: who });
    },
  }, el("option", { value: "" }, "Charge to another project…"),
     ...unusedTargets().map((t) => el("option", { value: key(t) },
       `${t.project_name}${t.po_number ? " · " + t.po_number : ""}`)));

  async function save(thenSubmit) {
    const entries = [];
    for (const k of shown) {
      const r = rows.get(k);
      for (const d of dates) {
        const h = Number(r.hours[isoDay(d)]) || 0;
        if (!h) continue;
        entries.push({ placement_id: r.target.placement_id,
                       purchase_order_id: r.target.purchase_order_id || null,
                       work_date: isoDay(d), hours: h });
      }
    }
    const r = await api(`/api/timesheets/${ts.id}/entries`, {
      method: "PUT", body: JSON.stringify({ entries }) });
    if (r.error) return alert(r.error);
    if (thenSubmit) {
      const sub = await api(`/api/timesheets/${ts.id}/submit`, { method: "POST" });
      if (sub.error) return alert(sub.error);
      const unrouted = (sub.packets || []).filter((p) => !p.approver_contact_id);
      if (unrouted.length) {
        alert(`Submitted, but ${unrouted.length} project has no approving manager on ` +
              `file. Somebody has to name one before that part can be approved.`);
      }
    }
    go("timesheet", null, { week: we, contact: who });
  }

  const shift = (n) => {
    const d = new Date(we); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n * 7);
    go("timesheet", null, { week: isoDay(d), contact: who });
  };

  return el("div", { class: "pane" },
    el("div", { class: "wkbar" },
      el("button", { class: "ghost", onclick: () => shift(-1) }, "← Previous"),
      el("strong", {},
        "Week ending " + new Date(we).toLocaleDateString(undefined,
          { day: "numeric", month: "long", year: "numeric" })),
      el("button", { class: "ghost", onclick: () => shift(1) }, "Next →"),
      consultants.length > 1
        ? el("select", { class: "ghost",
            onchange: (e) => go("timesheet", null, { week: we, contact: e.target.value }) },
            ...consultants.map((c) => el("option",
              { value: c.id, selected: c.id === who ? "" : null }, c.full_name)))
        : el("span", { class: "muted" }, consultants[0]?.full_name || ""),
      status, el("span", { class: "grow" }), totalOut),

    table,

    el("div", { class: "wkbar", style: "margin-top:16px" },
      editable ? addRow : null,
      el("span", { class: "grow" }),
      editable
        ? el("button", { class: "ghost", onclick: () => save(false) }, "Save draft")
        : null,
      editable
        ? el("button", { class: "send", onclick: () => save(true) },
            "Submit for approval")
        : el("span", { class: "muted" },
            full.status === "submitted"
              ? "Waiting on the client. It cannot be changed while it is out."
              : "This week has been decided.")),

    full.approvals.length
      ? section("Approval", full.approvals.map((a) =>
          el("div", { class: "packet" },
            el("div", { class: "hd" },
              el("h3", {}, a.project_name),
              el("span", { class: "pill " + (a.status === "approved" ? "good"
                : a.status === "rejected" ? "bad" : "warn") }, a.status),
              el("span", { class: "muted" },
                `${a.hours} hours · ${money(a.value)}`),
              el("span", { class: "grow" }),
              el("span", { class: "muted" },
                a.approver_name
                  ? (a.decided_by ? "decided by " + a.decided_by
                                  : "with " + a.approver_name)
                  : "no approver on file")),
            a.note ? el("p", { style: "margin:8px 0 0" }, a.note) : null)))
      : null,

    full.status === "rejected"
      ? el("p", { class: "pill bad", style: "margin-top:12px" },
          "Sent back. Fix it and submit again.")
      : null);
}

// The client manager's side. Each row is one project's part of one week, which
// is the unit they actually sign off.
async function approvalsView() {
  const [pending, decided] = await Promise.all([
    api("/api/approvals?status=pending"),
    api("/api/approvals?status=approved"),
  ]);

  const card = (a) => {
    const decide = async (decision) => {
      const by = a.approver_name ||
        prompt("Which manager at the client is deciding?");
      if (!by) return;
      const note = decision === "rejected"
        ? prompt("Why is it going back? The consultant will see this.") : null;
      if (decision === "rejected" && !note) return;
      const r = await api(`/api/approvals/${a.approval_id}/decide`, {
        method: "POST",
        body: JSON.stringify({ decision, decided_by: by, note }) });
      if (r.error) return alert(r.error);
      go("approvals");
    };
    return el("div", { class: "packet" },
      el("div", { class: "hd" },
        el("h3", {}, a.consultant),
        el("span", { class: "muted" },
          `week ending ${day(a.week_ending)} · ${a.project_name}`),
        el("span", { class: "grow" }),
        el("span", {}, el("strong", {}, a.hours + " hours"), " · ", money(a.value))),
      el("div", { class: "meta", style: "margin-top:4px" },
        a.account_name + " · " +
        (a.approver_name ? "with " + a.approver_name : "no approving manager on file")),
      el("div", { class: "days" },
        ...(a.days || []).map((d) => el("span", { class: "day" },
          new Date(d.work_date).toLocaleDateString(undefined,
            { weekday: "short", day: "numeric", month: "short" }),
          " ", el("b", {}, d.hours), "h"))),
      a.status === "pending"
        ? el("div", { style: "margin-top:12px;display:flex;gap:8px" },
            el("button", { class: "send", onclick: () => decide("approved") },
              "Approve " + money(a.value)),
            el("button", { class: "ghost", onclick: () => decide("rejected") },
              "Send back"))
        : el("div", { style: "margin-top:10px;display:flex;gap:10px;align-items:center" },
          el("span", { class: "meta" },
            `${a.status} by ${a.decided_by || "—"}` + (a.note ? " — " + a.note : "")),
          a.status === "approved"
            ? el("button", { class: "ghost", onclick: async () => {
                const reason = prompt(
                  "This time is locked. Why does it need to be reopened?");
                if (!reason) return;
                const r = await api("/api/unlock-requests", {
                  method: "POST",
                  body: JSON.stringify({ approval_id: a.approval_id, reason }) });
                if (r.error) return alert(r.error);
                go("unlocks");
              } }, "Request an unlock")
            : null));
  };

  const owed = pending.reduce((a, x) => a + Number(x.value), 0);
  const unrouted = pending.filter((p) => !p.approver_name);

  return el("div", { class: "pane" },
    el("div", { class: "card" },
      el("h3", {}, money(owed) + " waiting on client approval"),
      el("div", { class: "meta" },
        `${pending.length} week${pending.length === 1 ? "" : "s"} of work across ` +
        `${new Set(pending.map((p) => p.project_name)).size} project(s). ` +
        "None of it can be billed until it is approved."),
      unrouted.length
        ? el("p", { class: "pill bad", style: "margin-top:10px" },
            `${unrouted.length} of these has no approving manager on file`)
        : null),
    pending.length
      ? el("div", {}, ...pending.map(card))
      : el("p", { class: "muted" }, "Nothing is waiting on the client."),
    decided.length
      ? section("Recently approved", decided.slice(0, 8).map(card))
      : null);
}

async function invoicesView() {
  const list = await api("/api/invoices");
  const aging = await api("/api/invoice-aging");
  const owed = aging.reduce((a, i) => a + Number(i.outstanding), 0);
  const late = aging.filter((i) => i.days_overdue > 0);
  return el("div", { class: "pane" },
    el("div", { class: "card" },
      el("h3", {}, money(owed) + " outstanding"),
      el("div", { class: "meta" },
        late.length
          ? `${late.length} invoice${late.length === 1 ? "" : "s"} past due, ` +
            money(late.reduce((a, i) => a + Number(i.outstanding), 0))
          : "Nothing past due.")),
    el("table", { class: "grid" },
      el("thead", {}, el("tr", {}, ...["Invoice", "Account", "PO", "Period", "Total",
        "Outstanding", "Status"].map((h) => el("th", {}, h)))),
      el("tbody", {}, ...list.map((i) => el("tr", { style: "cursor:pointer",
          onclick: () => go("invoice", i.id) },
        el("td", {}, el("strong", {}, i.invoice_number)),
        el("td", { class: "muted" }, i.account_name),
        el("td", { class: "muted" }, i.po_number || "—"),
        el("td", { class: "muted" },
          i.period_start ? `${day(i.period_start)} – ${day(i.period_end)}` : "—"),
        el("td", { class: "num" }, money(i.total)),
        el("td", { class: "num" }, money(i.outstanding)),
        el("td", {}, el("span", {
          class: "pill " + (i.status === "paid" ? "good"
            : i.days_overdue > 0 ? "bad" : i.status === "draft" ? "" : "warn") },
          i.status === "part_paid" ? "part paid" : i.status,
          i.days_overdue > 0 ? ` · ${i.days_overdue}d late` : "")))))));
}

async function invoiceView(id) {
  const inv = await api(`/api/invoices/${id}`);
  const act = async (path, body) => {
    const r = await api(`/api/invoices/${id}${path}`, {
      method: "POST", body: JSON.stringify(body || {}) });
    if (r.error) return alert(r.error);
    go("invoice", id);
  };
  return el("div", { class: "pane" },
    el("div", { class: "card" },
      el("h3", {}, inv.invoice_number),
      el("div", { class: "meta" },
        `${inv.account_name}${inv.project_name ? " · " + inv.project_name : ""}` +
        (inv.po_number ? " · " + inv.po_number : "")),
      el("div", { class: "money" },
        cell("Total", money(inv.total),
             inv.period_start ? `${day(inv.period_start)} – ${day(inv.period_end)}` : ""),
        cell("Paid", money(inv.paid), inv.payments.length + " payment(s)"),
        inv.status === "draft"
          ? cell("Outstanding", "—", "nothing is owed until it is issued")
          : cell("Outstanding", money(inv.outstanding),
                 inv.due_date ? "due " + day(inv.due_date) : "no due date")),
      el("div", { style: "margin-top:14px;display:flex;gap:8px;flex-wrap:wrap" },
        inv.status === "draft"
          ? el("button", { class: "send", onclick: () => act("/send") },
              "Send it — this burns the PO")
          : null,
        ["sent", "part_paid"].includes(inv.status)
          ? el("button", { class: "send", onclick: () => {
              const a = prompt(`Payment amount (outstanding ${money(inv.outstanding)})`,
                               inv.outstanding);
              if (a) act("/payments", { amount: Number(a), method: "ACH" });
            } }, "Record a payment")
          : null,
        inv.status !== "void" && inv.status !== "paid"
          ? el("button", { class: "send",
              style: "background:var(--panel-2);color:var(--ink)",
              onclick: () => {
                const r = prompt("Why is this being voided?");
                if (r) act("/void", { reason: r });
              } }, "Void")
          : null),
      inv.status === "draft"
        ? el("p", { class: "muted", style: "margin:12px 0 0" },
            "A draft has not gone to the client, so it does not count against the " +
            "purchase order yet.")
        : null,
      inv.status === "void"
        ? el("p", { class: "pill bad", style: "margin-top:12px" },
            "Voided" + (inv.void_reason ? " — " + inv.void_reason : "") +
            ". Its weeks are billable again.")
        : null),

    section("Lines", [el("table", { class: "grid" },
      el("thead", {}, el("tr", {}, ...["Description", "Hours", "Rate", "Amount"]
        .map((h) => el("th", {}, h)))),
      el("tbody", {}, ...inv.lines.map((l) => el("tr", {},
        el("td", {}, l.description),
        el("td", { class: "num" }, l.quantity ?? "—"),
        el("td", { class: "num" }, l.unit_rate ? "$" + Number(l.unit_rate).toFixed(2) : "—"),
        el("td", { class: "num" }, money(l.amount))))))]),

    section("Payments", [el("table", { class: "grid" }, el("tbody", {},
      ...inv.payments.map((p) => el("tr", {},
        el("td", {}, day(p.received_at)),
        el("td", { class: "muted" }, p.method || ""),
        el("td", { class: "muted" }, p.reference || ""),
        el("td", { class: "num" }, money(p.amount))))))]));
}

// -------------------------------------------------------------- audit trail

const AUDIT_ACTION = { insert: "created", update: "changed", delete: "removed" };

async function auditView(filters = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
  qs.set("limit", "200");
  const rows = await api("/api/audit?" + qs.toString());

  const search = el("input", {
    placeholder: "Search the trail…", value: filters.q || "",
    style: "flex:1;max-width:22rem;padding:7px 11px;border:1px solid var(--line);" +
           "border-radius:8px;background:var(--panel);color:var(--ink);font:inherit",
    onkeydown: (e) => { if (e.key === "Enter") go("audit", null, { q: e.target.value }); },
  });

  return el("div", { class: "pane" },
    el("div", { class: "wkbar" },
      search,
      el("select", { class: "ghost",
        onchange: (e) => go("audit", null, { ...filters, action: e.target.value }) },
        ...[["", "Everything"], ["insert", "Created"], ["update", "Changed"],
            ["delete", "Removed"]].map(([v, t]) =>
          el("option", { value: v, selected: filters.action === v ? "" : null }, t))),
      el("span", { class: "grow" }),
      el("span", { class: "muted" },
        `${rows.length} entr${rows.length === 1 ? "y" : "ies"}`)),

    el("p", { class: "muted", style: "margin:0 0 14px" },
      "Written by database triggers on every table, so a change made by the app, " +
      "the assistant, a script or a person at a terminal all land here the same way. " +
      "Nothing can edit or remove a line once it is written."),

    el("table", { class: "grid" },
      el("thead", {}, el("tr", {}, ...["When", "Who", "What", "Record", "Fields", "Why"]
        .map((h) => el("th", {}, h)))),
      el("tbody", {}, ...rows.map((r) => el("tr", {},
        el("td", { class: "muted", style: "white-space:nowrap" },
          new Date(r.occurred_at).toLocaleString(undefined,
            { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })),
        el("td", {}, r.actor === "unattributed"
          ? el("span", { class: "muted" }, "unattributed") : r.actor),
        el("td", {}, AUDIT_ACTION[r.action] || r.action, " ",
          el("strong", {}, r.table_name.replace(/_/g, " "))),
        el("td", { class: "muted" }, r.label || ""),
        el("td", { class: "muted" }, (r.changed || []).filter((c) =>
          c !== "updated_at").join(", ")),
        el("td", { class: "muted" }, r.reason || ""))))));
}

// ------------------------------------------------------------------ unlocks

async function unlocksView() {
  const [pending, decided] = await Promise.all([
    api("/api/unlock-requests?status=pending"),
    api("/api/unlock-requests?status=granted"),
  ]);
  const me = await api("/api/me");
  const isAdmin = me?.role === "admin";

  const card = (u) => el("div", { class: "packet" },
    el("div", { class: "hd" },
      el("h3", {}, u.consultant),
      el("span", { class: "muted" },
        `week ending ${day(u.week_ending)} · ${u.project_name}`),
      el("span", { class: "grow" }),
      el("span", {}, money(u.value), " locked")),
    el("div", { class: "meta", style: "margin-top:4px" },
      `${u.account_name} · asked by ${u.requested_by_name || "—"} ` +
      `on ${day(u.created_at)}`),
    el("p", { style: "margin:10px 0 0" }, u.reason),
    u.billed_lines > 0
      ? el("p", { class: "pill bad", style: "margin-top:10px" },
          "Already invoiced — this cannot be unlocked until the invoice is voided")
      : null,
    u.status === "pending"
      ? el("div", { style: "margin-top:12px;display:flex;gap:8px;align-items:center" },
          // An admin cannot grant their own request. The button is not offered
          // rather than offered and then refused.
          isAdmin && u.requested_by !== me?.id
            ? el("button", { class: "send", onclick: () => decide(u, "granted") },
                "Grant the unlock")
            : null,
          isAdmin && u.requested_by !== me?.id
            ? el("button", { class: "ghost", onclick: () => decide(u, "denied") }, "Deny")
            : null,
          !isAdmin
            ? el("span", { class: "muted" },
                "Only an admin can decide this. You are signed in as " +
                me.role.replace("_", " ") + ".")
            : null,
          isAdmin && u.requested_by === me?.id
            ? el("span", { class: "muted" },
                "You raised this one, so somebody else has to grant it.")
            : null)
      : el("div", { style: "margin-top:12px;display:flex;gap:8px;align-items:center" },
          el("span", { class: "pill good" }, "granted by " + (u.decided_by_name || "—")),
          el("button", { class: "ghost", onclick: async () => {
            const r = await api(`/api/approvals/${u.approval_id}/reopen`,
                                { method: "POST" });
            if (r.error) return alert(r.error);
            go("unlocks");
          } }, "Reopen the week now"),
          el("span", { class: "muted" }, "one use, expires " +
            (u.expires_at ? day(u.expires_at) : "—"))));

  async function decide(u, decision) {
    const note = prompt(decision === "granted"
      ? "Note for the record (optional)" : "Why is this being denied?");
    if (decision === "denied" && !note) return;
    const r = await api(`/api/unlock-requests/${u.id}/decide`, {
      method: "POST", body: JSON.stringify({ decision, note }) });
    if (r.error) return alert(r.error);
    go("unlocks");
  }

  return el("div", { class: "pane" },
    el("div", { class: "card" },
      el("h3", {}, "Approved time is locked"),
      el("div", { class: "meta" },
        "Once a client manager approves a week, those days are frozen — nobody can " +
        "change or delete them, including the consultant who entered them. Opening " +
        "them again takes an admin, and the grant works once."),
      !isAdmin
        ? el("p", { class: "pill warn", style: "margin-top:10px" },
            "You are not an admin, so you can raise a request but not grant one")
        : null),
    pending.length
      ? section("Waiting on an admin", pending.map(card))
      : el("p", { class: "muted" }, "No unlock requests are waiting."),
    decided.length ? section("Granted, not yet used", decided.map(card)) : null);
}

// ------------------------------------------------------------------ routing
const TITLES = { chat: "Project Assistant", accounts: "Accounts", projects: "Projects",
  contacts: "Contacts", documents: "Documents", pos: "Purchase orders",
  timesheet: "My week", approvals: "Approvals", invoices: "Invoices",
  unlocks: "Unlock requests", audit: "Audit trail" };

async function go(view, id = null, opts = {}) {
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
  else if (view === "timesheet") node = await timesheetView(opts.week, opts.contact);
  else if (view === "approvals") node = await approvalsView();
  else if (view === "unlocks") node = await unlocksView();
  else if (view === "audit") node = await auditView(opts);
  else if (view === "invoices") node = await invoicesView();
  else if (view === "invoice") { node = await invoiceView(id); $("#title").textContent = "Invoice"; }
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
