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
  setup.sh             one command from a clean machine to a running workspace
  src/db.js            two connection pools: one read/write, one SELECT-only
  src/context.js       who is acting, carried to Postgres for the audit trigger
  src/repo.js          business operations, each one a single transaction
  src/tools.js         the 42 tools the model is given
  src/agent.js         the Claude API loop, instrumented end to end
  src/trace.js         the observability spine
  src/server.js        REST API, streaming chat, inspector endpoints
  public/              the workspace UI and the inspector
  test/                100 tests against a real Postgres database
```

## Running it

You need PostgreSQL 16 and Node 22. Then one command:

```bash
./setup.sh
```

It installs dependencies, creates the database, creates the two roles, builds
the schema, seeds demo data and starts the server. Open
<http://localhost:4000>; the inspector is at `/inspect.html`.

If `psql` on your machine is not a superuser, point the script at one:

```bash
TS_SUPERUSER_PSQL="sudo -u postgres psql" ./setup.sh
```

The individual steps are still there as `npm run db:reset`, `npm start` and
`npm test`.

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

**Nothing is destroyed, and nothing is unrecorded.** Every insert, update and
delete on every table is written to `audit_log` by a database trigger - not by
application code - so a change made by the app, the assistant, a migration
script or a person at a psql prompt all land there the same way. Each row keeps
the before, the after, the fields that changed, the acting user, a reason where
one was given, and the transaction id that ties one user action together across
tables. The log itself refuses UPDATE and DELETE: once a line is written it
stays. Deletes of business records are still an `archived_at` stamp on top of
that.

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

## The pipeline

A submission is one person put forward for one project. Which stages it may move
between is **data, not code**: `submission_stage` holds the stages and
`submission_stage_flow` holds the legal moves, one row per move, carrying the
label a button should show and whether the person clicking has to explain
themselves. A trigger enforces exactly those rows, and the application reads the
same two tables to decide which buttons to draw — so the screen and the database
cannot disagree about what is allowed, and adding a stage is an insert rather
than a deployment.

Four rules the database keeps rather than trusting a caller to remember:

- **A submission starts at `submitted`.** Nothing may be created half way down
  the funnel, because a submission that appears at `offer` has no history and
  the funnel silently under-counts everything above it.
- **A loss needs a coded reason.** Moving to `rejected` or `withdrawn` without
  `loss_reason_code` is refused. A loss nobody wrote down teaches the desk
  nothing, and the reasons are a fixed list so they can be counted.
- **`placed` is a placement, not a word.** The stage cannot say placed until a
  `placement` row references the submission. `place_submission` does the three
  writes in one transaction — placement, opening rate, then the stage — and a
  placement whose start date has arrived is created `active` rather than waiting
  for somebody to notice.
- **Two recruiters cannot work the same person into the same client.** The
  unique constraint on `(project_id, contact_id)` only catches a repeat on one
  project; a trigger catches the same person going to the same *account* while
  another recruiter's submission is still open, and it re-checks when a closed
  submission is revived. The same recruiter putting somebody up for a second
  role at that client is ordinary work and is allowed.

`submission_event` is the append-only history, written by the trigger rather
than by the caller — including the row for the submission's own creation — with
the reason taken from the same transaction-local setting the audit trail uses.
It refuses UPDATE and DELETE.

Interviews carry a round number, a date, a mode, attendees and an outcome.
Inserting one moves the submission into the interview stage by itself, and never
drags a stage backwards, so booking a second round while an offer is out leaves
the offer alone. Recording an outcome deliberately does **not** move the stage:
a rejection needs a coded reason, so the next move stays a decision a person
makes.

Two views read it back. `submission_board` is one row per submission with the
numbers a desk sorts by — days in stage, margin at the submitted rates, the next
booked interview, when the person was last spoken to. `submission_funnel` counts
what each stage **ever reached**, read off the event log rather than the current
stage, so a candidate later rejected still counts towards the interviews they
got. That is the difference between "we do not get interviews" and "we get
interviews and lose them".

## Time, purchase orders and invoices

A purchase order is burned by what we have **invoiced**, not by what our people
worked. Those are different numbers and the gap between them is the thing worth
watching, so `po_burndown` carries every stage:

| Column | What it is |
|---|---|
| `submitted_pending` | Time claimed, waiting on a client manager. Not earned. |
| `approved_unbilled` | Accepted by the client, not billed. Earned revenue sitting in our own queue. |
| `drafted_not_sent` | An invoice prepared but not issued. Still ours, not theirs. |
| `invoiced` | Issued to the client. **This is the burn.** |
| `paid` / `outstanding` | What came back, and what has not. |
| `remaining` | `amount - invoiced`. What the PO can still be billed for. |
| `projected_remaining` | What is left once the whole backlog is billed. |

A PO can read healthy on `remaining` and already be spent, because a month of
approved time is sitting unbilled. `projected_remaining` going negative is that
condition, and `po_burndown(at_risk => true)` returns exactly those.

## The timesheet cycle

A consultant fills in **one timesheet a week** and allocates their hours day by
day across whatever projects and purchase orders they worked on. A single
Tuesday can be split between two projects; a person on two engagements at one
client charges both from the same week.

**Approval follows the allocation, not the week.** Submitting creates one
approval packet per project the week touches, each routed to that project's
designated approving manager. Two managers sign off independently, so a week can
sit in `partly_approved` while one of them catches up — rather than one slow
approver blocking a week of billing.

```
   consultant enters and allocates
              |
          submits  ──► packet per project ──► each client manager decides
              |                                    |            |
              |                                approved     rejected
              |                                    |            |
              |                              billable      back to draft
              ▼
   draft ─► submitted ─► partly_approved ─► approved
                     └─► rejected ─► draft (corrected, resubmitted)
