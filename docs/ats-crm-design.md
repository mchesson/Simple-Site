# Designing an Applicant Tracking System + CRM for a Staffing Firm

**Scope assumed:** custom build, 75+ recruiters, multi-brand/multi-division, covering
contract (W-2), direct hire, contract-to-hire, and SOW/project engagements.

---

## 0. The honest framing

At this scope you are not building "an ATS." You are building the operational and
financial system of record for the whole company: the thing that decides who gets
paid, how much margin each desk produced, and whether you can prove compliance to a
federal auditor. Commercial products in this space (Bullhorn, JobDiva, Erecruit)
represent 15+ years of accumulated edge cases, and most of that accumulation is not
features — it is payroll rules, state tax law, VMS quirks, and invoicing.

Two rules that hold even if you build everything else yourself:

1. **Do not build payroll, tax withholding, ACA tracking, invoicing, or AR.** The
   rules change quarterly across 50 states, and getting them wrong is unpaid-wage
   litigation, not a bug. Own placement, rate schedules, and approved time; export
   to a back-office/payroll system and consume invoice + payment status back.
2. **Build the timesheet capture and approval workflow.** It is tightly coupled to
   placements and rates, clients demand your portal, and it is where your margin
   data is actually created.

Everything below assumes that boundary.

---

## 1. The one architectural decision that matters most

**ATS and CRM are one graph, not two systems.**

Legacy systems model `Candidate` and `Contact` as separate tables. In staffing that
is wrong, and it is expensive:

- The candidate you placed three years ago is now the hiring manager giving you the
  req. In a two-table model she is two records with no link, and you never notice.
- A hiring manager changes companies. That is the warmest lead your business will
  ever get, and a two-table model turns it into a stale contact record.
- Multi-brand doubles every duplicate.

Design instead:

```
person  (identity — one row per human, forever)
  ├── person_role         (candidate | client_contact | reference | vendor_contact | internal)
  ├── person_employment   (effective-dated: who they worked for, when, as what)
  ├── candidate_profile   (work auth, availability, rate expectations)
  └── consent / eeo_self_id / credential / document
```

"Client contact" is not a record type. It is *a person with a current employment row
at an organization you sell to*. That single change gives you, for free:

- "Who do we know at Company X?"
- "Which people we placed are now decision-makers?"
- Contact-moved alerts, which is the highest-conversion lead source a staffing firm has.

---

## 2. Domain model

### 2.1 Organizations, and the MSP/VMS trap

A large staffing firm's revenue flows through three different shapes of counterparty,
and flattening them destroys your reporting:

- **Direct client** — you contract with them, you invoice them.
- **MSP/VMS intermediary** (Fieldglass, Beeline, Coupa, Simplify) — you contract with
  and invoice *them*, but the work happens at an end client.
- **Sub-vendor / tiered supplier** — someone else's worker on your contract, or yours
  on theirs.

So a job order carries **two** organization references:

- `client_org_id` — the contracting/invoicing party (may be the MSP)
- `end_client_org_id` — where the work actually happens

Firms that store only one cannot answer *"what is our total revenue with Client X
across direct and MSP channels?"* — which is the question that decides account
strategy. Model the corporate hierarchy (`organization.parent_id`) and explicit
`organization_relationship` edges (`msp_for`, `subsidiary_of`, `sub_vendor_to`).

### 2.2 Job order

One entity, discriminated by `employment_type` (contract | perm | c2h | sow), not four
tables. Type-specific fields live in the type-specific columns and are validated by
type. Key fields beyond the obvious:

- `source` (direct | vms | referral) and `external_ref` (the VMS req ID) with a unique
  constraint on `(client_org_id, external_ref)` — this is your ingest idempotency key.
- A rate envelope: max bill, max pay, or salary band. This is what makes submissions
  checkable before they embarrass you.
- Structured salary range **per jurisdiction**, required. CO, CA, NY, WA, and IL
  mandate pay ranges in postings; make the field required and block posting without
  it rather than trusting recruiters.

### 2.3 Pipeline: stage events, not a status column

```
submission  (job_order × person, unique — one row)
  └── submission_stage_event  (append-only)
```

The current `stage` on `submission` is a denormalized convenience. The **only** truth
about the funnel is the append-only event stream. Never compute time-to-submit or
time-to-fill from `updated_at`; you will change stage definitions at least twice and
you need to recompute history when you do.

