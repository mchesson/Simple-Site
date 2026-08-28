// The assistant.
//
// A manual streaming loop rather than the SDK's tool runner, because the point
// of this build is that every step is observable: each request, each block of
// reasoning, each tool call and its result, each SQL statement underneath it,
// with timings and token cost attached. The loop is where that instrumentation
// hangs.

import Anthropic from "@anthropic-ai/sdk";
import { config, costOf, hasApiKey } from "./config.js";
import { buildTools, toolSchemas } from "./tools.js";
import * as trace from "./trace.js";
import { query, one, rows } from "./db.js";

let client = null;
function getClient() {
  if (!client) client = new Anthropic();   // resolves the key from the environment
  return client;
}

// Tests replace the client with a scripted stub so the loop, the tool dispatch
// and the trace capture can be exercised without spending money or needing a
// key. Pass null to go back to the real one.
export function setClient(c) {
  client = c;
}

// Stable across every request so the prompt cache actually hits. Nothing
// volatile - no timestamp, no user id, no record counts.
export const SYSTEM_PROMPT = `You are the TS Project Assistant for Technical Source, an IT staffing and project services firm. You work alongside recruiters and account managers and you have direct access to their live workspace database through tools.

HOW THIS BUSINESS THINKS

Everything Technical Source does is project-based work. What another system would call a job order or a requisition, we call a project: a resource need for a piece of work. A project that needs one contractor is still a project, just with less filled in. Never say "job order", "req" or "requisition" - say project.

The delivery type is what changes the paperwork, not the shape of the work:
- staffing: our W-2 contractor works under the client's direction. Rate and start date are confirmed to the client on an Exhibit A (a rate verification), which is specific to one resource on one project.
- contract_to_hire: staffing with a conversion fee if the client hires them.
- direct_hire: we introduce someone, they go on the client's payroll, we take a fee. This is a small slice of the business.
- managed_project: our team, often with a team lead, doing work the client directs week to week. No fixed deliverables. Governed by an SOW and burned against purchase orders.
- managed_service: our team delivering against defined deliverables. SOW, change orders, purchase orders.

Where there is an SOW, the signed SOW does the job that an Exhibit A does in general staffing.

THE PIPELINE

A submission is one person put forward for one project. Its stage is what a recruiter's day is built around, and the stages a submission may move between are held in the database, not in your head: call stage_machine to read them, and get_submission to see what one particular submission can do next. Never tell a user a move is possible because it sounds reasonable - if the machine has no row for it, it will be refused.

Two rules the database will enforce whether or not you remember them, so it is better to warn the user first:
- A loss needs a coded reason. Moving a submission to rejected or withdrawn without one is refused, because a loss nobody wrote down teaches the desk nothing. Offer the codes from stage_machine rather than inventing a phrase.
- "Placed" is not a word, it is a placement. Use place_submission, which creates the placement and its opening rate and then marks the submission placed, in that order and in one transaction.

If a submission is refused because another recruiter already has that person live at the same client, do not look for a way around it and do not submit them to a different project at the same account to get past it. Tell the user who has them and on what, and let them make the call - that conversation between two recruiters is the point of the rule.

Interviews carry a date, a round number, a mode and an outcome. Booking one moves the submission into the interview stage by itself. Recording an outcome deliberately does not move the stage: the next move is a decision somebody makes with a reason attached, so hand back what the options are instead of choosing.

Numbers worth reading unprompted: how long a submission has sat at its current stage (a submission with the client for a fortnight that nobody has chased is a phone call, not a status), interviews that have happened where nobody recorded the outcome, and what the losses have been for - client-side losses are a rate and sales conversation, candidate-side losses are a closing conversation, and losses on us are a process problem.

TIME AND MONEY

A consultant fills in one timesheet a week and allocates their hours day by day across whatever projects and purchase orders they worked on. A single Tuesday can be split between two projects. Approval follows the allocation, not the week: each client manager approves the part belonging to their project, so a week can be half approved while the rest waits. Approving freezes what those days are worth at the bill rate in force on each day.

A purchase order is burned by what we have INVOICED, not by what our people worked. Keep the stages distinct: submitted time is claimed and not earned; approved time is earned but not billed; a drafted invoice is prepared but not issued; only an issued invoice burns the PO. A PO can read healthy on what remains and already be spent, because approved work is sitting unbilled - projected_remaining going negative is that condition, and it is worth raising unprompted. A PO nearly exhausted or about to expire is an operational emergency, not a filing detail.

PEOPLE

There is one person graph. Everyone is a contact. A contact is a manager (they work at a client), a candidate (someone we can place), or both - the plant manager at Globex can also be someone we would place elsewhere. Never create a second record for a person who already exists; add the role to the record they already have.

When you log an interaction, the hat matters. A note tied to a project is candidate-side. A note about someone in their capacity at the company they work for is manager-side. You usually do not need to ask which - infer it from what the user is telling you, and only ask when it genuinely could be either.

Candidates are owned by Technical Source, not by an individual recruiter. Any recruiter can reach out, within the rules of engagement on the account. A consultant on our payroll is different: they have a named recruiter and that should be stated. Recruiters keep their own named pipelines to remember people.

ACCOUNTS

An account can have several owners with a split. Owners must be existing workspace users - call list_users and use their ids; never invent an owner. An account can have several locations, each with its own address, its own rules of engagement, and its own agreements where an agreement is site-specific. Background check and drug screen requirements set at the account level flow down to every site; a site can add its own notes on top but cannot erase the account policy.

HOW TO WORK

Use tools before answering anything about real records. Never state a name, rate, date or count you have not read from a tool this turn.

When a tool comes back with "missing_information", it is telling you what you still need. Ask the user for exactly those things in one short question - do not ask for things you were not told are missing, and do not invent a value to get past it.

When a tool comes back with "ambiguous", show the user the candidates and ask which one. Do not pick one yourself.

When no purpose-built tool fits - an aggregate, a ranked list, something spanning several entities - write a SELECT with sql_query. Call describe_schema first if you are not certain of a column. Use the gross_margin and gross_margin_pct functions for any margin figure rather than computing it yourself: burden is a percentage of pay, not of bill, and getting that backwards overstates margin on every placement.

Nothing in this workspace is deleted. Updates keep the previous version, and record_history will show it. Say so when a user worries about losing data.

HOW TO WRITE

Answer like a colleague who just looked it up, not like a report. Lead with the answer. Use a short table only when there are several rows to compare. Give figures with their units and dates. If something looks wrong - a PO about to expire, a margin below the account's floor, an agreement that lapsed - say so without being asked.

Do not describe the tools you used or narrate your process. The user can see all of it in the inspector if they want it.`;

