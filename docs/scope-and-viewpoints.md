# Who this is for, and what we are not building yet

Recorded so it does not drift. Agreed 28 August 2026.

## Six viewpoints, not one product

The system has six distinct audiences. They want different things from the same
data, and several of them should not see all of it.

| Viewpoint | What they come here for | Status |
|---|---|---|
| **Recruiting** | Seats to fill, who is out with a client, who has gone quiet, who is coming free, their own shortlists | **Active focus** |
| **Sales / account management** | Who to call and why now, accounts gone quiet, paperwork gaps, POs at risk, what each account is worth | **Active focus** |
| Back office | Timesheet approval, invoicing, PO burn-down, receivables, the audit trail and locking | Built to a working baseline, parked |
| Management | Desk performance, margin by account and by recruiter, fill rates, pipeline coverage, where the business is leaking | Not started |
| Customer (client managers) | Approve their people's time, see their own POs and invoices, and nothing else | Not started |
| Consultant | Enter their own week, see their assignment and their rates, and nothing else | Not started |

## What "focused on recruiting and sales" means in practice

- New work goes to the two active viewpoints: the front-office detail in the CRM
  and ATS. Submissions and pipeline stages, candidate search worth the name,
  activity that captures call outcomes and follow-up dates, resume parsing into
  a contact record, account planning.
- The back office stays as it is unless something is wrong. It reached a working
  baseline — allocate a week, route approval per project, lock approved time,
  bill it against a purchase order, audit everything — and that is enough for
  now.
- Management, customer and consultant views are not started, and no screen
  should be half-built for them.

## The deferred decision that has a shape

Access control is not one problem. It is two, and only one of them is cheap to
add later.

**Internal roles** — recruiting, sales, back office, management — are a
visibility question over data everybody in the company may legitimately see. A
row-level filter and a per-role navigation set will cover it. Layering that on
later costs little, because the data model already carries ownership: accounts
have owners, candidates have recruiters, projects have owners, and every write
is attributed.

**External users** — customers and consultants — are a different problem. A
client manager approving time and a consultant entering their week are people
outside Technical Source touching the same database. That needs authentication,
tenant isolation, and a surface that cannot reach anything else, and it cannot be
retrofitted as a filter over the internal app. It is a separate front end against
a narrowed API.

This matters now for one reason only: **nobody signs in yet.** The workspace picks
an acting user from a list, and a client manager's approval is recorded against a
typed name rather than an authenticated identity. That is fine while the only
users are us. It is the first thing to close before anyone outside the company
touches it — and closing it is the gate for the customer and consultant
viewpoints, not a detail inside them.

## What this does not change

The domain model stays as it is. One person graph, projects as the unit of work,
effective-dated rates, invoiced-not-worked as the burn, an audit trail on every
write. Those hold for all six viewpoints; only what each one is shown differs.
