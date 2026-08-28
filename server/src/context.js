// Who is acting, carried alongside the request rather than threaded through
// every function signature. The data layer reads it when it opens a transaction
// and hands it to Postgres, which is where the audit trigger picks it up.

import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage();

export function currentContext() {
  return store.getStore() || null;
}

export function withContext(ctx, fn) {
  return store.run({ ...ctx }, fn);
}

// Attach a reason to whatever writes happen inside fn. The audit log keeps it
// against every row the transaction touched, which is how "why did this change"
// gets an answer months later.
export function withReason(reason, fn) {
  const ctx = currentContext() || {};
  return store.run({ ...ctx, reason }, fn);
}

// Attach an acting user and a reason to whatever writes happen inside fn.
//
// This exists because the history a trigger writes is attributed from the
// transaction, not from a function argument: a caller that passes an actorId but
// never puts it in the context would get its work recorded as unattributed. Any
// operation handed an actorId should route it through here so the two cannot
// disagree. Whatever the caller already set wins if nothing is passed.
export function withActing(actorId, reason, fn) {
  const ctx = currentContext() || {};
  return store.run({
    ...ctx,
    actorId: actorId || ctx.actorId,
    reason: reason ?? ctx.reason,
  }, fn);
}
