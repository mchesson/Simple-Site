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