```

Approvers are contacts on the account — the same person graph as everything
else — so an approver is a manager we already know, not a name in a text field.

What the database enforces:

- **A day cannot exceed 24 hours**, however it is split across projects.
- **A day has to fall inside its week.**
- **A purchase order has to belong to the project** the placement is on.
- **The project is derived from the placement**, not taken from the caller, so
  time cannot be filed against a project the consultant is not placed on.
- **A submitted week is locked** — no edits, no deletions — until it is decided.
  The lock is against changes to the *allocation*; approving still writes the
  frozen value onto the same rows.
- **Approval freezes the value** at the bill rate in force on each day, from the
  effective-dated rate history. A Tuesday worked in March still prices at
  March's rate in June. **Rejection releases it** and sends the week back.
- **A decision is made once.** Re-deciding tells you who already decided.
- **Approved days are locked.** Nobody can change or delete them - not the
  consultant, not the app, not a direct SQL statement. The lock is per approval
  packet, so one manager rejecting their project cannot reopen days another
  manager already signed off.

## Unlocking approved time

Locked means locked, so the way out is deliberate:

1. Anyone raises an **unlock request** against the approved packet, with a
   reason. Only one can be open on a packet at a time.
2. An **admin** grants or denies it. The database checks the role and refuses a
   self-grant - whoever asked cannot be the one who approves it.
3. Granting is refused outright if the time is **already on a live invoice**. The
   error says to void or credit the invoice first, because unlocking would
   otherwise leave an invoice standing against time that no longer exists.
4. A grant is a key with a life: it expires in 24 hours and is **spent on first
   use**. Reopening the packet releases the frozen values and puts the week back
   to draft. Re-approving and reopening again needs a fresh grant.

Every step of that is in the audit trail.

## Billing

Time moves one way and the database enforces every step:

- **Only approved time can be invoiced.** A line pointing at an entry whose
  packet is not approved is refused.
- **A day cannot be billed twice.** A second line for the same entry on any live
  invoice is refused.
- **An invoice bills one PO.** A line whose day is allocated elsewhere is
  refused, so an invoice for PO-A can never pick up hours charged to PO-B.
- **A sent invoice is frozen.** Lines change only while it is a draft.
- **An invoice cannot overrun its PO.** Sending one that would take the PO past
  its committed amount is refused, and the error names the remedy: a change
  order or a new PO.
- **Voiding never deletes.** The invoice stays and its days become billable
  again.

`invoice_aging` buckets receivables the way a controller expects - current,
1-30, 31-60, 61-90, 90+ - and excludes drafts, because nobody owes us anything
until an invoice is issued.

## The assistant

`claude-opus-5`, adaptive thinking, effort `high`, a manual streaming loop in
`agent.js` rather than the SDK tool runner — because the point of this build is
that every step is observable, and the loop is where the instrumentation hangs.

Fifty-two tools cover accounts, sites, contacts, projects, submissions,
interviews, activity, documents, pipelines, timesheets, approvals, unlocks,
invoices, PO burn-down and the audit trail. Two of them matter more than the
rest:

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

139 tests against a real Postgres database built from the same `schema.sql` the
application uses — the constraints are where most of the design lives, and a
mock would not catch them. The agent loop is exercised with a scripted stand-in
for the Anthropic client, so tool dispatch, trace capture, the iteration cap,
parallel tool results and cache stability are all covered without a key.

The time and money path gets the most attention: a day split across two
projects, the 24-hour and in-week limits, a PO from the wrong project, a locked
week, partial approval, rejection releasing value, a week reopening for
correction, a project with no approver on file, double-billing, invoicing
unapproved time, changing a sent invoice, overrunning a purchase order, the rate
in force on a given day, and every column of the burn-down at each stage. The
audit trail is tested by writing straight past the application - a raw insert is
recorded the same as one through the API - and the lock from both sides, through
the repo and by direct SQL.

The pipeline is tested the same way, from both sides of the application: a
submission created at `offer` by raw SQL, a jump to `placed`, a stage moved by
`update submission set stage=...` at a psql prompt, an attempt to rewrite the
history, a loss with a well-written explanation but no code, a placement naming
the wrong person, a second recruiter on somebody already out, and the same check
firing again when a rejected submission is revived behind them. Each of those is
asserted on the error text as well as the refusal, because an error a recruiter
cannot act on is most of a bug: the machine tells you what you *can* do from
where you are.

**What is not covered:** no test in this suite makes a live Claude API call.
The request shape is asserted against the documented parameters, but the round
trip has not been run in this environment because no credential was available.
Add a key and send one message — if it answers, the loop is good.