Capture `rejected_reason_code` as a controlled vocabulary. "Client passed" is useless;
"rate too high / skills gap / lost to another supplier / req cancelled" tells you which
of those is costing you money.

### 2.4 Right-to-represent conflicts

Two of your brands submitting the same person to the same client is a real,
recurring, credibility-destroying event. It needs to be structurally impossible:

```
candidate_representation (person_id, client_org_id, brand_id, submitted_at, expires_at)
```

Checked at submit time **across all brands**, regardless of the visibility rules that
otherwise separate them. This is one of the few places where multi-brand isolation
must be deliberately pierced.

### 2.5 Placement — the money object

Everything financial hangs off `placement`. Two things make it harder than it looks:

**Chains.** Extensions, conversions, and redeployments are not new unrelated
placements. `parent_placement_id` and `conversion_placement_id` let you answer
"how long has this contractor been with us" and "what did this account really
produce over three years."

**Rates are effective-dated, and this is the single most common schema mistake.**

Do not put `pay_rate` and `bill_rate` columns on `placement`. Reality:

- Merit increases and client rate changes mid-assignment
- OT/DT/holiday multipliers that differ by state
- Shift differentials, per-diem, expense pass-through, completion bonuses
- Burden (taxes, WC, benefits, ACA) varying by state and worker type

```
placement_rate (placement_id, rate_type, unit, pay_rate, bill_rate,
                burden_pct, effective_from, effective_to, supersedes_id)
```

Rows are **never updated**. A rate change inserts a new row and closes the old one.
Enforce non-overlap with a Postgres exclusion constraint on
`(placement_id, rate_type, daterange)`. This is what lets an invoice from eight months
ago reprice to exactly the same number today — which you will need during a client
audit or a wage dispute.

**Freeze the resolved rate onto the timesheet line at approval.** If timesheet lines
join to the rate table at read time, a retroactive correction silently rewrites
history that has already been invoiced and paid.

### 2.6 Margin math, defined exactly once

```
gross margin $ = bill_rate − pay_rate − burden
markup %       = (bill_rate / pay_rate) − 1
GM %           = (bill_rate − pay_rate − burden) / bill_rate
```

Staffing firms lose real money because these are re-implemented in six places —
the submission screen, the placement screen, the commission report, the BI
dashboard — and they disagree. One service, one set of unit tests, called by
everything, including reporting.

**The trap this exposes:** because burden scales with pay, passing a pay increase
through to the client one-for-one *loses you money*. Verified against the schema in
`schema/core.sql`, same placement, 22% burden:

| Period | Pay | Bill | GM $/hr | Markup |
|---|---|---|---|---|
| Before merit increase | $65.00 | $95.00 | **$15.70** | 46.2% |
| After +$5 pay, +$5 bill | $70.00 | $100.00 | **$14.60** | 42.9% |

A recruiter who "held the spread" at $30/hr just gave away $1.10/hr — about $2,300
over a year-long assignment, invisible on every screen that displays spread instead
of margin. Show GM$ and GM%, never raw spread, and make the rate-change screen
compute the bill rate required to hold margin.

### 2.7 Ownership and commission splits

At 75+ recruiters this is the political center of gravity of the entire system.

There is no `owner_id`. There is:

```
job_order_ownership (job_order_id, user_id, role, share_pct, effective_from, effective_to)
placement_credit    (placement_id, user_id, role, share_pct, locked_at)
```

Roles: account manager, recruiter, sourcer, closer. Shares sum to 100 per role class.
Splits are set at submission time, **locked at placement**, and changes after lock
require an approval workflow plus an audit row — because changing a split after the
fact is a pay dispute, and it will happen.

---

## 3. Access control: multi-brand is ABAC, not RBAC

The tension is structural:

- Brand A's recruiters must not see Brand B's client rate cards and margins.
- A shared candidate pool is the entire reason you are one company.

So visibility is per-entity-class, not per-user-role:

| Data | Default visibility |
|---|---|
| People / resumes / candidate profiles | Global across brands (subject to consent scope) |
| Organizations, job orders, submissions | Brand-scoped, with explicit sharing grants |
| Rates, margins, commissions | Separately gated — a recruiter can see the req without seeing the spread |
| EEO self-ID | Invisible to everyone making selection decisions, always |

Implement as a single policy layer in the application (one place, testable) with
**Postgres row-level security as defense in depth** — not as the primary mechanism,
because RLS policies expressing this get unreadable fast, but as the thing that saves
you when a new endpoint forgets to filter.

