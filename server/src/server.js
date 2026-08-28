// HTTP surface: a REST API over the workspace, an SSE chat endpoint that
// streams the assistant's turn, and the endpoints the inspector reads.
//
// node:http with a small router rather than a framework - the routing here is
// simple enough that a dependency would be more code to understand, not less.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { config, hasApiKey } from "./config.js";
import * as repo from "./repo.js";
import { rows, one, query, close as closeDb } from "./db.js";
import * as trace from "./trace.js";
import { buildTools, toolSchemas, describeSchema, runReadOnlySql } from "./tools.js";
import {
  runTurn, SYSTEM_PROMPT, ensureConversation, loadHistory, saveMessages, listConversations,
} from "./agent.js";
import { ROOT } from "./config.js";

const PUBLIC = path.join(ROOT, "public");

// Who is acting. A real deployment authenticates; here we resolve the single
// seeded admin so ownership and activity attribution are still correct.
let ACTOR = null;
// The acting user's id, or null in a workspace that has no users yet. Every
// actor column is nullable, so an unattributed write is recorded rather than
// refused.
async function actorId() {
  return (await actor())?.id ?? null;
}

async function actor() {
  if (!ACTOR) {
    ACTOR = await one(
      `select id, full_name, email, role from app_user where active order by
        (role = 'admin') desc, created_at limit 1`);
  }
  return ACTOR;
}

const json = (res, code, body) => {
  const s = JSON.stringify(body, null, 2);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(s),
    "cache-control": "no-store",
  });
  res.end(s);
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("body was not valid JSON"); }
}

