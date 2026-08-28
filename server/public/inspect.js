// The glass box.
//
// Reads the same running system the workspace does, and shows what it actually
// did: the requests, the reasoning, the tools, the SQL underneath the tools,
// what each step cost and how long it took.

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
const api = (p, o) => fetch(p, o).then((r) => r.json());
const ms = (n) => n === undefined || n === null ? "" :
  n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(n < 10000 ? 2 : 1)} s`;
const usd = (n) => "$" + Number(n || 0).toFixed(4);
const num = (n) => Number(n || 0).toLocaleString();
const jsonBlock = (v) => el("pre", { class: "code" },
  typeof v === "string" ? v : JSON.stringify(v, null, 2));

const state = { tab: "turns", traces: [], selected: null };

// ------------------------------------------------------------------- turns
function traceRow(t) {
  const tokens = (t.usage?.input_tokens || t.input_tokens || 0) +
                 (t.usage?.output_tokens || t.output_tokens || 0);
  const cost = t.costUsd ?? t.cost_usd ?? 0;
  return el("div", {
    class: "traceitem" + (state.selected === t.id ? " on" : ""),
    onclick: () => selectTrace(t.id),
  },
    el("div", { class: "p" }, t.prompt || "(no prompt)"),
    el("div", { class: "m" },
      el("span", { class: "num" }, ms(t.durationMs ?? t.duration_ms)),
      el("span", { class: "num" }, num(tokens) + " tok"),
      el("span", { class: "num" }, usd(cost)),
      el("span", {}, `${(t.steps || []).length} steps`),
      t.model ? el("span", {}, t.model) : null,
      t.error ? el("span", { class: "err" }, "error") : null));
}

function stepNode(s) {
  if (s.type === "llm_request") {
    const u = s.usage || {};
    return el("li", { class: "llm" },
      el("div", { class: "hd" },
        el("span", { class: "lbl" }, `Model call ${s.iteration + 1}`),
        el("span", { class: "sm num" }, ms(s.ms)),
        el("span", { class: "sm num" },
          `${num(u.input_tokens)} in · ${num(u.output_tokens)} out` +
          (u.cache_read_input_tokens ? ` · ${num(u.cache_read_input_tokens)} cached` : "")),
        el("span", { class: "sm num" }, usd(s.costUsd)),
        el("span", { class: "sm" }, s.stopReason || "")),
      el("div", { class: "sm" },
        `${s.model} · effort ${s.effort} · ${s.messageCount} messages · ` +
        `${s.toolCount} tools offered`),
      s.thinking ? el("details", {},
        el("summary", {}, "Reasoning"),
        el("pre", { class: "code" }, s.thinking)) : null,
      s.text ? el("details", {},
        el("summary", {}, "Text produced in this call"),
        el("pre", { class: "code" }, s.text)) : null);
  }
  if (s.type === "tool_call") {
    return el("li", { class: s.ok === false ? "err" : "tool" },
      el("div", { class: "hd" },
        el("span", { class: "lbl" }, s.tool),
        el("span", { class: "sm num" }, ms(s.ms)),
        el("span", { class: s.ok === false ? "sm err" : "sm" },
          s.resultSummary || s.error || (s.ms === undefined ? "running…" : ""))),
      el("details", {}, el("summary", {}, "Arguments the model chose"),
        jsonBlock(s.input)),
      s.result !== undefined ? el("details", {},
        el("summary", {}, "What came back"), jsonBlock(s.result)) : null);
  }
  if (s.type === "sql") {
    return el("li", { class: s.error ? "err" : "sql" },
      el("div", { class: "hd" },
        el("span", { class: "lbl" }, s.readOnly ? "SQL (read-only role)" : "SQL"),
        el("span", { class: "sm num" }, ms(s.ms)),
        el("span", { class: "sm num" },
          s.rowCount !== undefined
            ? `${s.rowCount} row${s.rowCount === 1 ? "" : "s"}` : ""),
        s.error ? el("span", { class: "sm err" }, s.error) : null),
      el("pre", { class: "code" }, s.sql),
      s.params && s.params.length
        ? el("details", {}, el("summary", {}, "Parameters"), jsonBlock(s.params))
        : null);
  }
  if (s.type === "transaction") {
    return el("li", { class: s.state === "rollback" ? "err" : "" },
      el("div", { class: "hd" },
        el("span", { class: "lbl" }, "Transaction " + (s.state || "")),
        el("span", { class: "sm num" }, ms(s.ms))));
  }
  if (s.type === "error") {
    return el("li", { class: "err" },
      el("div", { class: "hd" }, el("span", { class: "lbl" }, "Error")),
      el("pre", { class: "code" }, s.message));
  }
  return el("li", {}, el("div", { class: "hd" },
    el("span", { class: "lbl" }, s.type)), jsonBlock(s));
}

function traceDetail(t) {
  if (!t) return el("div", { class: "detail muted" },
    "Pick a turn on the left. Ask the assistant something in the workspace and it " +
    "will appear here as it runs.");
  const u = t.usage || {
    input_tokens: t.input_tokens, output_tokens: t.output_tokens,
    cache_read_input_tokens: t.cache_read_tokens,
  };
  const modelCalls = (t.steps || []).filter((s) => s.type === "llm_request").length;
  const toolCalls = (t.steps || []).filter((s) => s.type === "tool_call").length;
  const sqlCount = (t.steps || []).filter((s) => s.type === "sql").length;
  return el("div", { class: "detail" },
    el("div", { class: "kpis" },
      kpi("Wall clock", ms(t.durationMs ?? t.duration_ms)),
      kpi("Cost", usd(t.costUsd ?? t.cost_usd)),
      kpi("Input tokens", num(u.input_tokens)),
      kpi("Output tokens", num(u.output_tokens)),
      kpi("Served from cache", num(u.cache_read_input_tokens)),
      kpi("Model calls", modelCalls),
      kpi("Tool calls", toolCalls),
      kpi("SQL statements", sqlCount)),
    el("div", { class: "card" },
      el("div", { class: "navsec", style: "padding:0 0 4px" }, "The question"),
      el("div", {}, t.prompt)),
    t.error ? el("div", { class: "card err" }, t.error) : null,
    el("div", { class: "navsec", style: "padding-left:0" }, "What happened, in order"),
    el("ul", { class: "tl" }, ...(t.steps || []).map(stepNode)));
}

const kpi = (k, v) => el("div", { class: "kpi" },
  el("div", { class: "k" }, k), el("div", { class: "v" }, v));

async function selectTrace(id) {
  state.selected = id;
  const full = await api(`/api/inspect/traces/${id}`);
  const idx = state.traces.findIndex((t) => t.id === id);
  if (idx >= 0) state.traces[idx] = full;
  renderTurns();
}

function renderTurns() {
  const list = el("div", { class: "tracelist" },
    ...(state.traces.length
      ? state.traces.map(traceRow)
      : [el("div", { class: "traceitem muted" }, "No turns yet.")]));
  const sel = state.traces.find((t) => t.id === state.selected);
  $("#body").replaceChildren(el("div", { class: "split" }, list, traceDetail(sel)));
}

// -------------------------------------------------------------------- data
async function renderData() {
  const [schema, stats] = await Promise.all([
    api("/api/inspect/schema"), api("/api/inspect/stats"),
  ]);
  const rowsByTable = Object.fromEntries((stats.tables || []).map((t) => [t.table, t.rows]));

  const out = el("textarea", { readonly: "", class: "code",
    style: "display:none;width:100%;min-height:200px" });
  const result = el("div", {});
  const input = el("textarea", {
    style: "width:100%;min-height:88px;font-family:var(--mono);font-size:13px;" +
           "background:var(--panel);color:var(--ink);border:1px solid var(--line);" +
           "border-radius:9px;padding:10px",
    placeholder: "select a.name, count(*) from account a join project p " +
                 "on p.account_id = a.id group by 1",
  });
  const run = async () => {
    result.replaceChildren(el("div", { class: "muted" }, "Running…"));
    const r = await api("/api/inspect/sql", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql: input.value }),
    });
    if (r.error) return result.replaceChildren(el("div", { class: "card err" }, r.error));
    if (!r.rows?.length)
      return result.replaceChildren(el("div", { class: "card muted" }, "No rows."));
    const cols = Object.keys(r.rows[0]);
    result.replaceChildren(
      el("div", { class: "muted", style: "margin:8px 0" },
        `${r.row_count} rows${r.truncated ? " · " + r.truncated : ""}`),
      el("table", { class: "grid" },
        el("thead", {}, el("tr", {}, ...cols.map((c) => el("th", {}, c)))),
        el("tbody", {}, ...r.rows.map((row) => el("tr", {},
          ...cols.map((c) => el("td", { class: "num" },
            row[c] === null ? "—" :
            typeof row[c] === "object" ? JSON.stringify(row[c]) : String(row[c]))))))));
  };

  $("#body").replaceChildren(el("div", { class: "detail" },
    el("div", { class: "kpis" },
      kpi("Tables", Object.keys(schema).length),
      kpi("Rows stored", num(Object.values(rowsByTable).reduce((a, b) => a + Number(b), 0))),
      kpi("Domain events", num(stats.events)),
      kpi("Assistant turns", num(stats.turns))),

    el("div", { class: "card" },
      el("h3", {}, "Query it yourself"),
      el("p", { class: "meta" },
        "This runs through the same SELECT-only database role the assistant uses. " +
        "A write is refused by Postgres, not by a check in the application."),
      input,
      el("div", { style: "margin-top:9px" },
        el("button", { class: "send", onclick: run }, "Run"))),
    result,

    el("div", { class: "navsec", style: "padding-left:0;margin-top:18px" },
      "Schema, read live from the database"),
    ...Object.entries(schema).sort().map(([name, t]) =>
      el("details", { class: "card" },
        el("summary", {},
          el("strong", {}, name), " ",
          el("span", { class: "muted" },
            `${t.columns.length} columns` +
            (rowsByTable[name] !== undefined
              ? ` · ${num(rowsByTable[name])} row${Number(rowsByTable[name]) === 1 ? "" : "s"}`
              : "") +
            (t.type === "VIEW" ? " · view" : ""))),
        el("table", { class: "grid", style: "margin-top:8px" },
          el("tbody", {}, ...t.columns.map((c) => el("tr", {},
            el("td", {}, c.name),
            el("td", { class: "muted num" }, c.type),
            el("td", { class: "muted" }, c.nullable ? "" : "required"))))))),
    out));
}

// ------------------------------------------------------------------- tools
async function renderTools() {
  const tools = await api("/api/inspect/tools");
  $("#body").replaceChildren(el("div", { class: "detail" },
    el("p", { class: "muted" },
      `These ${tools.length} tool definitions are sent to the model verbatim on every ` +
      `request. The descriptions are the only thing telling it how this business works, ` +
      `so they are worth reading.`),
    ...tools.map((t) => el("details", { class: "card" },
      el("summary", {}, el("strong", {}, t.name)),
      el("p", { style: "margin:8px 0" }, t.description),
      jsonBlock(t.input_schema)))));
}

// ------------------------------------------------------------------ prompt
async function renderPrompt() {
  const p = await api("/api/inspect/prompt");
  $("#body").replaceChildren(el("div", { class: "detail" },
    el("div", { class: "kpis" },
      kpi("Model", p.model),
      kpi("Effort", p.effort),
      kpi("Max output", num(p.max_tokens)),
      kpi("System prompt", num(p.system_chars) + " chars")),
    el("div", { class: "card" },
      el("h3", {}, "Request settings"),
      jsonBlock({ model: p.model, thinking: p.thinking,
                  output_config: { effort: p.effort },
                  max_tokens: p.max_tokens })),
    el("div", { class: "card" },
      el("h3", {}, "Pricing used to cost each turn"),
      el("p", { class: "meta" }, "US dollars per million tokens."),
      jsonBlock(p.pricing_usd_per_mtok)),
    el("div", { class: "card" },
      el("h3", {}, "The system prompt, exactly as sent"),
      el("p", { class: "meta" },
        "Cached on every request, so repeat turns pay a tenth of the input price for it."),
      el("pre", { class: "code" }, p.system))));
}

// ------------------------------------------------------------------ events
async function renderEvents() {
  const events = await api("/api/events?limit=100");
  $("#body").replaceChildren(el("div", { class: "detail" },
    el("p", { class: "muted" },
      "Append-only log of what the system did. Written inside the same transaction as " +
      "the change itself, so it cannot disagree with the data."),
    el("table", { class: "grid" },
      el("thead", {}, el("tr", {}, ...["When", "Event", "Subject", "Detail", "By", "Turn"]
        .map((h) => el("th", {}, h)))),
      el("tbody", {}, ...events.map((e) => el("tr", {},
        el("td", { class: "muted num" },
          new Date(e.occurred_at).toLocaleString()),
        el("td", {}, el("strong", {}, e.kind)),
        el("td", { class: "muted" }, e.subject_type || ""),
        el("td", { class: "muted" },
          Object.keys(e.payload || {}).length ? JSON.stringify(e.payload) : ""),
        el("td", { class: "muted" }, e.actor || ""),
        el("td", {}, e.trace_id
          ? el("a", { href: "#", onclick: (ev) => { ev.preventDefault();
              state.tab = "turns"; selectTab("turns"); selectTrace(e.trace_id); } },
              e.trace_id)
          : "")))))));
}

// ------------------------------------------------------------------ routing
const TABS = {
  turns: ["Turns", "Every model call, tool call and SQL statement", renderTurns],
  data: ["Data", "The live schema, and a query console on the read-only role", renderData],
  tools: ["Tools", "What the model is given to work with", renderTools],
  prompt: ["Prompt", "The instructions and settings behind every answer", renderPrompt],
  events: ["Events", "The append-only record of what changed", renderEvents],
};

async function selectTab(tab) {
  state.tab = tab;
  const [title, sub, render] = TABS[tab];
  $("#title").textContent = title;
  $("#subtitle").textContent = sub;
  document.querySelectorAll(".nav .item[data-tab]").forEach((b) =>
    b.classList.toggle("on", b.dataset.tab === tab));
  $("#body").replaceChildren(el("div", { class: "detail muted" }, "Loading…"));
  await render();
}

document.querySelectorAll(".nav .item[data-tab]").forEach((b) =>
  b.addEventListener("click", () => selectTab(b.dataset.tab)));

// The live feed. Steps land here as the assistant runs, so you can watch a turn
// happen rather than read about it afterwards.
function connect() {
  const es = new EventSource("/api/inspect/stream");
  es.addEventListener("open", () => {
    $("#live").className = "pill good";
    $("#livestate").textContent = "live feed connected";
  });
  es.addEventListener("error", () => {
    $("#live").className = "pill bad";
    $("#livestate").textContent = "live feed dropped, retrying";
  });
  es.addEventListener("event", (m) => {
    const e = JSON.parse(m.data);
    if (e.kind === "step") {
      let t = state.traces.find((x) => x.id === e.traceId);
      if (!t) {
        t = { id: e.traceId, prompt: "(running)", steps: [], usage: {}, costUsd: 0 };
        state.traces.unshift(t);
        if (!state.selected) state.selected = t.id;
      }
      const at = t.steps.findIndex((s) => s.seq === e.step.seq);
      if (at >= 0) t.steps[at] = e.step; else t.steps.push(e.step);
      if (state.tab === "turns") renderTurns();
    } else if (e.kind === "trace_end") {
      const at = state.traces.findIndex((x) => x.id === e.trace.id);
      if (at >= 0) state.traces[at] = e.trace; else state.traces.unshift(e.trace);
      if (state.tab === "turns") renderTurns();
    }
  });
}

(async () => {
  state.traces = await api("/api/inspect/traces");
  const hash = location.hash.slice(1);
  if (hash) state.selected = hash;
  else if (state.traces[0]) state.selected = state.traces[0].id;
  connect();
  await selectTab("turns");
  if (state.selected) selectTrace(state.selected);
})();