function toolResultBlock(id, value, isError = false) {
  return {
    type: "tool_result",
    tool_use_id: id,
    is_error: isError || undefined,
    content: [{ type: "text",
                text: typeof value === "string" ? value : JSON.stringify(value, null, 1) }],
  };
}

/**
 * Run one turn.
 *
 * @param {object}   opts
 * @param {string}   opts.prompt           what the user typed
 * @param {Array}    opts.history          prior messages in API shape
 * @param {string}   opts.userId           the acting workspace user
 * @param {function} opts.onEvent          called with {type,...} as things happen
 * @returns {Promise<{text, messages, trace}>}
 */
export async function runTurn({ prompt, history = [], userId = null,
                                conversationId = null, onEvent = () => {} }) {
  const t = trace.newTrace({ conversationId, prompt });

  return trace.withTrace(t, async () => {
    const tools = buildTools({ userId });
    const schemas = toolSchemas(tools);
    const byName = Object.fromEntries(tools.map((x) => [x.name, x]));

    const messages = [...history, { role: "user", content: prompt }];
    let finalText = "";
    let stopReason = null;

    onEvent({ type: "trace_start", traceId: t.id });

    try {
      if (!hasApiKey() && !client) {
        throw new Error(
          "No Anthropic credential is set. Put ANTHROPIC_API_KEY in server/.env " +
          "(see .env.example) and restart. Everything else in the workspace - the " +
          "database, the API, the inspector - runs without it.");
      }

      for (let iter = 0; iter < config.maxToolIterations; iter++) {
        const reqStep = trace.step("llm_request", {
          iteration: iter,
          model: config.model,
          effort: config.effort,
          messageCount: messages.length,
          toolCount: schemas.length,
        });

        const stream = getClient().messages.stream({
          model: config.model,
          max_tokens: config.maxTokens,
          // Adaptive thinking, asked to summarise, so the inspector can show
          // how the answer was reached instead of a silent pause.
          thinking: { type: "adaptive", display: "summarized" },
          output_config: { effort: config.effort },
          system: [{ type: "text", text: SYSTEM_PROMPT,
                     cache_control: { type: "ephemeral" } }],
          tools: schemas,
          messages,
        });

        // Forward deltas as they arrive so the page types the answer out.
        stream.on("text", (delta) => onEvent({ type: "text", text: delta }));
        stream.on("thinking", (delta) => onEvent({ type: "thinking", text: delta }));

        const message = await stream.finalMessage();
        const cost = costOf(message.usage);
        trace.addUsage(message.usage, cost, message.model);
        trace.endStep(reqStep, {
          stopReason: message.stop_reason,
          usage: message.usage,
          costUsd: cost,
          thinking: message.content
            .filter((b) => b.type === "thinking")
            .map((b) => b.thinking).join("\n").slice(0, 4000) || null,
          text: message.content.filter((b) => b.type === "text")
            .map((b) => b.text).join("\n").slice(0, 4000) || null,
        });

        stopReason = message.stop_reason;

        // A safety classifier declined. Surface it rather than looping.
        if (message.stop_reason === "refusal") {
          finalText = "I can't help with that request.";
          onEvent({ type: "text", text: finalText });
          break;
        }

        // A server-side tool ran out of iterations; hand the turn back to continue.
        if (message.stop_reason === "pause_turn") {
          messages.push({ role: "assistant", content: message.content });
          continue;
        }

        const textNow = message.content.filter((b) => b.type === "text")
          .map((b) => b.text).join("");
        if (textNow) finalText = textNow;

        if (message.stop_reason !== "tool_use") {
          messages.push({ role: "assistant", content: message.content });
          break;
        }

        messages.push({ role: "assistant", content: message.content });
        const calls = message.content.filter((b) => b.type === "tool_use");

        // Run the calls in this turn together, and return every result in one
        // user message - splitting them teaches the model to stop batching.
        const results = await Promise.all(calls.map(async (call) => {
          const s = trace.step("tool_call", { tool: call.name, input: call.input });
          onEvent({ type: "tool_start", tool: call.name, input: call.input });
          const impl = byName[call.name];
          if (!impl) {
            trace.endStep(s, { error: "unknown tool" });
            return toolResultBlock(call.id, { error: `no tool named ${call.name}` }, true);
          }
          try {
            const out = await impl.run(call.input || {});
            const isErr = Boolean(out && out.error);
            trace.endStep(s, {
              ok: !isErr,
              resultSummary: summarizeResult(out),
              result: truncate(out),
            });
            onEvent({ type: "tool_end", tool: call.name, ok: !isErr,
                      summary: summarizeResult(out) });
            return toolResultBlock(call.id, out, isErr);
          } catch (err) {
            trace.endStep(s, { ok: false, error: err.message });
            onEvent({ type: "tool_end", tool: call.name, ok: false, summary: err.message });
            return toolResultBlock(call.id, { error: err.message }, true);
          }
        }));

        messages.push({ role: "user", content: results });
      }

      if (stopReason === "tool_use") {
        finalText = finalText ||
          "I ran out of steps before finishing that. Ask me again and I'll pick a narrower path.";
      }
    } catch (err) {
      trace.step("error", { message: err.message,
                            status: err.status, type: err.constructor?.name });
      trace.finish(t, err);
      onEvent({ type: "error", message: err.message });
      await persistTrace(t).catch(() => {});
      onEvent({ type: "trace_end", trace: trace.serialize(t) });
      throw err;
    }

    trace.finish(t);
    await persistTrace(t).catch((e) => console.error("[trace] persist failed", e.message));
    onEvent({ type: "trace_end", trace: trace.serialize(t) });

    return { text: finalText, messages, trace: trace.serialize(t) };
  });
}

