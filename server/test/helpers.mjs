// Shared test scaffolding: a throwaway database per run, and a scripted stand-in
// for the Anthropic client so the agent loop can be exercised without a key.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

export const TEST_DB = "ts_workspace_test";

// Rebuild the test database from the same schema the real one uses. Running the
// tests against a copy of production DDL is the only way the constraint tests
// mean anything.
export function resetTestDatabase() {
  const url = `postgres://ts_app:ts_app_dev@127.0.0.1:5432/${TEST_DB}`;
  process.env.DATABASE_URL = url;
  process.env.DATABASE_URL_RO =
    `postgres://ts_readonly:ts_readonly_dev@127.0.0.1:5432/${TEST_DB}`;
  return url;
}

// A stub that plays back a fixed list of API responses, one per loop iteration,
// and records the requests it was given so a test can assert on them.
export function scriptedClient(responses) {
  const requests = [];
  let i = 0;
  const stub = {
    requests,
    messages: {
      stream(params) {
        requests.push(params);
        const res = responses[Math.min(i++, responses.length - 1)];
        const handlers = {};
        return {
          on(evt, fn) { (handlers[evt] ||= []).push(fn); return this; },
          async finalMessage() {
            // Deliver text deltas the way the real stream does, so anything
            // listening for them is exercised too.
            for (const b of res.content || []) {
              if (b.type === "text") {
                for (const fn of handlers.text || []) fn(b.text);
              }
              if (b.type === "thinking") {
                for (const fn of handlers.thinking || []) fn(b.thinking);
              }
            }
            return {
              id: `msg_${randomUUID().slice(0, 8)}`,
              model: "claude-opus-5",
              stop_reason: res.stop_reason || "end_turn",
              content: res.content || [],
              usage: res.usage || {
                input_tokens: 1200, output_tokens: 240,
                cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
              },
            };
          },
        };
      },
    },
  };
  return stub;
}

export const textBlock = (text) => ({ type: "text", text });
export const toolBlock = (name, input, id = `tu_${randomUUID().slice(0, 8)}`) =>
  ({ type: "tool_use", id, name, input });

export function psqlAsSuper(sql, db = "postgres") {
  return execFileSync("su", ["postgres", "-c",
    `psql -q -d ${db} -v ON_ERROR_STOP=1 -c ${JSON.stringify(sql)}`],
    { encoding: "utf8" });
}
