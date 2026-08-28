-- TS Workspace schema.
--
-- Two rules run through the whole thing:
--   1. Nothing is destroyed. Updates write a revision row first; deletes are
--      an archived_at stamp. The history is the product, not a side effect.
--   2. One person graph. A human is a contact; whether they are a manager or a
--      candidate is a property of how we interact with them, not a separate table.

create extension if not exists btree_gist;

-- ---------------------------------------------------------------- people/users

-- Workspace users. Owners are drawn from this table and nowhere else, so you
-- cannot name a random string as the owner of an account.
create table app_user (
  id          uuid primary key default gen_random_uuid(),
  email       text not null unique,
  full_name   text not null,
  role        text not null default 'recruiter'
              check (role in ('recruiter','account_manager','admin','delivery')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ------------------------------------------------------------------- accounts

create table account (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  status        text not null default 'prospect'
                check (status in ('prospect','active','inactive','do_not_use')),
  industry      text,
  website       text,
  -- Screening set at the account level flows down to every location.
  bg_check_policy   text,
  drug_test_policy  text,
  onboarding_notes  text,
  notes         text,
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index account_name_uniq on account (lower(name)) where archived_at is null;

-- Multiple owners per account, each with a stake. Splits must be actual splits.
create table account_owner (
  account_id  uuid not null references account(id) on delete cascade,
  user_id     uuid not null references app_user(id),
  role        text not null default 'account_manager'
              check (role in ('account_manager','recruiter','executive')),
  split_pct   numeric(5,2) not null default 100 check (split_pct > 0 and split_pct <= 100),
  primary key (account_id, user_id)
);

create table location (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references account(id) on delete cascade,
  name        text not null,
  address1    text, address2 text, city text, state text, postal_code text,
  country     text not null default 'US',
  -- Rules of engagement and screening overrides live at the site.
  rules_of_engagement text,
  bg_check_notes      text,
  drug_test_notes     text,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index location_account_idx on location (account_id);

-- One row per human. is_manager / is_candidate are not exclusive: the hiring
-- manager at Globex can also be a candidate we interview next year.
create table contact (
  id            uuid primary key default gen_random_uuid(),
  full_name     text not null,
  email         text,
  phone         text,
  title         text,
  is_manager    boolean not null default false,
  is_candidate  boolean not null default false,
  -- Where they work when they are wearing the manager hat.
  account_id    uuid references account(id),
  location_id   uuid references location(id),
  -- Candidate-side detail.
  headline      text,
  skills        text[] not null default '{}',
  location_text text,
  -- A consultant on our payroll is declared as such, with their recruiter.
  on_payroll    boolean not null default false,
  recruiter_id  uuid references app_user(id),
  source        text,
  notes         text,
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- A manager has to work somewhere; a candidate does not.
  constraint manager_needs_account
    check (not is_manager or account_id is not null),
  -- Nobody is a contact for no reason.
  constraint has_a_role
    check (is_manager or is_candidate)
);
create index contact_account_idx  on contact (account_id);
create index contact_location_idx on contact (location_id);
create index contact_skills_idx   on contact using gin (skills);
create index contact_name_trgm    on contact (lower(full_name));
create unique index contact_email_uniq on contact (lower(email)) where email is not null and archived_at is null;

-- ------------------------------------------------------------------- projects

-- Everything we chase is a project. A project that needs one resource is still
-- a project; it just has less filled in. delivery_type is what changes the
-- paperwork and the compliance obligations, not the shape of the record.
create table project (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references account(id),
  location_id   uuid references location(id),
  name          text not null,
  delivery_type text not null default 'staffing'
                check (delivery_type in
                  ('staffing','contract_to_hire','direct_hire','managed_project','managed_service')),
  status        text not null default 'open'
                check (status in ('draft','open','on_hold','filled','closed','lost')),
  openings      int not null default 1 check (openings > 0),
  bill_rate_min numeric(12,4),
  bill_rate_max numeric(12,4),
  pay_rate_min  numeric(12,4),
  pay_rate_max  numeric(12,4),
  start_date    date,
  end_date      date,
  description   text,
  skills        text[] not null default '{}',
  owner_id      uuid references app_user(id),
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint location_belongs_to_account check (true)   -- enforced in trigger below
);
create index project_account_idx on project (account_id);
create index project_status_idx  on project (status) where archived_at is null;

-- A location has to belong to the project's account. A check constraint cannot
-- reach another table, so this is a trigger.
create or replace function project_location_matches() returns trigger as $$
begin
  if new.location_id is not null then
    if not exists (select 1 from location l
                   where l.id = new.location_id and l.account_id = new.account_id) then
      raise exception 'location % does not belong to account %', new.location_id, new.account_id;
    end if;
  end if;
  return new;
end $$ language plpgsql;
create trigger project_location_check before insert or update on project
  for each row execute function project_location_matches();

-- ---------------------------------------------------------------- submissions

create table submission (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references project(id),
  contact_id   uuid not null references contact(id),
  stage        text not null default 'submitted'
               check (stage in ('submitted','client_review','interview','offer','placed','rejected','withdrawn')),
  submitted_by uuid references app_user(id),
  pay_rate     numeric(12,4),
  bill_rate    numeric(12,4),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (project_id, contact_id)
);

-- Append only. The stage column above is a cache of the newest row here.
create table submission_event (
  id            bigserial primary key,
  submission_id uuid not null references submission(id) on delete cascade,
  from_stage    text,
  to_stage      text not null,
  reason        text,
  actor_id      uuid references app_user(id),
  occurred_at   timestamptz not null default now()
);
create index submission_event_sub_idx on submission_event (submission_id, occurred_at);

-- ----------------------------------------------------------------- placements

create table placement (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references project(id),
  contact_id   uuid not null references contact(id),
  status       text not null default 'active'
               check (status in ('pending','active','ended','cancelled')),
  start_date   date not null,
  end_date     date,
  recruiter_id uuid references app_user(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Rates are effective-dated and never edited in place. A correction supersedes
-- its predecessor; the exclusion constraint makes two rates of the same type
-- overlapping in time impossible, which is the bug that silently corrupts
-- margin reporting in every staffing system that stores a single rate column.
create table placement_rate (
  id             uuid primary key default gen_random_uuid(),
  placement_id   uuid not null references placement(id) on delete cascade,
  rate_type      text not null default 'standard'
                 check (rate_type in ('standard','overtime','doubletime','holiday')),
  unit           text not null default 'hour' check (unit in ('hour','day','week','month')),
  pay_rate       numeric(12,4) not null check (pay_rate >= 0),
  bill_rate      numeric(12,4) not null check (bill_rate >= 0),
  burden_pct     numeric(6,4) not null default 0 check (burden_pct >= 0),
  effective_from date not null,
  effective_to   date,
  validity       daterange generated always as
                 (daterange(effective_from, effective_to, '[)')) stored,
  supersedes_id  uuid references placement_rate(id),
  created_at     timestamptz not null default now(),
  constraint no_overlapping_rates
    exclude using gist (placement_id with =, rate_type with =, validity with &&)
);

-- Margin defined once, in the database, so every caller gets the same number.
-- Burden is a percentage of pay, not of bill: getting this backwards overstates
-- gross margin on every low-pay/high-bill placement.
create or replace function gross_margin(pay numeric, bill numeric, burden_pct numeric)
returns numeric language sql immutable as $$
  select bill - pay - (pay * coalesce(burden_pct,0) / 100.0)
$$;

create or replace function gross_margin_pct(pay numeric, bill numeric, burden_pct numeric)
returns numeric language sql immutable as $$
  select case when bill is null or bill = 0 then null
         else gross_margin(pay, bill, burden_pct) / bill * 100.0 end
$$;

-- ---------------------------------------------------- agreements & paperwork

-- An agreement is scoped either to the whole account or to one location.
create table agreement (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references account(id) on delete cascade,
  location_id  uuid references location(id),
  kind         text not null
               check (kind in ('MSA','NDA','rate_sheet','addendum','vms_terms')),
  status       text not null default 'draft'
               check (status in ('draft','out_for_signature','executed','expired','terminated')),
  effective_from date,
  effective_to   date,
  terms_notes  text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index agreement_account_idx on agreement (account_id);

-- Exhibit A / rate verification. Scoped to one resource on one project - it
-- confirms that person's rate and start date, so it cannot hang off an account.
create table rate_verification (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references project(id),
  contact_id   uuid not null references contact(id),
  placement_id uuid references placement(id),
  status       text not null default 'draft'
               check (status in ('draft','sent','confirmed','disputed','superseded')),
  pay_rate     numeric(12,4),
  bill_rate    numeric(12,4),
  start_date   date,
  end_date     date,
  confirmed_by text,
  confirmed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ------------------------------------------------------- SOW / PO / timecards

create table sow (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references project(id),
  title        text not null,
  status       text not null default 'draft'
               check (status in ('draft','out_for_signature','executed','completed','terminated')),
  start_date   date, end_date date,
  total_value  numeric(14,2),
  deliverables text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table change_order (
  id          uuid primary key default gen_random_uuid(),
  sow_id      uuid not null references sow(id) on delete cascade,
  number      int not null,
  status      text not null default 'draft'
              check (status in ('draft','out_for_signature','executed','rejected')),
  value_delta numeric(14,2) not null default 0,
  end_date    date,
  summary     text,
  created_at  timestamptz not null default now(),
  unique (sow_id, number)
);

create table purchase_order (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references project(id),
  sow_id      uuid references sow(id),
  po_number   text not null,
  amount      numeric(14,2) not null check (amount > 0),
  currency    text not null default 'USD',
  start_date  date,
  end_date    date,
  status      text not null default 'open'
              check (status in ('open','exhausted','expired','closed')),
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (project_id, po_number)
);
create index po_end_date_idx on purchase_order (end_date) where status = 'open';

create table timecard (
  id            uuid primary key default gen_random_uuid(),
  placement_id  uuid not null references placement(id),
  purchase_order_id uuid references purchase_order(id),
  week_ending   date not null,
  hours         numeric(8,2) not null default 0 check (hours >= 0),
  ot_hours      numeric(8,2) not null default 0 check (ot_hours >= 0),
  status        text not null default 'submitted'
                check (status in ('draft','submitted','approved','rejected','invoiced')),
  approved_by   text,
  approved_at   timestamptz,
  -- What we actually bill for this card. Stored, not derived, because the rate
  -- in force on the week ending date is what counts and rates move.
  billed_amount numeric(14,2),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (placement_id, week_ending)
);
create index timecard_po_idx on timecard (purchase_order_id);

-- Burn-down: committed money against approved and billed time, and how many
-- days of runway are left. One view so every screen in the org agrees.
create view po_burndown as
select
  po.id                as purchase_order_id,
  po.po_number,
  po.project_id,
  p.name               as project_name,
  a.name               as account_name,
  po.amount,
  po.start_date,
  po.end_date,
  po.status,
  coalesce(sum(tc.billed_amount) filter (where tc.status in ('approved','invoiced')), 0) as burned,
  coalesce(sum(tc.billed_amount) filter (where tc.status = 'submitted'), 0)              as pending_approval,
  po.amount - coalesce(sum(tc.billed_amount) filter (where tc.status in ('approved','invoiced')), 0) as remaining,
  case when po.amount = 0 then null else round(
    coalesce(sum(tc.billed_amount) filter (where tc.status in ('approved','invoiced')), 0)
    / po.amount * 100, 2) end as pct_burned,
  case when po.end_date is null then null
       else (po.end_date - current_date) end as days_remaining
from purchase_order po
join project p on p.id = po.project_id
join account a on a.id = p.account_id
left join timecard tc on tc.purchase_order_id = po.id
group by po.id, p.name, a.name;

-- ------------------------------------------------------------------ documents

-- One documents table. SharePoint is a storage location, not a second system:
-- the row is the record and sharepoint_url points at the filed original.
create table document (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null
                check (kind in ('resume','MSA','SOW','exhibit_a','NDA','RTR',
                                'rate_sheet','PO','change_order','other')),
  title         text not null,
  -- Exactly one scope. A resume belongs to a contact; an MSA to an account or
  -- a location; an Exhibit A to a project.
  account_id    uuid references account(id),
  location_id   uuid references location(id),
  project_id    uuid references project(id),
  contact_id    uuid references contact(id),
  sharepoint_url  text,
  sharepoint_path text,
  content_text  text,             -- extracted text, for search
  mime_type     text,
  byte_size     int,
  uploaded_by   uuid references app_user(id),
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  constraint exactly_one_scope check (
    (account_id  is not null)::int + (location_id is not null)::int +
    (project_id  is not null)::int + (contact_id  is not null)::int = 1
  )
);
create index document_contact_idx on document (contact_id);
create index document_account_idx on document (account_id);
create index document_search_idx  on document
  using gin (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content_text,'')));

-- ------------------------------------------------------------------- activity

-- Role-aware logging. The same human gets logged against an account when they
-- are the manager and against a project when they are the candidate. as_role
-- records which hat they were wearing, so the timeline reads correctly without
-- forking the person into two records.
create table activity (
  id          uuid primary key default gen_random_uuid(),
  contact_id  uuid references contact(id),
  account_id  uuid references account(id),
  project_id  uuid references project(id),
  as_role     text check (as_role in ('manager','candidate')),
  kind        text not null default 'note'
              check (kind in ('note','call','email','meeting','interview','submission','text')),
  body        text not null,
  actor_id    uuid references app_user(id),
  occurred_at timestamptz not null default now()
);
create index activity_contact_idx on activity (contact_id, occurred_at desc);
create index activity_account_idx on activity (account_id, occurred_at desc);

-- ------------------------------------------------------------------ pipelines

-- A recruiter's own named shortlist, so they can pull people back up without
-- searching the whole system again.
create table pipeline (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references app_user(id),
  name       text not null,
  project_id uuid references project(id),
  notes      text,
  created_at timestamptz not null default now(),
  unique (owner_id, name)
);

create table pipeline_member (
  pipeline_id uuid not null references pipeline(id) on delete cascade,
  contact_id  uuid not null references contact(id) on delete cascade,
  note        text,
  added_at    timestamptz not null default now(),
  primary key (pipeline_id, contact_id)
);

-- ----------------------------------------------------- history & observability

-- Every update writes the previous version here first. This is what makes
-- "change data without deleting data" true rather than a claim.
create table record_revision (
  id          bigserial primary key,
  table_name  text not null,
  record_id   uuid not null,
  before      jsonb,
  after       jsonb,
  changed_by  uuid references app_user(id),
  changed_at  timestamptz not null default now()
);
create index record_revision_rec_idx on record_revision (table_name, record_id, changed_at desc);

-- Append-only business event log. The inspector reads this to show what the
-- system actually did, as opposed to what the UI says it did.
create table domain_event (
  id          bigserial primary key,
  kind        text not null,
  subject_type text,
  subject_id  uuid,
  payload     jsonb not null default '{}',
  actor_id    uuid references app_user(id),
  trace_id    text,
  occurred_at timestamptz not null default now()
);
create index domain_event_time_idx on domain_event (occurred_at desc);

-- Conversations with the assistant, and the full trace of every turn.
create table conversation (
  id         uuid primary key default gen_random_uuid(),
  title      text not null default 'New chat',
  user_id    uuid references app_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table chat_message (
  id              bigserial primary key,
  conversation_id uuid not null references conversation(id) on delete cascade,
  role            text not null check (role in ('user','assistant')),
  -- The full content block array as sent to / received from the API, so a
  -- conversation can be replayed exactly.
  content         jsonb not null,
  created_at      timestamptz not null default now()
);
create index chat_message_conv_idx on chat_message (conversation_id, id);

-- One row per assistant turn: every model call, tool call and SQL statement
-- that turn produced, with timings, tokens and cost.
create table trace (
  id              text primary key,
  conversation_id uuid references conversation(id) on delete cascade,
  prompt          text,
  steps           jsonb not null default '[]',
  input_tokens    int not null default 0,
  output_tokens   int not null default 0,
  cache_read_tokens   int not null default 0,
  cache_write_tokens  int not null default 0,
  cost_usd        numeric(12,6) not null default 0,
  duration_ms     int,
  model           text,
  error           text,
  started_at      timestamptz not null default now(),
  ended_at        timestamptz
);
create index trace_time_idx on trace (started_at desc);
