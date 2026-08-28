// Data plane.
//
// Two pools: one that can write, and one that holds a SELECT-only database
// role. The assistant's sql_query tool uses the second, so "the model cannot
// write to the database" is enforced by a Postgres grant rather than by a
// regular expression that someone will eventually find a way around.
//
// Every statement either pool runs is recorded on the current trace. That is
// the whole reason the inspector can show you the SQL behind an answer.

import pg from "pg";
import { config } from "./config.js";
import { step, endStep } from "./trace.js";
import { currentContext } from "./context.js";
import { currentTrace } from "./trace.js";

// Return numerics as numbers rather than strings. Money stays exact because
// every amount we do arithmetic on is computed in SQL, not in JavaScript.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

export const readOnlyPool = new pg.Pool({
  connectionString: config.databaseUrlRo,
  max: 4,
  // A runaway query from the assistant should die, not pin a connection.
  statement_timeout: 8000,
});

pool.on("error", (e) => console.error("[db] idle client error", e.message));
readOnlyPool.on("error", (e) => console.error("[db:ro] idle client error", e.message));

function shorten(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

export async function query(text, params = [], { label = null, ro = false } = {}) {
  const s = step("sql", { sql: shorten(text), params, label, readOnly: ro });
  try {
    const res = await (ro ? readOnlyPool : pool).query(text, params);
    endStep(s, { rowCount: res.rowCount, fields: res.fields?.map((f) => f.name) });
    return res;
  } catch (err) {
    endStep(s, { error: err.message, code: err.code });
    throw err;
  }
}

export async function rows(text, params, opts) {
  return (await query(text, params, opts)).rows;
}

export async function one(text, params, opts) {
  return (await query(text, params, opts)).rows[0] || null;
}

// Run fn inside a transaction. Used by every multi-statement write so a
// half-applied change can never be observed.
export async function tx(fn) {
  const client = await pool.connect();
  const s = step("transaction", { state: "begin" });
  try {
    await client.query("begin");
    // Hand the acting user to Postgres for the length of this transaction. The
    // audit trigger reads these, so attribution does not depend on the caller
    // remembering to pass an actor into every helper.
    const ctx = currentContext() || {};
    const tr = currentTrace();
    await client.query(
      `select set_config('ts.actor_id', $1, true),
              set_config('ts.actor_label', $2, true),
              set_config('ts.reason', $3, true),
              set_config('ts.trace_id', $4, true)`,
      [ctx.actorId || "", ctx.actorLabel || "", ctx.reason || "", tr ? tr.id : ""]);

    const scoped = {
      query: async (text, params = []) => {
        const inner = step("sql", { sql: shorten(text), params, inTx: true });
        try {
          const r = await client.query(text, params);
          endStep(inner, { rowCount: r.rowCount });
          return r;
        } catch (e) {
          endStep(inner, { error: e.message, code: e.code });
          throw e;
        }
      },
    };
    scoped.rows = async (t, p) => (await scoped.query(t, p)).rows;
    scoped.one = async (t, p) => (await scoped.query(t, p)).rows[0] || null;
    const out = await fn(scoped);
    await client.query("commit");
    endStep(s, { state: "commit" });
    return out;
  } catch (e) {
    await client.query("rollback").catch(() => {});
    endStep(s, { state: "rollback", error: e.message });
    throw e;
  } finally {
    client.release();
  }
}

export async function close() {
  await Promise.allSettled([pool.end(), readOnlyPool.end()]);
}
