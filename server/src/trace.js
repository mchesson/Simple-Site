// The glass box.
//
// Every model call, tool call and SQL statement that a turn produces is
// recorded here as a step, streamed live to any inspector that is watching,
// and written to the trace table when the turn ends.
//
// The current trace travels with the async context rather than being passed
// through every function signature, so the data layer can record a statement
// without the repo functions knowing anything about tracing.

import { AsyncLocalStorage } from "node:async_hooks";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

const store = new AsyncLocalStorage();

// Inspectors subscribe here. Unbounded listeners would be a leak, so the
// server removes its listener when a client disconnects.
export const bus = new EventEmitter();
bus.setMaxListeners(100);

// Recent traces kept in memory so the inspector has something to show the
// instant it loads, without a round trip to the database.
const RECENT_MAX = 100;
const recent = [];

export function currentTrace() {
  return store.getStore() || null;
}

export function newTrace({ conversationId = null, prompt = "" } = {}) {
  return {
    id: `tr_${randomUUID().slice(0, 12)}`,
    conversationId,
    prompt,
    steps: [],
    startedAt: Date.now(),
    endedAt: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    costUsd: 0,
    model: null,
    error: null,
  };
}

// Run fn with `trace` as the ambient trace for everything it awaits.
export function withTrace(trace, fn) {
  return store.run(trace, fn);
}

// Record a step. Returns the step so a caller can fill in a result later.
export function step(type, data) {
  const t = currentTrace();
  const s = { seq: t ? t.steps.length : 0, type, at: Date.now(), ...data };
  if (t) {
    t.steps.push(s);
    emit("step", { traceId: t.id, step: s });
  }
  return s;
}

// Mark a step finished, recording how long it took. Emitting again lets a
// watching inspector replace the pending row rather than append a second one.
export function endStep(s, patch = {}) {
  if (!s) return s;
  s.ms = Date.now() - s.at;
  Object.assign(s, patch);
  const t = currentTrace();
  if (t) emit("step", { traceId: t.id, step: s, update: true });
  return s;
}

export function addUsage(usage, cost, model) {
  const t = currentTrace();
  if (!t || !usage) return;
  for (const k of Object.keys(t.usage)) t.usage[k] += usage[k] || 0;
  t.costUsd += cost || 0;
  if (model) t.model = model;
}

export function emit(kind, payload) {
  bus.emit("event", { kind, ...payload });
}

export function finish(trace, error = null) {
  trace.endedAt = Date.now();
  trace.error = error ? String(error.message || error) : null;
  recent.unshift(summarize(trace));
  if (recent.length > RECENT_MAX) recent.pop();
  emit("trace_end", { trace: serialize(trace) });
  return trace;
}

export function serialize(t) {
  return {
    id: t.id,
    conversationId: t.conversationId,
    prompt: t.prompt,
    steps: t.steps,
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    durationMs: (t.endedAt || Date.now()) - t.startedAt,
    usage: t.usage,
    costUsd: t.costUsd,
    model: t.model,
    error: t.error,
  };
}

function summarize(t) {
  const s = serialize(t);
  return {
    ...s,
    steps: s.steps.map((x) => ({ ...x })),
  };
}

export function recentTraces(limit = 25) {
  return recent.slice(0, limit);
}

export function traceById(id) {
  return recent.find((t) => t.id === id) || null;
}
