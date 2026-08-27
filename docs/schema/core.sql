-- =====================================================================
-- Staffing ATS + CRM: core schema sketch
--
-- Covers only the parts that are hard or impossible to change later.
-- Postgres 15+. Illustrative, not migration-ready: indexes are partial,
-- lookup/vocabulary tables are elided, and text status columns should
-- become enums or FK'd vocabularies before you ship.
--
-- Rationale for each decision is in ../ats-crm-design.md.
-- =====================================================================

create extension if not exists citext;
create extension if not exists btree_gist;   -- needed for the rate exclusion constraint
create extension if not exists postgis;      -- geo-radius candidate search

-- ---------------------------------------------------------------------
-- Tenancy: brands / divisions / teams / users
-- ---------------------------------------------------------------------

create table brand (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,          -- 'TS', 'TS-GOV'
  name          text not null,
  legal_entity  text,                          -- payroll + invoicing entity
  is_active     boolean not null default true
);

create table team (
  id        uuid primary key default gen_random_uuid(),
  brand_id  uuid not null references brand(id),
  parent_id uuid references team(id),           -- division > branch > desk
  name      text not null
);

create table app_user (
  id        uuid primary key default gen_random_uuid(),
  brand_id  uuid not null references brand(id),
  team_id   uuid references team(id),
  email     citext not null unique,
  full_name text not null,
  is_active boolean not null default true
);

-- ---------------------------------------------------------------------
-- PEOPLE
-- One table for candidates AND client contacts. Role is an attribute of
-- a person, not a record type. See design doc section 1.
-- ---------------------------------------------------------------------

create table person (
  id                uuid primary key default gen_random_uuid(),

  first_name        text,
  last_name         text,
  preferred_name    text,
  full_name         text not null,

  -- match keys, normalized by the ingest pipeline
  email_primary     citext,
  phone_e164        text,
  linkedin_slug     text,

  location_country  text,
  location_region   text,                       -- state / province
  location_locality text,
  geo               geography(point),

  status            text not null default 'active',
                    -- active | do_not_contact | pseudonymized
  -- non-null means this row is a merge tombstone; all reads follow the pointer
  merged_into_id    uuid references person(id),

  completeness      smallint not null default 0,   -- data quality score, not validation
  created_at        timestamptz not null default now(),
  created_by        uuid references app_user(id)
);

-- NOTE: deliberately NOT unique. People share and lose email addresses, and
-- agencies submit under their own. Uniqueness here causes production incidents.
-- These are match *candidates* for the resolution pipeline (design doc section 4).
create index person_email_ix    on person (email_primary) where merged_into_id is null;
create index person_phone_ix    on person (phone_e164)    where merged_into_id is null;
create index person_linkedin_ix on person (linkedin_slug) where merged_into_id is null;
create index person_geo_ix      on person using gist (geo);

create table person_role (
  person_id uuid not null references person(id),
  role      text not null,   -- candidate | client_contact | reference | vendor_contact | internal
  since     date,
  primary key (person_id, role)
);

-- Effective-dated employment history. Powers three high-value questions:
--   "who do we know at Company X"
--   "which people we placed are now hiring managers"
--   contact-moved alerts (highest-conversion lead source in staffing)
create table person_employment (
  id              uuid primary key default gen_random_uuid(),
  person_id       uuid not null references person(id),
  organization_id uuid,                       -- FK added after organization below
  org_name_raw    text,                       -- as parsed, before entity resolution
  title           text,
  started_on      date,
  ended_on        date,
  is_current      boolean generated always as (ended_on is null) stored,
  is_hiring_manager  boolean not null default false,
  is_decision_maker  boolean not null default false,
  source          text                        -- resume | manual | enrichment | email_sync
);
create index person_employment_person_ix on person_employment (person_id);
create index person_employment_org_ix    on person_employment (organization_id) where is_current;

create table candidate_profile (
  person_id         uuid primary key references person(id),
  work_auth         text,          -- us_citizen | perm_resident | h1b | ead | ...
  needs_sponsorship boolean,
  worker_type_pref  text[],        -- w2 | 1099 | c2c | perm
  available_from    date,
  desired_pay_min   numeric(12,2),
  desired_pay_max   numeric(12,2),
  desired_pay_unit  text,          -- hourly | annual
  work_mode_pref    text,          -- onsite | hybrid | remote
  will_relocate     boolean,
  current_title     text,
  years_experience  numeric(4,1),
  summary           text,

  -- actionability signals: these outrank skill similarity in search (section 5)
  last_contacted_at timestamptz,
  response_score    smallint,      -- 0-100, derived from outreach outcomes
  do_not_submit     boolean not null default false
);