Log every access to candidate PII (`user_id`, `person_id`, fields, purpose). You need
this for GDPR/CCPA subject access requests and, one day, for a breach investigation.
Partition the table by month; it gets large.

---

## 4. Identity resolution

Multi-brand plus years of resume ingest means millions of person records and a
duplicate rate that will exceed 25%.

**Do not dedupe on email uniqueness.** People change jobs and lose addresses; families
share addresses; agencies submit under their own. A unique index on email will cause
production incidents and block legitimate records.

Instead, a scoring pipeline:

- **Deterministic keys:** normalized email, E.164 phone, LinkedIn URL slug.
- **Probabilistic:** name similarity + geography + overlap in employment history
  (`person_employment` earns its keep here) + resume text similarity.
- Auto-merge above a high threshold, auto-reject below a low one, and route the
  middle band to a human review queue. Tune the thresholds with a labeled sample
  before you trust them.

**Merges must be reversible.** Store the full pre-merge record as JSON in a
`person_merge` audit table. A bad merge destroys two people's histories, and it will
happen during migration when data quality is at its worst.

Make the ingest pipeline idempotent — the same resume will arrive four times from
four sources.

---

## 5. Search is the product

Recruiters live in search. This is where custom builds can genuinely beat commercial
products, and where they most often fail.

**Hybrid retrieval, not pure vector.** Recruiters think in Boolean and will not give
that up: `(java OR kotlin) AND "spring boot" AND NOT contractor`. Pure semantic
search feels magical in a demo and gets abandoned in week three because it cannot
express a hard requirement.

- **Lexical + facets:** OpenSearch/Elasticsearch — Boolean, phrase, proximity,
  facets, geo-radius.
- **Semantic:** vector index (pgvector is sufficient at your scale) over resume and
  profile text for "find people like this one."
- **Fuse** with reciprocal rank fusion, and let the recruiter see and override which
  side is driving.

**Rank on actionability, not just similarity.** This is the real insight, and it is
something no job board can do because they lack your data:

> A 95%-skill-match candidate who has ghosted you twice is worse than an 80% match
> who answers the phone.

Ranking features worth more than skill similarity: recency of last contact, stated
availability date, prior placement history with you, response rate, redeployment
eligibility, whether the person is currently on assignment ending in 30 days.

**Normalize skills.** Seed a taxonomy from ESCO/O*NET, layer your own aliases, store
both the raw extracted string and the normalized concept. Otherwise "React",
"ReactJS", and "React.js" are three different skills and every search misses a third
of your database.

---

## 6. Where AI pays, and where it is legally dangerous

**Pays for itself immediately:**

- Resume → structured profile extraction (this is the big one; it is the difference
  between a searchable database and a document dump)
- Call and interview note summarization from transcripts
- Submission write-ups and job description drafting
- Search query expansion and "why this candidate" explanations
- Duplicate-match scoring

**Legally dangerous:** anything that becomes a de facto screen.

- **NYC Local Law 144** requires an annual independent bias audit and candidate
  notice for automated employment decision tools.
- **Illinois** AI Video Interview Act; **Colorado** AI Act; the **EU AI Act**
  classifies employment screening as high-risk.
- **EEOC** disparate-impact exposure applies to your model whether or not you
  intended a screen.

Design principle, enforced in the schema: **AI recommends and drafts; a human decides,
and the decision row carries a human `user_id`.** Never auto-reject. Keep ranking
features auditable and keep protected characteristics *and their proxies* — zip code,
graduation year, name-derived ethnicity, employment gaps — out of ranking features.
Log every inference with its input and output.

Contractually: no candidate PII to a model endpoint without a DPA and zero-retention
terms.

---

## 7. Compliance is schema, not a checkbox

Retrofitting these is brutal. Build them in from the first migration.

- **EEO / veteran / disability self-ID** lives in its own table with its own access
  policy, revoked from every recruiter role. OFCCP requires you to collect it *and*
  requires that it not influence selection; the only defensible design is structural
  separation.
- **OFCCP internet applicant rule:** if you hold federal contracts, the *search
  criteria* you used to screen are a retained record, not just the results. Log
  searches (`search_audit`) with the query and the returned IDs. Retain 2–3 years.
  Almost nobody builds this and everybody needs it.
- **Consent** is per-purpose and per-channel (representation, marketing email, SMS,
  retention), with the policy version and the exact text shown, timestamped and
  revocable. TCPA damages are statutory and per-message; "we think they opted in" is
  not a defense.