function sse(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(": open\n\n");
  return (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

// ------------------------------------------------------------------- routing

const routes = [];
const route = (method, pattern, handler) => {
  // /api/accounts/:id -> a regex with a named group
  const keys = [];
  const rx = new RegExp(
    "^" + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
  routes.push({ method, rx, keys, handler });
};

route("GET", "/api/health", async () => ({
  ok: true,
  database: (await one(`select current_database() as db, version() as v`)),
  anthropic_key: hasApiKey() ? "present" : "missing",
  model: config.model,
}));

route("GET", "/api/me", async () => (await actor()) ||
  { full_name: "Unassigned", role: "none",
    note: "No workspace users yet. Seed one before attributing ownership." });
route("GET", "/api/users", async () => repo.listUsers());

route("GET", "/api/accounts", async (_p, q) =>
  repo.listAccounts({
    q: q.get("q"), status: q.get("status"),
    ownerId: q.get("mine") === "1" ? (await actorId()) : null,
    unassigned: q.get("unassigned") === "1",
    limit: Number(q.get("limit") || 50),
  }));
route("GET", "/api/accounts/:id", async (p) =>
  (await repo.getAccount(p.id)) || { error: "not_found" });
route("POST", "/api/accounts", async (_p, _q, body) =>
  repo.insertRecord("account", body, (await actorId())));
route("PATCH", "/api/accounts/:id", async (p, _q, body) =>
  repo.updateRecord("account", p.id, body, (await actorId())));
route("PUT", "/api/accounts/:id/owners", async (p, _q, body) =>
  repo.setAccountOwners(p.id, body.owners || [], (await actorId())));

route("GET", "/api/locations/:id", async (p) =>
  (await repo.getLocation(p.id)) || { error: "not_found" });
route("POST", "/api/locations", async (_p, _q, body) =>
  repo.insertRecord("location", body, (await actorId())));

route("GET", "/api/contacts", async (_p, q) =>
  repo.searchContacts({
    q: q.get("q"), role: q.get("role"),
    skills: q.get("skills") ? q.get("skills").split(",") : null,
    accountId: q.get("account_id"), locationId: q.get("location_id"),
    onPayroll: q.get("on_payroll") ? q.get("on_payroll") === "1" : null,
    limit: Number(q.get("limit") || 25),
  }));
route("GET", "/api/contacts/:id", async (p) =>
  (await repo.getContact(p.id)) || { error: "not_found" });
route("POST", "/api/contacts", async (_p, _q, body) =>
  repo.insertRecord("contact", body, (await actorId())));
route("PATCH", "/api/contacts/:id", async (p, _q, body) =>
  repo.updateRecord("contact", p.id, body, (await actorId())));

route("GET", "/api/projects", async (_p, q) =>
  repo.listProjects({
    q: q.get("q"), accountId: q.get("account_id"), status: q.get("status"),
    deliveryType: q.get("delivery_type"), limit: Number(q.get("limit") || 50),
  }));
route("GET", "/api/projects/:id", async (p) =>
  (await repo.getProject(p.id)) || { error: "not_found" });
route("POST", "/api/projects", async (_p, _q, body) =>
  repo.insertRecord("project", body, (await actorId())));
route("PATCH", "/api/projects/:id", async (p, _q, body) =>
  repo.updateRecord("project", p.id, body, (await actorId())));

route("POST", "/api/activity", async (_p, _q, body) =>
  repo.logActivity({ ...body, actorId: (await actorId()) }));
route("POST", "/api/submissions/:id/advance", async (p, _q, body) =>
  repo.advanceSubmission(p.id, body.stage, body.reason, (await actorId())));

route("GET", "/api/documents", async (_p, q) =>
  repo.searchDocuments({
    q: q.get("q"), kind: q.get("kind"), accountId: q.get("account_id"),
    contactId: q.get("contact_id"), projectId: q.get("project_id"),
    limit: Number(q.get("limit") || 25),
  }));
route("POST", "/api/documents", async (_p, _q, body) =>
  repo.insertRecord("document", body, (await actorId())));

route("GET", "/api/po-burndown", async (_p, q) =>
  repo.poBurndown({
    projectId: q.get("project_id"), accountName: q.get("account"),
    expiringDays: q.get("expiring_within_days")
      ? Number(q.get("expiring_within_days")) : null,
    atRisk: q.get("at_risk") === "1",
  }));

// ------------------------------------------------------- timecards & invoices

route("GET", "/api/timecards", async (_p, q) =>
  repo.listTimecards({
    status: q.get("status"), poId: q.get("po_id"), projectId: q.get("project_id"),
    placementId: q.get("placement_id"), weekFrom: q.get("from"), weekTo: q.get("to"),
    unbilledOnly: q.get("unbilled") === "1",
    limit: Number(q.get("limit") || 200),
  }));
route("POST", "/api/timecards", async (_p, _q, body) =>
  repo.insertRecord("timecard", body, await actorId()));
route("POST", "/api/timecards/approve", async (_p, _q, body) =>
  repo.approveTimecards(body.ids, body.approved_by, await actorId()));
route("POST", "/api/timecards/:id/reject", async (p, _q, body) =>
  repo.rejectTimecard(p.id, body.reason, await actorId()));

route("GET", "/api/invoices", async (_p, q) =>
  repo.listInvoices({
    accountId: q.get("account_id"), projectId: q.get("project_id"),
    poId: q.get("po_id"), status: q.get("status"),
    overdueOnly: q.get("overdue") === "1", limit: Number(q.get("limit") || 100),
  }));
route("GET", "/api/invoices/:id", async (p) =>
  (await repo.getInvoice(p.id)) || { error: "not_found" });
route("POST", "/api/invoices/draft", async (_p, _q, body) =>
  repo.draftInvoiceFromApproved({
    purchaseOrderId: body.purchase_order_id, projectId: body.project_id,
    throughWeek: body.through_week, terms: body.terms ?? 45, notes: body.notes,
  }, await actorId()));
route("POST", "/api/invoices/:id/send", async (p, _q, body) =>
  repo.sendInvoice(p.id, body?.issue_date || null, await actorId()));
route("POST", "/api/invoices/:id/payments", async (p, _q, body) =>
  repo.recordPayment({
    invoiceId: p.id, amount: body.amount, receivedAt: body.received_at,
    method: body.method, reference: body.reference }, await actorId()));
route("POST", "/api/invoices/:id/void", async (p, _q, body) =>
  repo.voidInvoice(p.id, body?.reason || null, await actorId()));

route("GET", "/api/invoice-aging", async (_p, q) =>
  repo.invoiceAging({ accountName: q.get("account") }));

route("GET", "/api/history/:table/:id", async (p) => repo.revisionsFor(p.table, p.id));
route("GET", "/api/events", async (_p, q) =>
  repo.recentEvents(Number(q.get("limit") || 50)));

// ------------------------------------------------------ inspector endpoints

route("GET", "/api/inspect/schema", async (_p, q) => describeSchema(q.get("table")));

route("GET", "/api/inspect/tools", async () => {
  const t = buildTools({ userId: await actorId() });
  return toolSchemas(t);
});

// The system prompt exactly as it is sent to the model. No paraphrase.
route("GET", "/api/inspect/prompt", async () => ({
  model: config.model,
  effort: config.effort,
  max_tokens: config.maxTokens,
  thinking: { type: "adaptive", display: "summarized" },
  pricing_usd_per_mtok: config.pricing,
  system: SYSTEM_PROMPT,
  system_chars: SYSTEM_PROMPT.length,
}));

route("GET", "/api/inspect/traces", async (_p, q) => {
  const live = trace.recentTraces(Number(q.get("limit") || 25));
  if (live.length) return live;
  // Nothing in memory yet - this process restarted. Fall back to the table.
  return rows(
    `select id, conversation_id, prompt, steps, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, cost_usd, duration_ms, model, error,
            extract(epoch from started_at)*1000 as "startedAt"
       from trace order by started_at desc limit $1`, [Number(q.get("limit") || 25)]);
});

route("GET", "/api/inspect/traces/:id", async (p) => {
  const live = trace.traceById(p.id);
  if (live) return live;
  const row = await one(`select * from trace where id = $1`, [p.id]);
  return row || { error: "not_found" };
});

route("GET", "/api/inspect/stats", async () => {
  const [turns, spend, tables, activity] = await Promise.all([
    one(`select count(*)::int as turns,
                coalesce(sum(cost_usd),0)::numeric(12,4) as spend_usd,
                coalesce(round(avg(duration_ms)),0)::int as avg_ms,
                coalesce(sum(input_tokens),0)::int as input_tokens,
                coalesce(sum(output_tokens),0)::int as output_tokens,
                coalesce(sum(cache_read_tokens),0)::int as cache_read_tokens
           from trace`),
    one(`select coalesce(sum(cost_usd),0)::numeric(12,4) as today_usd from trace
          where started_at > current_date`),
    rows(`select relname as table, n_live_tup as rows from pg_stat_user_tables
           where n_live_tup > 0 order by n_live_tup desc limit 20`),
    one(`select count(*)::int as events from domain_event`),
  ]);
  return { ...turns, ...spend, ...activity, tables };
});

// Run a SELECT by hand, through the same read-only role the assistant uses.
route("POST", "/api/inspect/sql", async (_p, _q, body) => runReadOnlySql(body.sql));

// ------------------------------------------------------------- conversations

route("GET", "/api/conversations", async () => listConversations());
route("GET", "/api/conversations/:id", async (p) => ({
  conversation: await one(`select * from conversation where id = $1`, [p.id]),
  messages: await rows(
    `select id, role, content, created_at from chat_message
      where conversation_id = $1 order by id`, [p.id]),
}));
route("POST", "/api/conversations", async (_p, _q, body) =>
  ensureConversation(null, (await actorId()), body.title || "New chat"));

// ---------------------------------------------------------------- the server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  // Chat. Server-sent events: text deltas, tool activity, then the whole trace.
  if (pathname === "/api/chat" && req.method === "POST") return handleChat(req, res);

  // Live inspector feed. Every step from every turn, as it happens.
  if (pathname === "/api/inspect/stream") {
    const send = sse(res);
    const onEvent = (e) => send("event", e);
    trace.bus.on("event", onEvent);
    const ping = setInterval(() => { if (!res.writableEnded) res.write(": ping\n\n"); }, 25000);
    req.on("close", () => { clearInterval(ping); trace.bus.off("event", onEvent); });
    return;
  }

  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = pathname.match(r.rx);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    try {
      const body = ["POST", "PATCH", "PUT"].includes(req.method) ? await readBody(req) : null;
      const out = await r.handler(params, url.searchParams, body);
      return json(res, out && out.error === "not_found" ? 404 : 200, out);
    } catch (e) {
      console.error(`[api] ${req.method} ${pathname}:`, e.message);
      return json(res, 400, { error: e.message, code: e.code });
    }
  }

  return serveStatic(pathname, res);
});

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
               ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
               ".ico": "image/svg+xml", ".json": "application/json" };

