// Starts the real server as its own process and drives it over HTTP, so the
// routing, the static files and the SSE stream are exercised as shipped.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_DB } from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 4599;
const base = `http://127.0.0.1:${PORT}`;
let child;

const get = async (p) => {
  const r = await fetch(base + p);
  return { status: r.status, body: await r.json() };
};

before(async () => {
  // The other suite truncates as it goes, so give this one a user of its own -
  // the server has to attribute writes to somebody.
  const pg = (await import("pg")).default;
  const c = new pg.Client({
    connectionString: `postgres://ts_app:ts_app_dev@127.0.0.1:5432/${TEST_DB}` });
  await c.connect();
  await c.query(`insert into app_user (email, full_name, role)
                 values ('http-test@ts.com','HTTP Test','admin')
                 on conflict (email) do nothing`);
  await c.end();

  child = spawn(process.execPath, [path.join(here, "..", "src", "server.js")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DATABASE_URL: `postgres://ts_app:ts_app_dev@127.0.0.1:5432/${TEST_DB}`,
      DATABASE_URL_RO: `postgres://ts_readonly:ts_readonly_dev@127.0.0.1:5432/${TEST_DB}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Wait for it to bind rather than sleeping a guessed amount.
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 15000);
    child.stdout.on("data", (d) => {
      if (String(d).includes("TS Workspace server")) { clearTimeout(t); resolve(); }
    });
    child.on("exit", (c) => { clearTimeout(t); reject(new Error("exited " + c)); });
  });
});

after(() => { child?.kill("SIGKILL"); });

describe("the HTTP surface", () => {
  test("reports its own health honestly", async () => {
    const { body } = await get("/api/health");
    assert.equal(body.ok, true);
    assert.equal(body.database.db, TEST_DB);
    assert.equal(body.model, "claude-opus-5");
    assert.ok(["present", "missing"].includes(body.anthropic_key));
  });

  test("serves the workspace page and its assets", async () => {
    for (const [p, type] of [["/", "text/html"], ["/app.css", "text/css"],
                             ["/app.js", "text/javascript"],
                             ["/inspect.html", "text/html"]]) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get("content-type"), new RegExp(type), p);
    }
  });

  test("refuses to serve files outside the public directory", async () => {
    const r = await fetch(base + "/../src/config.js");
    assert.equal(r.status, 404);
  });

  test("exposes the record endpoints", async () => {
    for (const p of ["/api/accounts", "/api/contacts", "/api/projects",
                     "/api/documents", "/api/po-burndown", "/api/users",
                     "/api/events"]) {
      const { status, body } = await get(p);
      assert.equal(status, 200, p);
      assert.ok(Array.isArray(body), p);
    }
  });

  test("the billing endpoints answer", async () => {
    for (const p of ["/api/timecards", "/api/invoices", "/api/invoice-aging",
                     "/api/po-burndown", "/api/po-burndown?at_risk=1"]) {
      const { status, body } = await get(p);
      assert.equal(status, 200, p);
      assert.ok(Array.isArray(body), p);
    }
  });

  test("burn-down separates what was billed from what was only earned", async () => {
    const { body } = await get("/api/po-burndown");
    if (!body.length) return;
    for (const k of ["invoiced", "paid", "outstanding", "drafted_not_sent",
                     "approved_unbilled", "submitted_pending", "remaining",
                     "projected_remaining"]) {
      assert.ok(k in body[0], `burn-down is missing ${k}`);
    }
  });

  test("approving without naming the approver is refused", async () => {
    const r = await fetch(base + "/api/timecards/approve", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [], approved_by: "" }),
    });
    assert.equal(r.status, 400);
  });

  test("a missing record answers 404 rather than an empty 200", async () => {
    const { status } = await get("/api/accounts/00000000-0000-0000-0000-000000000000");
    assert.equal(status, 404);
  });

  test("a bad write answers with the reason", async () => {
    const r = await fetch(base + "/api/contacts", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Nobody", is_manager: true }),
    });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.match(body.error, /manager_needs_account/);
  });

  test("the inspector exposes the prompt, tools and schema as they really are", async () => {
    const prompt = (await get("/api/inspect/prompt")).body;
    assert.equal(prompt.model, "claude-opus-5");
    assert.deepEqual(prompt.thinking, { type: "adaptive", display: "summarized" });
    assert.match(prompt.system, /project-based work/);

    const tools = (await get("/api/inspect/tools")).body;
    assert.ok(tools.length >= 20);
    assert.ok(tools.find((t) => t.name === "sql_query"));

    const schema = (await get("/api/inspect/schema")).body;
    assert.ok(schema.contact.columns.some((c) => c.name === "is_candidate"));
  });

  test("the SQL console runs through the read-only role", async () => {
    const ok = await fetch(base + "/api/inspect/sql", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql: "select count(*) as n from account" }),
    }).then((r) => r.json());
    assert.ok(ok.rows[0].n >= 0);

    const bad = await fetch(base + "/api/inspect/sql", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sql: "update account set name = 'x'" }),
    }).then((r) => r.json());
    assert.match(bad.error, /only SELECT/);
  });

  test("the live trace stream opens and stays open", async () => {
    const ctrl = new AbortController();
    const r = await fetch(base + "/api/inspect/stream", { signal: ctrl.signal });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /text\/event-stream/);
    const chunk = await r.body.getReader().read();
    assert.match(new TextDecoder().decode(chunk.value), /: open/);
    ctrl.abort();
  });

  test("chat without a credential streams back the reason instead of hanging", async () => {
    const r = await fetch(base + "/api/chat", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    });
    assert.equal(r.status, 200);
    const text = await r.text();
    // Either it ran (a key is present) or it explained itself. Never a hang,
    // never an unhandled crash.
    assert.match(text, /event: (done|error)/);
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      assert.match(text, /ANTHROPIC_API_KEY/);
    }
  });
});