- **Right to erasure vs. recordkeeping.** These genuinely conflict. Resolve it as:
  erasure pseudonymizes the `person` and purges free-text PII, while placement and
  financial records survive against a tombstoned identity. Decide this before PII
  smears itself across notes and synced email bodies.
- **Credentials with expiry** (licenses, certs, clearances, drug screens, I-9,
  client-specific onboarding packets) with proactive alerting. A contractor whose
  cert lapses mid-assignment is simultaneously a compliance breach and a billing stop.
- **Worker classification** (`worker_type`: w2 | 1099 | c2c_sub | perm) drives
  distinct required-document sets. Misclassification is the most expensive
  single mistake in this industry.
- **Do not store SSN or DOB** if you can avoid it. Let the background-check and
  payroll vendors hold them and store a vendor token. If you must, field-level
  encryption with a separate key and separate access policy.

---

## 8. System architecture

**Modular monolith, not microservices.** At 75–300 internal users plus portals you do
not have a scale problem, you have a complexity problem. One deployable, one language,
hard module boundaries, Postgres as the primary store. Microservices here will cost
you a year and buy nothing.

Modules with enforced boundaries:

```
identity/people · organizations · jobs · pipeline · placements+rates
time+approval · communications · search · integrations · analytics · policy/admin
```

**An event log is the spine.** Every meaningful state change writes to
`domain_event` (append-only) in the same transaction as the change, with an
`event_outbox` row for delivery.

```
placement.created · placement.rate_changed · submission.stage_changed
timesheet.approved · person.merged · consent.revoked
```

That one pattern buys you four things you would otherwise bolt on badly: a real audit
trail, integration delivery with retries, analytics read models, and the ability to
recompute metrics after you redefine them.

Rest of the stack:

- **Background workers** for resume parse, index, enrichment, notification, VMS
  polling. Idempotent, retryable, with a dead-letter queue someone actually watches.
- **Object storage** for resumes and documents. Virus-scan on ingest, short-lived
  signed URLs, never serve files from the app origin.
- **CQRS only on the read side** — analytics and search read models, not
  transactional writes.
- **Integration gateway** as its own module with per-vendor adapters, because every
  vendor API will change and you want the blast radius contained.

---

## 9. Integrations, in priority order

1. **Email + calendar sync (Microsoft Graph)** — you are on M365, and this is the
   highest-leverage integration in the entire system. See §10.
2. **Payroll / back office** — the boundary from §0. Export placements, rates, and
   approved time; import invoice and payment status (you need paid-status for
   commission-on-cash and DSO).
3. **Resume parsing** — buy it (Textkernel/Sovren, Daxtra, or an LLM pipeline);
   do not write a resume parser.
4. **Job boards** — Indeed, LinkedIn RSC, Dice, ZipRecruiter; plus your own careers
   site as a first-class posting target.
5. **E-signature** (DocuSign/Dropbox Sign) for offer letters, RTRs, onboarding packets.
6. **Background check / drug screen / MVR** (HireRight, Checkr, First Advantage).
7. **Texting** (Twilio) — with TCPA consent gating enforced at the send path, not the UI.
8. **VMS/MSP.** Be realistic: many VMS platforms have no usable supplier API, and
   humans re-key reqs today. Design for API where it exists, structured email
   ingestion where it does not, and treat the VMS as an ingest *source* with the req
   ID as external key. Never let VMS reqs enter your CRM as though you own the
   end-client relationship.
9. **Enrichment / contact data** for BD (org charts, direct dials).

---

## 10. UX: the adoption problem is the real problem

The technical design is not what kills these projects. Recruiter adoption is. Legacy
ATS deployments fail because logging an activity costs 40 seconds and recruiters,
paid on placements, rationally decline. Then reporting is fiction, and the fiction
gets used for commission disputes.

Design targets:

- **Auto-capture beats data entry.** Graph-based email and calendar sync that logs
  interactions against people and organizations automatically is *most of your CRM
  data capture*. Build this in phase 1, not phase 4.
- **A desk home screen**, not a dashboard: submissions awaiting client feedback,
  interviews today, assignments ending in 30 days (redeployment is the cheapest
  revenue in staffing), contractors with expiring credentials, hot reqs, and today's
  call list.
- **One screen per job order** with the full pipeline, drag between stages, inline
  notes, bulk actions, keyboard shortcuts. Recruiters are power users; treat them as
  such.
- **Click-to-call and click-to-text** with automatic logging.
- **Mobile is read + text + log**, not full data entry. Nobody enters a placement
  from a phone.