function serveStatic(pathname, res) {
  const rel = pathname === "/" ? "/index.html" : pathname;
  // Resolve inside PUBLIC and refuse anything that escapes it.
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { "content-type": "text/plain" });
    return res.end("not found");
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

async function handleChat(req, res) {
  let body;
  try { body = await readBody(req); }
  catch (e) { return json(res, 400, { error: e.message }); }

  const send = sse(res);
  const meId = await actorId();
  const conv = await ensureConversation(
    body.conversation_id, meId,
    (body.prompt || "New chat").slice(0, 60));
  send("conversation", { id: conv.id, title: conv.title });

  const history = await loadHistory(conv.id);
  try {
    const { text, messages } = await runTurn({
      prompt: body.prompt,
      history,
      userId: meId,
      conversationId: conv.id,
      onEvent: (e) => send(e.type, e),
    });
    // Persist only what this turn added, in full content-block form so the
    // conversation can be replayed exactly as the model saw it.
    await saveMessages(conv.id, messages.slice(history.length));
    // Name the chat after the first thing asked, like any chat app.
    if (history.length === 0) {
      await query(`update conversation set title = $2 where id = $1`,
                  [conv.id, (body.prompt || "New chat").slice(0, 60)]);
    }
    send("done", { text });
  } catch (e) {
    send("error", { message: e.message });
    send("done", { text: "" });
  }
  res.end();
}

server.listen(config.port, () => {
  console.log(`TS Workspace server  http://localhost:${config.port}`);
  console.log(`  inspector          http://localhost:${config.port}/inspect.html`);
  console.log(`  model              ${config.model} (effort ${config.effort})`);
  console.log(`  anthropic key      ${hasApiKey() ? "present" : "MISSING - chat will error"}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    server.close();
    await closeDb();
    process.exit(0);
  });
}