-- Merges MUST be reversible: a bad merge destroys two people's histories,
-- and merges are riskiest during migration when data quality is worst.
create table person_merge (
  id             bigserial primary key,
  winner_id      uuid not null references person(id),
  loser_id       uuid not null references person(id),
  loser_snapshot jsonb not null,               -- full pre-merge record, for rollback
  match_score    numeric(5,4),
  decided_by     uuid references app_user(id), -- null = auto-merged above threshold
  occurred_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- ORGANIZATIONS
-- Two org references on a job order (client vs end client) is what makes
-- MSP/VMS revenue reportable. See design doc section 2.1.
-- ---------------------------------------------------------------------

create table organization (
  id        uuid primary key default gen_random_uuid(),
  parent_id uuid references organization(id),   -- corporate hierarchy
  name      text not null,
  domain    text,
  kind      text not null,   -- client | prospect | msp_vms | sub_vendor | end_client
  status    text,            -- target | active | dormant | do_not_use | credit_hold
  created_at timestamptz not null default now()
);

alter table person_employment
  add constraint person_employment_org_fk
  foreign key (organization_id) references organization(id);

create table organization_relationship (
  from_org_id uuid not null references organization(id),
  to_org_id   uuid not null references organization(id),
  kind        text not null,   -- msp_for | subsidiary_of | sub_vendor_to
  primary key (from_org_id, to_org_id, kind)
);

-- ---------------------------------------------------------------------
-- JOB ORDERS
-- ---------------------------------------------------------------------

create table job_order (
  id                uuid primary key default gen_random_uuid(),
  brand_id          uuid not null references brand(id),

  client_org_id     uuid not null references organization(id),  -- who you invoice (may be the MSP)
  end_client_org_id uuid references organization(id),           -- where the work happens
  hiring_manager_id uuid references person(id),

  source            text not null,   -- direct | vms | referral
  external_ref      text,            -- VMS req id
  employment_type   text not null,   -- contract | perm | c2h | sow

  title             text not null,
  description       text,
  openings          smallint not null default 1,
  status            text not null,   -- draft | open | on_hold | filled | closed | lost
  lost_reason_code  text,

  -- rate envelope: makes submissions checkable before they embarrass you
  bill_rate_max     numeric(12,2),
  pay_rate_max      numeric(12,2),
  salary_min        numeric(12,2),
  salary_max        numeric(12,2),

  -- CO/CA/NY/WA/IL pay transparency: block posting when required and absent
  pay_range_required boolean not null default false,
  work_state        text,
  work_mode         text,            -- onsite | hybrid | remote

  opened_at         timestamptz not null default now(),
  target_start_on   date,

  -- ingest idempotency key for VMS polling / email ingestion
  constraint job_order_external_uq unique (client_org_id, external_ref)
);

-- No owner_id. Ever. See design doc section 2.7.
create table job_order_ownership (
  id             uuid primary key default gen_random_uuid(),
  job_order_id   uuid not null references job_order(id),
  user_id        uuid not null references app_user(id),
  role           text not null,          -- account_manager | recruiter | sourcer
  share_pct      numeric(5,2) not null check (share_pct > 0 and share_pct <= 100),
  effective_from timestamptz not null default now(),
  effective_to   timestamptz
);
-- Active shares must sum to 100 per role class. Enforce in the application
-- plus a nightly assertion job; a DB constraint here is not worth the pain.

-- ---------------------------------------------------------------------
-- PIPELINE
-- The stage column is a convenience. The event stream is the truth.
-- ---------------------------------------------------------------------

create table submission (
  id                  uuid primary key default gen_random_uuid(),
  job_order_id        uuid not null references job_order(id),
  person_id           uuid not null references person(id),

  stage               text not null,        -- denormalized from the event stream
  stage_since         timestamptz not null default now(),
  outcome             text,                 -- placed | rejected | withdrew | req_cancelled

  -- controlled vocabulary: "client passed" tells you nothing,
  -- "rate_too_high" vs "skills_gap" vs "lost_to_competitor" tells you where money leaks
  rejected_reason_code text,

  submitted_pay_rate  numeric(12,2),
  submitted_bill_rate numeric(12,2),
  submitted_salary    numeric(12,2),

  created_at          timestamptz not null default now(),
  created_by          uuid references app_user(id),

  constraint submission_uq unique (job_order_id, person_id)
);

-- Append-only. Never compute time-to-fill from updated_at: stage definitions
-- will change and you must be able to recompute history.
create table submission_stage_event (
  id            bigserial primary key,
  submission_id uuid not null references submission(id),
  from_stage    text,
  to_stage      text not null,
  occurred_at   timestamptz not null default now(),
  actor_user_id uuid references app_user(id),
  note          text
);
create index submission_stage_event_ix on submission_stage_event (submission_id, occurred_at);

-- Right-to-represent. Checked at submit time ACROSS ALL BRANDS -- one of the
-- few places multi-brand isolation is deliberately pierced (section 2.4).
create table candidate_representation (
  id            uuid primary key default gen_random_uuid(),
  person_id     uuid not null references person(id),
  client_org_id uuid not null references organization(id),
  brand_id      uuid not null references brand(id),
  submission_id uuid references submission(id),
  submitted_at  timestamptz not null default now(),
  expires_at    timestamptz not null            -- typical RTR window: 6-12 months
);
create index candidate_representation_ix
  on candidate_representation (person_id, client_org_id, expires_at);

-- ---------------------------------------------------------------------
-- PLACEMENTS + RATES
-- The money objects. Rates are effective-dated and immutable (section 2.5).
-- ---------------------------------------------------------------------

create table engagement (            -- SOW / project: many placements, milestones
  id              uuid primary key default gen_random_uuid(),
  brand_id        uuid not null references brand(id),
  client_org_id   uuid not null references organization(id),
  name            text not null,
  contract_value  numeric(14,2),
  starts_on       date,
  ends_on         date,
  status          text not null
);

create table placement (
  id                uuid primary key default gen_random_uuid(),
  submission_id     uuid not null references submission(id),
  brand_id          uuid not null references brand(id),
  engagement_id     uuid references engagement(id),

  worker_type       text not null,   -- w2 | 1099 | c2c_sub | perm_hire
  employment_type   text not null,   -- contract | perm | c2h | sow

  starts_on         date not null,
  ends_on           date,            -- scheduled
  actual_end_on     date,
  end_reason        text,            -- completed | converted | terminated | fall_off | resigned

  status            text not null,   -- pending_onboarding | active | ended

  -- perm / direct hire
  fee_amount        numeric(12,2),
  fee_pct           numeric(5,2),
  guarantee_days    smallint,

  -- chains: extensions, conversions, redeployments are NOT unrelated placements
  parent_placement_id     uuid references placement(id),
  conversion_placement_id uuid references placement(id),
  buyout_schedule         jsonb,

  created_at        timestamptz not null default now()
);

-- THE most common schema mistake in staffing systems is pay_rate/bill_rate
-- as scalar columns on placement. Rates change mid-assignment; invoices from
-- eight months ago must reprice identically. Rows are NEVER updated -- a change
-- inserts a new row and closes the old one.
create table placement_rate (
  id             uuid primary key default gen_random_uuid(),
  placement_id   uuid not null references placement(id),

  rate_type      text not null,   -- regular | ot | dt | holiday | shift_diff
                                  -- | per_diem | expense | bonus
  unit           text not null,   -- hour | day | week | flat

  pay_rate       numeric(12,4) not null,
  bill_rate      numeric(12,4) not null,
  burden_pct     numeric(6,4),    -- taxes + WC + benefits + ACA, by state & worker_type

  effective_from date not null,
  effective_to   date,            -- null = open-ended
  validity       daterange generated always as
                   (daterange(effective_from, effective_to, '[)')) stored,

  supersedes_id  uuid references placement_rate(id),
  created_by     uuid references app_user(id),
  created_at     timestamptz not null default now(),

  -- no overlapping windows for the same rate type on the same placement
  exclude using gist (
    placement_id with =,
    rate_type    with =,
    validity     with &&
  )
);

-- Commission credit. Set at submission, LOCKED at placement. Post-lock changes
-- require an approval workflow plus an audit row -- this is a pay dispute (section 2.7).
create table placement_credit (
  placement_id uuid not null references placement(id),
  user_id      uuid not null references app_user(id),
  role         text not null,   -- account_manager | recruiter | sourcer | closer
  share_pct    numeric(5,2) not null check (share_pct > 0 and share_pct <= 100),
  locked_at    timestamptz,
  primary key (placement_id, user_id, role)
);

-- ---------------------------------------------------------------------
-- TIME CAPTURE
-- Build this. Do NOT build payroll, tax, or invoicing (design doc section 0).
-- ---------------------------------------------------------------------

create table timesheet (
  id                    uuid primary key default gen_random_uuid(),
  placement_id          uuid not null references placement(id),
  period_start          date not null,
  period_end            date not null,
  status                text not null,   -- open | submitted | approved | rejected
                                         -- | exported | paid
  approved_by_person_id uuid references person(id),   -- the CLIENT approver, a person
  approved_at           timestamptz,
  exported_batch_id     uuid,
  constraint timesheet_uq unique (placement_id, period_start)
);

create table timesheet_line (
  id                uuid primary key default gen_random_uuid(),
  timesheet_id      uuid not null references timesheet(id),
  work_date         date not null,
  rate_type         text not null,
  quantity          numeric(8,2) not null,

  -- Rates are RESOLVED AND FROZEN here at approval, not joined at read time.
  -- Otherwise a retroactive rate correction silently rewrites already-invoiced history.
  pay_rate_applied  numeric(12,4),
  bill_rate_applied numeric(12,4),
  burden_pct_applied numeric(6,4),
  placement_rate_id uuid references placement_rate(id)
);

-- ---------------------------------------------------------------------
-- COMPLIANCE
-- Cheap now, near-impossible to retrofit (design doc section 7).
-- ---------------------------------------------------------------------

-- Separate table, separate access policy, revoked from every role that makes
-- selection decisions. OFCCP requires collection AND requires non-influence;
-- structural separation is the only defensible design.
create table eeo_self_id (
  person_id    uuid primary key references person(id),
  gender       text,
  ethnicity    text[],
  veteran      text,
  disability   text,
  collected_at timestamptz not null default now(),
  source       text
);

-- Per-purpose, per-channel, versioned, revocable. TCPA damages are statutory
-- and per-message; store the exact text the person agreed to.
create table consent (
  id             bigserial primary key,
  person_id      uuid not null references person(id),
  purpose        text not null,   -- representation | marketing_email | sms | data_retention
  channel        text,
  granted        boolean not null,
  policy_version text not null,
  text_shown     text not null,
  occurred_at    timestamptz not null default now(),
  source         text,
  source_ip      inet
);
create index consent_ix on consent (person_id, purpose, occurred_at desc);

create table document (
  id           uuid primary key default gen_random_uuid(),
  person_id    uuid references person(id),
  placement_id uuid references placement(id),
  kind         text not null,   -- resume | rtr | offer_letter | i9 | w4 | client_packet | nda
  storage_key  text not null,   -- object store; served via short-lived signed URL only
  mime_type    text,
  byte_size    bigint,
  scan_status  text not null default 'pending',   -- virus scan on ingest
  uploaded_at  timestamptz not null default now()
);

-- A contractor whose cert lapses mid-assignment is a compliance breach AND a
-- billing stop. Alerting off expires_on is a phase-2 requirement, not a nice-to-have.
create table credential (
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid not null references person(id),
  kind        text not null,   -- license | cert | clearance | drug_screen
                               -- | background | i9 | vaccination
  identifier  text,
  issuer      text,
  issued_on   date,
  expires_on  date,
  verified_by uuid references app_user(id),
  document_id uuid references document(id)
);
create index credential_expiry_ix on credential (expires_on) where expires_on is not null;

-- OFCCP internet applicant rule: for federal contractors the SEARCH CRITERIA
-- used to screen are a retained record, not just the results. Almost nobody
-- builds this and everybody needs it. Retain 2-3 years.
create table search_audit (
  id                bigserial primary key,
  user_id           uuid not null references app_user(id),
  job_order_id      uuid references job_order(id),
  query             jsonb not null,     -- the actual criteria
  result_person_ids uuid[],
  occurred_at       timestamptz not null default now()
);

-- Needed for DSAR fulfilment and, one day, breach investigation. Gets large.
create table pii_access_log (
  id          bigserial,
  user_id     uuid not null,
  person_id   uuid not null,
  fields      text[],
  purpose     text,
  occurred_at timestamptz not null default now()
) partition by range (occurred_at);

-- ---------------------------------------------------------------------
-- EVENT SPINE
-- Written in the same transaction as the state change. Buys audit trail,
-- integration delivery, analytics read models, and metric recomputation
-- from one pattern (design doc section 8).
-- ---------------------------------------------------------------------

create table domain_event (
  id            bigserial primary key,
  aggregate     text not null,     -- placement | submission | person | timesheet
  aggregate_id  uuid not null,
  event_type    text not null,     -- placement.rate_changed | submission.stage_changed
  payload       jsonb not null,
  actor_user_id uuid references app_user(id),
  brand_id      uuid references brand(id),
  occurred_at   timestamptz not null default now()
);
create index domain_event_aggregate_ix on domain_event (aggregate, aggregate_id, id);

create table event_outbox (
  event_id        bigint not null references domain_event(id),
  destination     text not null,   -- search_index | payroll_export | webhook:<id>
  status          text not null default 'pending',
  attempts        smallint not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  primary key (event_id, destination)
);
create index event_outbox_due_ix on event_outbox (next_attempt_at)
  where status = 'pending';