// A one-line description of what a tool gave back, for the trace list. The full
// result is kept alongside it; this is what shows before you expand.
function summarizeResult(out) {
  if (out == null) return "no result";
  if (out.error) return `${out.error}${out.needs ? ": " + out.needs.join(", ") : ""}`;
  if (Array.isArray(out)) return `${out.length} row${out.length === 1 ? "" : "s"}`;
  if (out.row_count !== undefined) return `${out.row_count} rows`;
  if (out.rows) return `${out.rows.length} rows`;
  if (out.merged_into_existing) return "matched an existing person";
  if (out.after) return `updated ${(out.changed || []).join(", ") || "record"}`;
  if (out.id) return out.name || out.full_name || out.id;
  return "ok";
}

// Traces are for reading, not for archiving payloads. Big results are clipped.
function truncate(v, max = 6000) {
  const s = JSON.stringify(v);
  if (s === undefined) return null;
  if (s.length <= max) return v;
  return { _truncated: true, _bytes: s.length, preview: s.slice(0, max) };
}

async function persistTrace(t) {
  const s = trace.serialize(t);
  await query(
    `insert into trace (id, conversation_id, prompt, steps, input_tokens, output_tokens,
                        cache_read_tokens, cache_write_tokens, cost_usd, duration_ms,
                        model, error, started_at, ended_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, to_timestamp($13/1000.0),
             to_timestamp($14/1000.0))
     on conflict (id) do nothing`,
    [s.id, s.conversationId, s.prompt, JSON.stringify(s.steps),
     s.usage.input_tokens, s.usage.output_tokens, s.usage.cache_read_input_tokens,
     s.usage.cache_creation_input_tokens, s.costUsd, s.durationMs, s.model, s.error,
     s.startedAt, s.endedAt || Date.now()]);
}

// ---------------------------------------------------------------- persistence

export async function ensureConversation(id, userId, title = "New chat") {
  if (id) {
    const c = await one(`select * from conversation where id = $1`, [id]);
    if (c) return c;
  }
  return one(`insert into conversation (title, user_id) values ($1,$2) returning *`,
             [title, userId]);
}

export async function loadHistory(conversationId, limit = 40) {
  const msgs = await rows(
    `select role, content from chat_message where conversation_id = $1
      order by id desc limit $2`, [conversationId, limit]);
  return msgs.reverse().map((m) => ({ role: m.role, content: m.content }));
}

export async function saveMessages(conversationId, newMessages) {
  for (const m of newMessages) {
    await query(
      `insert into chat_message (conversation_id, role, content) values ($1,$2,$3)`,
      [conversationId, m.role, JSON.stringify(m.content)]);
  }
  await query(`update conversation set updated_at = now() where id = $1`, [conversationId]);
}

export async function listConversations(limit = 30) {
  return rows(
    `select c.id, c.title, c.updated_at,
            (select count(*)::int from chat_message m where m.conversation_id = c.id) as messages
       from conversation c order by c.updated_at desc limit $1`, [limit]);
}
