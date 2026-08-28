# TS Workspace — backend

The working parts behind the workspace: a Postgres data plane, an assistant that
is actually Claude with tools onto that data, and an inspector that shows you
what the system did rather than asking you to trust it.

```
server/
  src/schema.sql       the database, with the business rules as constraints
                       (the canonical DDL - db:reset rebuilds from it)
  src/bootstrap.sql    one-time role setup (run as a superuser)
  src/seed.js          demo data shaped like the real business
  src/db.js            two connection pools: one read/write, one SELECT-only
  src/repo.js          business operations - every write keeps the old version
  src/tools.js         the 23 tools the model is given
  src/agent.js         the Claude API loop, instrumented end to end
  src/trace.js         the observability spine
  src/server.js        REST API, streaming chat, inspector endpoints
  public/              the workspace UI and the inspector
  test/                71 tests against a real Postgres database
```

## Running it

You need PostgreSQL 16 and Node 22.

```bash
createdb ts_workspace
psql -d ts_workspace -f src/bootstrap.sql     # as a superuser: creates the two roles
npm install
cp .env.example .env                          # then put your API key in it
npm run db:reset                              # builds the schema and seeds demo data
npm start
```

Then open <http://localhost:4000>. The inspector is at `/inspect.html`.

### The API key

Chat needs `ANTHROPIC_API_KEY` in `.env`. Everything else — the database, the
REST API, the record screens, the inspector, the SQL console — runs without one.
Without a key the chat endpoint returns that as a message rather than failing
silently.

## The three ideas this is built on

**One person graph.** A human is a contact. `is_manager` and `is_candidate` are
not exclusive, because the plant manager at Globex is also someone we might
place elsewhere. Activity carries `as_role`, so the same record shows a
manager-side timeline and a candidate-side one without forking into two people.
`create_contact` on someone who already exists adds the role to the record they
have.

**Nothing is destroyed.** Every update writes the previous version to
`record_revision` before the row changes, inside the same transaction. Deletes
are an `archived_at` stamp. `record_history` answers "what did this look like
before" for any record, and the assistant can call it.

**The database enforces the rules, not the application.** A manager without an
account, a document scoped to two things at once, a project borrowing another
account's site, two rates of the same type overlapping in time — all of these
are refused by Postgres. The test suite asserts each one, because a constraint
nobody tested is a comment.

## Margin

Defined once, as a SQL function, so every caller agrees:

```sql
gross_margin(pay, bill, burden_pct) = bill - pay - (pay * burden_pct / 100)
```

Burden is a percentage of **pay**, not of bill. At 65 pay / 105 bill / 22%
burden the spread looks like $40 but the gross margin is $25.70 - 24.48%.
Computing it the other way overstates margin on every placement, and it
overstates it most where the pay rate is lowest.

## Time, purchase orders and invoices

A purchase order is burned by what we have **invoiced**, not by what our people
worked. Those are different numbers and the gap between them is the thing worth
watching, so `po_burndown` carries every stage:

| Column | What it is |
|---|---|
| `submitted_pending` | Time claimed, not yet accepted by the client. Not earned. |
| `approved_unbilled` | Accepted by the client, not billed. Earned revenue sitting in our own queue. |
| `drafted_not_sent` | An invoice prepared but not issued. Still ours, not theirs. |
| `invoiced` | Issued to the client. **This is the burn.** |
| `paid` / `outstanding` | What came back, and what has not. |
| `remaining` | `amount - invoiced`. What the PO can still be billed for. |
| `projected_remaining` | What is left once the whole backlog is billed. |

A PO can read healthy on `remaining` and already be spent, because a month of
approved time is sitting unbilled. `projected_remaining` going negative is that
condition, and `po_burndown(at_risk => true)` returns exactly those.

Time moves one way and the database enforces every step:

```
draft -> submitted -> approved -> on a draft invoice -> issued -> paid
                         |
                     rejected
```

- **Approval freezes the value.** `timecard_billable()` prices the week at the
  bill rate that was in force on the week ending date, using the effective-dated
  rate history. A week worked in July still prices at July's rate in December.
- **Only approved time can be invoiced.** A trigger refuses an invoice line
  pointing at a timecard in any other state.
- **A week cannot be billed twice.** A trigger refuses a second line for the same
  timecard on any invoice that is not voided.
- **A sent invoice is frozen.** Lines can only change while it is a draft.
- **An invoice cannot overrun its PO.** Sending one that would take the PO past
  its committed amount is refused, and the error names the remedy: a change
  order or a new PO.
- **Voiding never deletes.** The invoice stays and its weeks become billable
  again.

`invoice_aging` buckets receivables the way a controller expects - current,
1-30, 31-60, 61-90, 90+ - and excludes drafts, because nobody owes us anything
until an invoice is issued.

## The assistant

`claude-opus-5`, adaptive thinking, effort `high`, a manual streaming loop in
`agent.js` rather than the SDK tool runner — because the point of this build is
that every step is observable, and the loop is where the instrumentation hangs.

Thirty-one tools cover accounts, sites, contacts, projects, activity,
documents, pipelines, timecards, invoices and PO burn-down. Two of them matter more than the rest:

- `sql_query` runs a SELECT when no purpose-built tool fits. The connection
  holds a `ts_readonly` role with `SELECT` and nothing else, so a write is
  refused by Postgres. The pattern checks in front of it are a courtesy to the
  model, not the defence.
- `describe_schema` reads `information_schema`, so what the model is told about
  the database cannot drift from the database.

A tool that cannot proceed returns `{ needs: [...] }` instead of throwing. The
model reads that and asks for the missing piece, which is what makes entering a
record by conversation feel like a conversation rather than a form rejecting
you. A name that matches two things returns `{ error: "ambiguous", candidates }`
so the model asks which rather than guessing — guessing here means logging a
call against the wrong company.

The system prompt is stable across requests and cached, so repeat turns pay a
tenth of the input price for it. There is a test asserting no date appears in
it, because that would invalidate the cache every day.

## The inspector

`/inspect.html`. Five sections:

- **Turns** — every model call with its tokens, cost, latency, stop reason and
  summarised reasoning; every tool call with the arguments the model chose and
  what came back; every SQL statement underneath those tools with its timing and
  row count. Live: steps appear as the turn runs, over server-sent events.
- **Data** — the schema read live from `information_schema`, with row counts,
  and a query console running on the same read-only role the assistant uses.
- **Tools** — the tool definitions exactly as they are sent to the model.
- **Prompt** — the system prompt verbatim, the request settings, and the pricing
  used to cost each turn.
- **Events** — the append-only `domain_event` log, each row linking back to the
  turn that caused it.

## Tests

```bash
npm test
```

71 tests against a real Postgres database built from the same `schema.sql` the
application uses — the constraints are where most of the design lives, and a
mock would not catch them. The agent loop is exercised with a scripted stand-in
for the Anthropic client, so tool dispatch, trace capture, the iteration cap,
parallel tool results and cache stability are all covered without a key.

The money path gets the most attention: double-billing, invoicing unapproved
time, changing a sent invoice, overrunning a purchase order, the rate in force
on a given week, and every column of the burn-down at each stage.

**What is not covered:** no test in this suite makes a live Claude API call.
The request shape is asserted against the documented parameters, but the round
trip has not been run in this environment because no credential was available.
Add a key and send one message — if it answers, the loop is good.