- **Never hard-require a field the recruiter does not have yet.** Progressive
  completeness with a visible data-quality score beats validation errors, which
  teach people to type "N/A".

---

## 11. Metrics to instrument from day one

These drive the analytics read model, and the event log must make them derivable
retroactively because you will change the definitions.

| Category | Metrics |
|---|---|
| Funnel | Submissions per req, submission→interview, interview→offer, offer→start |
| Speed | Time to first submission (the best single predictor of a fill), time to fill |
| Outcome | Fill rate, fall-off rate under 90 days, conversion rate on C2H |
| Money | GM$ per recruiter per week, average spread, GM%, revenue per desk |
| Retention | Average assignment length, extension rate, redeployment rate |
| Cash | DSO, unbilled approved time, aged unapproved timesheets |
| Source | Source-of-hire ROI by channel and by spend |
| Activity | Calls, emails, meetings, new candidates added per desk |

Time to first submission and redeployment rate are the two most under-instrumented
and most predictive. Both are cheap if the event log exists from the start.

---

## 12. Phased roadmap

**Phase 0 — Decision gate (2–4 weeks).** Data model, migration inventory, and an
honest build-vs-buy calculation. Commercial: roughly $100–200/user/month, so ~100
users is $150–250k/yr all-in. Custom: 4–8 engineers for 12–24 months to parity, plus
permanent maintenance. Custom only wins if the search/matching/data layer is a real
competitive moat for you. Ship this analysis before writing code.

**Phase 1 — The graph and the search (3–4 months).** People, organizations,
employment history, job orders, submissions with stage events, activities, resume
ingest, hybrid search, Graph email/calendar sync. Run in parallel with the existing
system for **one desk in one brand**. This phase is where you learn whether adoption
will happen.

**Phase 2 — Placements and compliance (2–3 months).** Placements, effective-dated
rate schedules, onboarding document packets, credentials with expiry, EEO and consent
tables, payroll/back-office export. This is where you actually go live, because this
is where the money is.

**Phase 3 — Time and portals (2–3 months).** Timesheets, client approver workflow,
expense capture, candidate and client portals, invoicing handoff, payment status
ingest.

**Phase 4 — Leverage (ongoing).** Commission engine, analytics warehouse, VMS
ingestion, AI assist, multi-brand sharing rules hardening, BD/enrichment automation.

**Migration:** hot-load the last three years, keep the rest as a cold searchable
archive. Migrate the dirtiest data last, once identity resolution is tuned on clean
data. Never migrate into a system that is still changing its person model.

---

## 13. Risks, ranked by what actually kills these projects

1. **Recruiters do not adopt it**, reporting becomes fiction, and the project is
   declared a success while the old spreadsheets keep running the business.
   *Mitigation: auto-capture, one desk at a time, and a named recruiter on the team.*
2. **Scope creep into payroll and invoicing.** The single most reliable way to turn
   an 18-month project into a 4-year one.
3. **Rates modeled as scalars.** Discovered in month 14, during an audit.
4. **Commission splits designed late**, then relitigated with real money attached.
5. **Compliance retrofitted** — EEO separation, consent, erasure, and search audit
   are cheap now and near-impossible later.
6. **Identity resolution deferred**, so migration creates a permanent duplicate mess.
7. **Integration rot** — no one owns the adapters, and job boards break silently.
8. **Key-person risk.** A custom system of record with three people who understand
   it is an existential dependency. Document, test, and cross-train from day one.

---

## Appendix: what has been verified

`schema/core.sql` is not a sketch on paper — the full DDL was executed against
PostgreSQL 16.13, and the constraints that carry the design's weight were tested
behaviorally:

| Check | Expected | Result |
|---|---|---|
| Full schema DDL executes | clean | passes (`postgis` stubbed; not installed locally) |
| Second rate type over the same date window | allowed | allowed |
| Overlapping window, same rate type | rejected | rejected by exclusion constraint |
| Merit increase adjacent to a closed window | allowed | allowed |
| Second open-ended window, same rate type | rejected | rejected |
| Same person submitted twice to one req | rejected | rejected by `submission_uq` |
| Point-in-time rate resolution via `validity @> work_date` | correct rate per date | correct |

Not verified, because they are design positions rather than DDL: the ABAC/RLS policy
layer, identity-resolution thresholds, search ranking, and every integration boundary.
Treat those as decisions to validate with a spike, not as settled.
