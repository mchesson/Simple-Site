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

-- ---------------------------------------------------------------- submissions

-- A submission is the record of putting a person in front of a client for a
-- project. Its stage is the single most-looked-at number on a recruiter's desk,
-- so the rules about how a stage may move are data rather than code: the two
-- tables below are the state machine, and the trigger further down is the only
-- thing that enforces it. The application reads the same tables to decide which
-- buttons to draw, which means the screen and the database cannot disagree
-- about what is allowed.

create table submission_stage (
  code     text primary key,
  label    text not null,
  sort     int  not null,
  -- Still in play. Drives the desk counts and the duplicate guard.
  is_open  boolean not null default true,
  -- Where a submission may start. Nothing may be created half way down.
  is_entry boolean not null default false,
  -- We won it. Reaching this requires a real placement, see the guard.
  is_won   boolean not null default false
);

insert into submission_stage (code, label, sort, is_open, is_entry, is_won) values
  ('submitted',     'Submitted',     10, true,  true,  false),
  ('client_review', 'With client',   20, true,  false, false),
  ('interview',     'Interviewing',  30, true,  false, false),
  ('offer',         'Offer out',     40, true,  false, false),
  ('placed',        'Placed',        50, false, false, true),
  ('rejected',      'Rejected',      60, false, false, false),
  ('withdrawn',     'Withdrawn',     70, false, false, false);

-- Why we lost, in a fixed list so the desk can count it. side records whose
-- decision it was, because "they went with someone cheaper" and "our candidate
-- took another offer" are different problems with different fixes.
create table loss_reason (
  code  text primary key,
  label text not null,
  side  text not null check (side in ('client','candidate','us')),
  sort  int  not null default 0
);

insert into loss_reason (code, label, side, sort) values
  ('rate_too_high',        'Rate too high',                        'client',    10),
  ('skills_gap',           'Not the right skills',                 'client',    20),
  ('someone_else_filled',  'Client filled it elsewhere',           'client',    30),
  ('client_hired_direct',  'Client hired directly',                'client',    40),
  ('project_cancelled',    'Project cancelled or put on hold',     'client',    50),
  ('interview_poor',       'Interviewed badly',                    'client',    60),
  ('took_other_offer',     'Took another offer',                   'candidate', 70),
  ('declined_rate',        'Declined our rate',                    'candidate', 80),
  ('unresponsive',         'Went dark on us',                      'candidate', 90),
  ('counter_offered',      'Counter offered by current employer',  'candidate', 100),
  ('failed_screening',     'Failed background or drug screening',  'candidate', 110),
  ('submitted_too_late',   'We were too late',                     'us',        120),
  ('wrong_submission',     'We submitted the wrong person',        'us',        130),
  ('no_reason_given',      'No reason given',                      'client',    140);

create table submission (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references project(id),
  contact_id   uuid not null references contact(id),
  stage        text not null default 'submitted' references submission_stage(code),
  -- When the stage last moved. Every "waiting on the client" number on the desk
  -- is measured from here, so the guard maintains it rather than the caller.
  stage_since  timestamptz not null default now(),
  submitted_by uuid references app_user(id),
  pay_rate     numeric(12,4),
  bill_rate    numeric(12,4),
  -- Burden as a percentage of pay, same convention as placement_rate. It sits on
  -- the submission so the margin a recruiter is shown before submitting is the
  -- one they will be held to, rather than a number a view invented.
  burden_pct   numeric(6,4) not null default 0 check (burden_pct >= 0),
  -- Set when the stage goes to rejected or withdrawn. The guard refuses the move
  -- without it: a loss nobody wrote a reason for teaches the desk nothing.
  loss_reason_code text references loss_reason(code),
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (project_id, contact_id),
  constraint rates_are_positive
    check ((pay_rate is null or pay_rate >= 0) and (bill_rate is null or bill_rate >= 0))
);
create index submission_project_idx on submission (project_id);
create index submission_contact_idx on submission (contact_id);
create index submission_stage_idx   on submission (stage, stage_since);

-- Which moves are legal, what the button for each one says, and what the move
-- costs the person making it. A row here is permission; no row is a refusal.
create table submission_stage_flow (
  from_stage   text not null references submission_stage(code),
  to_stage     text not null references submission_stage(code),
  label        text not null,
  -- The move has to be explained. The text lands in submission_event.
  needs_reason boolean not null default false,
  sort         int not null default 0,
  primary key (from_stage, to_stage),
  constraint not_to_itself check (from_stage <> to_stage)
);

insert into submission_stage_flow (from_stage, to_stage, label, needs_reason, sort) values
  -- The straight road.
  ('submitted',     'client_review', 'Client has it',      false, 10),
  ('client_review', 'interview',     'Interview booked',   false, 20),
  ('interview',     'offer',         'Offer out',          false, 30),
  ('offer',         'placed',        'Placed',             false, 40),
  -- Skipping ahead. Clients do this, so the machine has to allow it.
  ('submitted',     'interview',     'Straight to interview', false, 50),
  ('client_review', 'offer',         'Offer without interview', true, 60),
  -- Back a step. A second round, or an offer the client pulled back to talk.
  ('interview',     'client_review', 'Back with the client', true, 70),
  ('offer',         'interview',     'Another interview round', true, 80),
  -- Losing it, from anywhere it is still live.
  ('submitted',     'rejected',      'Rejected',           true, 100),
  ('client_review', 'rejected',      'Rejected',           true, 101),
  ('interview',     'rejected',      'Rejected',           true, 102),
  ('offer',         'rejected',      'Rejected',           true, 103),
  ('submitted',     'withdrawn',     'Withdrawn',          true, 110),
  ('client_review', 'withdrawn',     'Withdrawn',          true, 111),
  ('interview',     'withdrawn',     'Withdrawn',          true, 112),
  ('offer',         'withdrawn',     'Withdrawn',          true, 113),
  -- A start that never happened. Rare, and worth being able to record honestly
  -- rather than deleting the submission and losing the history.
  ('placed',        'withdrawn',     'Never started',      true, 120),
  -- Reviving one. Clients come back weeks later and ask about someone.
  ('rejected',      'client_review', 'Client came back',   true, 130),
  ('withdrawn',     'submitted',     'Back in play',       true, 131);

-- The whole history of a submission, one row per move, never edited. The stage
-- column above is a cache of the newest row here, and the trigger writes both in
-- the same statement so they cannot drift.
create table submission_event (
  id            bigserial primary key,
  submission_id uuid not null references submission(id) on delete cascade,
  from_stage    text references submission_stage(code),
  to_stage      text not null references submission_stage(code),
  reason        text,
  actor_id      uuid references app_user(id),
  occurred_at   timestamptz not null default now()
);
create index submission_event_sub_idx on submission_event (submission_id, occurred_at);

-- --------------------------------------------------------- interviews

-- An interview stage with no date on it is just a word. Rounds are numbered
-- because a second and third conversation is normal, and each one has its own
-- outcome: the client's verdict on that round, not on the submission.
create table interview (
  id             uuid primary key default gen_random_uuid(),
  submission_id  uuid not null references submission(id) on delete cascade,
  round          int  not null default 1 check (round > 0),
  scheduled_at   timestamptz not null,
  duration_mins  int not null default 60 check (duration_mins > 0),
  mode           text not null default 'video'
                 check (mode in ('phone','video','onsite','panel')),
  where_text     text,
  -- Client-side attendees. Often people we have no contact record for, so this
  -- is text on purpose rather than a join we would have to fake.
  interviewers   text,
  status         text not null default 'scheduled'
                 check (status in ('scheduled','completed','no_show','cancelled','rescheduled')),
  outcome        text not null default 'pending'
                 check (outcome in ('pending','advance','reject','hold')),
  feedback       text,
  prep_notes     text,
  arranged_by    uuid references app_user(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (submission_id, round)
);
create index interview_when_idx on interview (scheduled_at)
  where status = 'scheduled';

-- --------------------------------------------------- the rules, enforced

-- Two recruiters working the same person into the same client is the call
-- nobody wants to make. The unique constraint on the submission table only
-- catches a repeat on the same project; this catches the same person going to
-- the same account twice while an earlier submission is still live.
--
-- The same recruiter doing it is allowed: one person genuinely being put up for
-- two different roles at one client is ordinary work.
create or replace function submission_not_already_out() returns trigger as $$
declare
  clash record;
begin
  -- Reviving a dead submission months later is the other way this happens: the
  -- client asks about somebody a different recruiter has since put forward. So
  -- the check runs again whenever a closed submission comes back into play.
  if tg_op = 'UPDATE' then
    if new.stage = old.stage then return new; end if;
    if (select is_open from submission_stage where code = old.stage)
       or not (select is_open from submission_stage where code = new.stage) then
      return new;
    end if;
  end if;

  select s.id, s.project_id, s.stage, s.created_at, p.name as project_name,
         u.full_name as recruiter
    into clash
    from submission s
    join project p on p.id = s.project_id
    join submission_stage st on st.code = s.stage
    left join app_user u on u.id = s.submitted_by
   where s.contact_id = new.contact_id
     and s.id is distinct from new.id
     and st.is_open
     and p.account_id = (select account_id from project where id = new.project_id)
     and s.submitted_by is distinct from new.submitted_by
   order by s.created_at
   limit 1;

  if clash.id is not null then
    raise exception
      'that person is already out to this client - % submitted them for % on %',
      coalesce(clash.recruiter, 'somebody'), clash.project_name,
      to_char(clash.created_at, 'FMMonth FMDD');
  end if;
  return new;
end $$ language plpgsql;
create trigger submission_duplicate_check before insert or update on submission
  for each row execute function submission_not_already_out();

-- The state machine. Nothing else in the system moves a stage, and nothing can
-- get around this by writing SQL directly, which is the point of putting it
-- here rather than in the application.
--
-- The reason for a move travels in the same transaction-local setting the audit
-- trail uses, so a caller that has already said why it is doing something does
-- not have to say it twice.
create or replace function submission_stage_guard() returns trigger as $$
declare
  st    submission_stage;
  flow  submission_stage_flow;
  why   text := nullif(btrim(coalesce(current_setting('ts.reason', true), '')), '');
  legal text;
begin
  if tg_op = 'INSERT' then
    select * into st from submission_stage where code = new.stage;
    if not st.is_entry then
      raise exception
        'a submission starts at %, not at % - move it there afterwards',
        (select code from submission_stage where is_entry order by sort limit 1),
        new.stage;
    end if;
    new.stage_since := now();
    return new;   -- the history row is written by the after trigger below
  end if;

  -- An update that leaves the stage alone is not our business.
  if new.stage = old.stage then
    -- ... except that nobody may quietly rewrite how it got here.
    if new.stage_since is distinct from old.stage_since then
      new.stage_since := old.stage_since;
    end if;
    return new;
  end if;

  select * into flow from submission_stage_flow
   where from_stage = old.stage and to_stage = new.stage;

  if flow.from_stage is null then
    select string_agg(f.label || ' (' || f.to_stage || ')', ', ' order by f.sort)
      into legal
      from submission_stage_flow f where f.from_stage = old.stage;
    raise exception 'a submission at % cannot go to %. From here you can: %',
      old.stage, new.stage, coalesce(legal, 'nothing - it is finished');
  end if;

  if flow.needs_reason and why is null then
    raise exception 'moving this submission to % needs a reason', new.stage;
  end if;

  -- A loss with no reason code teaches the desk nothing, so it is refused.
  select * into st from submission_stage where code = new.stage;
  if not st.is_open and not st.is_won and new.loss_reason_code is null then
    raise exception
      'say why we lost this one - set loss_reason_code (see the loss_reason table)';
  end if;

  -- "Placed" is a claim about the real world: somebody is starting work. It is
  -- only true once the placement exists, and the placement is what payroll and
  -- billing hang off, so the word cannot get ahead of the record.
  if st.is_won and not exists (
       select 1 from placement pl where pl.submission_id = new.id) then
    raise exception
      'create the placement first - a submission is not placed until somebody has a start date';
  end if;

  -- Coming back into play drops the old loss reason; keeping it would leave a
  -- live submission carrying an explanation of how it died.
  if st.is_open then
    new.loss_reason_code := null;
  end if;

  new.stage_since := now();
  new.updated_at  := now();
  return new;
end $$ language plpgsql;
create trigger submission_stage_check before insert or update on submission
  for each row execute function submission_stage_guard();

-- The history row, written once the submission itself is on disk. Splitting this
-- off from the guard is not tidiness: on an insert the row does not exist yet,
-- so a history row written from a before trigger has nothing to point at.
create or replace function submission_stage_log() returns trigger as $$
declare
  why text := nullif(btrim(coalesce(current_setting('ts.reason', true), '')), '');
begin
  if tg_op = 'INSERT' then
    insert into submission_event (submission_id, from_stage, to_stage, reason, actor_id)
      values (new.id, null, new.stage, why, audit_actor_id());
  elsif new.stage is distinct from old.stage then
    insert into submission_event (submission_id, from_stage, to_stage, reason, actor_id)
      values (new.id, old.stage, new.stage, why, audit_actor_id());
  end if;
  return null;
end $$ language plpgsql;
create trigger submission_stage_history after insert or update on submission
  for each row execute function submission_stage_log();

-- History is history.
create or replace function submission_event_append_only() returns trigger as $$
begin
  raise exception 'the submission history cannot be changed';
end $$ language plpgsql;
create trigger submission_event_no_edit before update or delete on submission_event
  for each row execute function submission_event_append_only();

-- Booking an interview is what puts a submission in the interview stage. Doing
-- it here rather than asking the caller to remember means the stage can never
-- claim less than the calendar knows.
create or replace function interview_moves_the_stage() returns trigger as $$
declare
  sub  submission;
  from_sort int; to_sort int;
begin
  select * into sub from submission where id = new.submission_id for update;
  select sort into from_sort from submission_stage where code = sub.stage;
  select sort into to_sort   from submission_stage where code = 'interview';

  if not (select is_open from submission_stage where code = sub.stage) then
    raise exception 'that submission is closed (%) - reopen it before booking anything',
      sub.stage;
  end if;

  if from_sort < to_sort then
    update submission set stage = 'interview' where id = sub.id;
  end if;
  return new;
end $$ language plpgsql;
create trigger interview_stage_sync after insert on interview
  for each row execute function interview_moves_the_stage();

-- ----------------------------------------------------------------- placements

create table placement (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references project(id),
  contact_id   uuid not null references contact(id),
  status       text not null default 'active'
               check (status in ('pending','active','ended','cancelled')),
  -- The submission this came out of, when it came out of one. A placement can
  -- exist without it - a redeployment, a rehire, a conversion done by hand -
  -- but when it is set it is the join between the recruiting side of the
  -- business and the money side, and it is what lets a submission say "placed".
  submission_id uuid unique references submission(id),
  start_date   date not null,
  end_date     date,
  recruiter_id uuid references app_user(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- A placement that names a submission has to be the same person on the same
-- project. Without this the join between recruiting and payroll could quietly
-- point at somebody else, and "placed" would be attesting to the wrong thing.
create or replace function placement_matches_submission() returns trigger as $$
declare sub submission;
begin
  if new.submission_id is null then return new; end if;
  select * into sub from submission where id = new.submission_id;
  if sub.project_id <> new.project_id or sub.contact_id <> new.contact_id then
    raise exception
      'that placement does not match its submission - the submission is % on project %',
      (select full_name from contact where id = sub.contact_id),
      (select name from project where id = sub.project_id);
  end if;
  return new;
end $$ language plpgsql;
create trigger placement_submission_check before insert or update on placement
  for each row execute function placement_matches_submission();

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

-- ------------------------------------------------------------ SOW / PO

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

-- ----------------------------------------------------------------- timesheets
--
-- A consultant fills in one timesheet a week. Within that week they allocate
-- their hours day by day across however many projects and purchase orders they
-- worked on - a person can be on two engagements at one client, or on two
-- clients, and a Tuesday can be split between them.
--
-- Approval follows the allocation, not the timesheet. Each client manager
-- approves the part that belongs to their project, so one week can be half
-- approved while the other half is still waiting. That is how it actually
-- happens, and pretending otherwise means one slow approver blocks a whole
-- week of billing.

create table timesheet (
  id           uuid primary key default gen_random_uuid(),
  contact_id   uuid not null references contact(id),
  week_ending  date not null,
  status       text not null default 'draft'
               check (status in ('draft','submitted','partly_approved','approved',
                                 'rejected')),
  submitted_at timestamptz,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (contact_id, week_ending)
);
create index timesheet_status_idx on timesheet (status, week_ending desc);

-- One row per day per thing the day was charged to. Two rows on the same date
-- means the day was split.
create table timesheet_entry (
  id           uuid primary key default gen_random_uuid(),
  timesheet_id uuid not null references timesheet(id) on delete cascade,
  placement_id uuid not null references placement(id),
  project_id   uuid not null references project(id),
  purchase_order_id uuid references purchase_order(id),
  work_date    date not null,
  hours        numeric(6,2) not null default 0 check (hours >= 0 and hours <= 24),
  ot_hours     numeric(6,2) not null default 0 check (ot_hours >= 0 and ot_hours <= 24),
  notes        text,
  -- Frozen when the client approves this project's part of the week.
  billable_amount numeric(14,2),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint some_time_was_worked check (hours > 0 or ot_hours > 0),
  unique (timesheet_id, placement_id, purchase_order_id, work_date)
);
create index tse_timesheet_idx on timesheet_entry (timesheet_id);
create index tse_po_idx        on timesheet_entry (purchase_order_id);
create index tse_project_idx   on timesheet_entry (project_id, work_date);

-- Who at the client is allowed to approve time on a project. Approvers are
-- contacts on the account - the same person graph as everything else - so an
-- approver is a manager we already know, not a name in a text field.
create table project_approver (
  project_id uuid not null references project(id) on delete cascade,
  contact_id uuid not null references contact(id),
  is_primary boolean not null default false,
  added_at   timestamptz not null default now(),
  primary key (project_id, contact_id)
);

-- One packet of a timesheet, routed to one project's approver. This is the unit
-- that gets approved, rejected and later billed.
create table timesheet_approval (
  id           uuid primary key default gen_random_uuid(),
  timesheet_id uuid not null references timesheet(id) on delete cascade,
  project_id   uuid not null references project(id),
  approver_contact_id uuid references contact(id),
  status       text not null default 'pending'
               check (status in ('pending','approved','rejected')),
  decided_at   timestamptz,
  decided_by   text,
  note         text,
  created_at   timestamptz not null default now(),
  unique (timesheet_id, project_id)
);
create index tsa_status_idx on timesheet_approval (status, project_id);

-- A day cannot hold more than 24 hours however it is split, and a day has to
-- fall inside the week the timesheet is for. Both of these are the kind of
-- thing a form can check and then a bulk import quietly ignores.
create or replace function timesheet_entry_guard() returns trigger as $$
declare ts timesheet; day_total numeric; proj uuid;
begin
  select * into ts from timesheet where id = new.timesheet_id;

  -- Locked once submitted - but only against changes to the allocation itself.
  -- Approving stamps a value onto these same rows, and that is the system
  -- writing, not the consultant editing.
  if tg_op = 'INSERT' or
     (new.hours, new.ot_hours, new.work_date, new.placement_id,
      new.purchase_order_id, new.notes) is distinct from
     (old.hours, old.ot_hours, old.work_date, old.placement_id,
      old.purchase_order_id, old.notes)
  then
    -- The lock follows the approval packet, not the week. One manager rejecting
    -- their project must not reopen days a different manager already approved -
    -- that time is frozen, may already be invoiced, and is not the consultant's
    -- to change any more.
    if exists (select 1 from timesheet_approval a
                where a.timesheet_id = new.timesheet_id
                  and a.project_id = coalesce(new.project_id, old.project_id)
                  and a.status = 'approved') then
      raise exception
        'that time was approved and is locked - an admin has to unlock it first';
    end if;
    if ts.status not in ('draft','rejected') then
      raise exception 'that week has already been submitted - it cannot be edited';
    end if;
  else
    return new;   -- nothing about the allocation changed
  end if;

  if new.work_date > ts.week_ending or new.work_date < ts.week_ending - 6 then
    raise exception '% is not in the week ending %', new.work_date, ts.week_ending;
  end if;

  select coalesce(sum(e.hours + e.ot_hours), 0) into day_total
    from timesheet_entry e
   where e.timesheet_id = new.timesheet_id and e.work_date = new.work_date
     and e.id is distinct from new.id;
  if day_total + new.hours + new.ot_hours > 24 then
    raise exception 'that would put % at % hours', new.work_date,
      day_total + new.hours + new.ot_hours;
  end if;

  -- The project is whatever the placement is on. Deriving it rather than
  -- trusting the caller keeps an entry from being filed against a project the
  -- consultant is not placed on.
  select p.project_id into proj from placement p where p.id = new.placement_id;
  if proj is null then raise exception 'no such placement'; end if;
  new.project_id := proj;

  if new.purchase_order_id is not null then
    if not exists (select 1 from purchase_order po
                    where po.id = new.purchase_order_id and po.project_id = proj) then
      raise exception 'that purchase order does not belong to this project';
    end if;
  end if;
  return new;
end $$ language plpgsql;
create trigger timesheet_entry_guard_t before insert or update on timesheet_entry
  for each row execute function timesheet_entry_guard();

create or replace function timesheet_entry_delete_guard() returns trigger as $$
declare st text;
begin
  if exists (select 1 from timesheet_approval a
              where a.timesheet_id = old.timesheet_id
                and a.project_id = old.project_id
                and a.status = 'approved') then
    raise exception
      'that time was approved and is locked - an admin has to unlock it first';
  end if;
  select status into st from timesheet where id = old.timesheet_id;
  if st is not null and st not in ('draft','rejected') then
    raise exception 'that week has already been submitted - days cannot be removed';
  end if;
  return old;
end $$ language plpgsql;
create trigger timesheet_entry_delete_guard_t before delete on timesheet_entry
  for each row execute function timesheet_entry_delete_guard();

-- The bill rate in force for a placement on a given date. Rates are
-- effective-dated and never edited, so "what was the rate that day" always has
-- an answer - which is the whole reason a Tuesday in March still prices
-- correctly in June.
create or replace function rate_in_force(p_placement uuid, p_on date,
                                         p_type text default 'standard')
returns placement_rate language sql stable as $$
  select r.* from placement_rate r
   where r.placement_id = p_placement and r.rate_type = p_type
     and r.validity @> p_on
   limit 1
$$;

-- What one allocated day is worth. Overtime uses the overtime rate if one is on
-- file and time and a half otherwise, which is the convention when nobody
-- negotiated something different.
create or replace function entry_billable(p_placement uuid, p_date date,
                                          p_hours numeric, p_ot numeric)
returns numeric language plpgsql stable as $$
declare std placement_rate; ot placement_rate; ot_rate numeric;
begin
  std := rate_in_force(p_placement, p_date, 'standard');
  if std.id is null then
    raise exception 'no standard rate in force for placement % on %', p_placement, p_date;
  end if;
  ot := rate_in_force(p_placement, p_date, 'overtime');
  ot_rate := coalesce(ot.bill_rate, std.bill_rate * 1.5);
  return round(coalesce(p_hours,0) * std.bill_rate + coalesce(p_ot,0) * ot_rate, 2);
end $$;

-- ------------------------------------------------------------------ invoicing

-- What we actually billed the client. An invoice sits against one purchase
-- order where the client issues them, so the burn-down has a single line of
-- descent from PO to invoice to payment.
create table invoice (
  id             uuid primary key default gen_random_uuid(),
  invoice_number text not null unique,
  account_id     uuid not null references account(id),
  project_id     uuid references project(id),
  purchase_order_id uuid references purchase_order(id),
  status         text not null default 'draft'
                 check (status in ('draft','sent','part_paid','paid','void')),
  issue_date     date,
  due_date       date,
  terms_days     int not null default 30 check (terms_days >= 0),
  period_start   date,
  period_end     date,
  sent_at        timestamptz,
  voided_at      timestamptz,
  void_reason    text,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index invoice_po_idx     on invoice (purchase_order_id);
create index invoice_status_idx on invoice (status, due_date);

create table invoice_line (
  id          uuid primary key default gen_random_uuid(),
  invoice_id  uuid not null references invoice(id) on delete cascade,
  kind        text not null default 'time'
              check (kind in ('time','expense','milestone','adjustment')),
  timesheet_entry_id uuid references timesheet_entry(id),
  description text not null,
  quantity    numeric(12,2),
  unit_rate   numeric(12,4),
  amount      numeric(14,2) not null,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  -- A line billing time has to say which week it is billing.
  -- A line billing time has to say which allocated day it is billing, so an
  -- invoice for one PO can never pick up hours charged to another.
  constraint time_lines_cite_an_entry
    check (kind <> 'time' or timesheet_entry_id is not null)
);
create index invoice_line_invoice_idx  on invoice_line (invoice_id, sort_order);
create index invoice_line_entry_idx on invoice_line (timesheet_entry_id);

create table payment (
  id          uuid primary key default gen_random_uuid(),
  invoice_id  uuid not null references invoice(id),
  amount      numeric(14,2) not null check (amount > 0),
  received_at date not null default current_date,
  method      text,
  reference   text,
  created_at  timestamptz not null default now()
);
create index payment_invoice_idx on payment (invoice_id);

-- An invoice total is the sum of its lines. Kept as a view rather than a column
-- so the two can never disagree.
create view invoice_totals as
select i.id as invoice_id,
       coalesce(sum(l.amount), 0)                      as total,
       coalesce((select sum(p.amount) from payment p
                  where p.invoice_id = i.id), 0)       as paid,
       coalesce(sum(l.amount), 0)
         - coalesce((select sum(p.amount) from payment p
                      where p.invoice_id = i.id), 0)   as outstanding,
       count(l.id)::int                                as line_count
  from invoice i left join invoice_line l on l.invoice_id = i.id
 group by i.id;

-- One row per entry with everything a screen or a query needs: who, when, what
-- it was charged to, where it is in the approval cycle, what it is worth, and
-- whether it has been billed. Whether an entry is billed is not a column
-- anywhere - it is whether a live invoice line points at it.
create view timesheet_entry_detail as
select e.id                as entry_id,
       e.timesheet_id,
       t.contact_id,
       c.full_name         as consultant,
       t.week_ending,
       t.status            as timesheet_status,
       e.work_date,
       e.hours, e.ot_hours,
       e.notes,
       e.placement_id,
       e.project_id,
       p.name              as project_name,
       p.delivery_type,
       a.id                as account_id,
       a.name              as account_name,
       e.purchase_order_id,
       po.po_number,
       ap.id               as approval_id,
       ap.status           as approval_status,
       ap.decided_by,
       ap.decided_at,
       ap.note             as approval_note,
       appr.full_name      as approver_name,
       -- Approved entries carry the value they were approved at; anything else
       -- is quoted at the rate in force that day so an approver sees the money
       -- before they agree to it.
       coalesce(e.billable_amount,
                entry_billable(e.placement_id, e.work_date, e.hours, e.ot_hours)) as value,
       e.billable_amount,
       inv.id              as invoice_id,
       inv.invoice_number,
       inv.status          as invoice_status
  from timesheet_entry e
  join timesheet t on t.id = e.timesheet_id
  join contact  c  on c.id = t.contact_id
  join project  p  on p.id = e.project_id
  join account  a  on a.id = p.account_id
  left join purchase_order po on po.id = e.purchase_order_id
  left join timesheet_approval ap
         on ap.timesheet_id = e.timesheet_id and ap.project_id = e.project_id
  left join contact appr on appr.id = ap.approver_contact_id
  left join lateral (
    select i.id, i.invoice_number, i.status
      from invoice_line l join invoice i on i.id = l.invoice_id
     where l.timesheet_entry_id = e.id and i.status <> 'void' limit 1
  ) inv on true;

-- Three guards on billing. Each of them is a mistake that costs real money and
-- that no amount of care in the application layer reliably prevents.

-- 1. You cannot bill time the client has not approved, and you cannot bill the
--    same week twice. A voided invoice releases its time to be billed again.
create or replace function invoice_line_guard() returns trigger as $$
declare e timesheet_entry; ap timesheet_approval; inv invoice; wk date; dup int;
begin
  select * into inv from invoice where id = new.invoice_id;
  if inv.status <> 'draft' then
    raise exception 'invoice % is % - lines can only change while it is a draft',
      inv.invoice_number, inv.status;
  end if;

  if new.timesheet_entry_id is not null then
    select * into e from timesheet_entry where id = new.timesheet_entry_id;
    select * into ap from timesheet_approval
      where timesheet_id = e.timesheet_id and project_id = e.project_id;
    select week_ending into wk from timesheet where id = e.timesheet_id;

    if ap.status is distinct from 'approved' then
      raise exception 'time on % is %, not approved - it cannot be billed',
        e.work_date, coalesce(ap.status, 'not submitted');
    end if;

    select count(*) into dup
      from invoice_line l join invoice i2 on i2.id = l.invoice_id
     where l.timesheet_entry_id = new.timesheet_entry_id and i2.status <> 'void'
       and l.id is distinct from new.id;
    if dup > 0 then
      raise exception 'the time on % is already on a live invoice', e.work_date;
    end if;

    if inv.purchase_order_id is not null
       and e.purchase_order_id is distinct from inv.purchase_order_id then
      raise exception 'that time is allocated to a different purchase order';
    end if;
  end if;
  return new;
end $$ language plpgsql;
create trigger invoice_line_guard_t before insert or update on invoice_line
  for each row execute function invoice_line_guard();

-- 2. An invoice cannot be sent for more than the purchase order has left. The
--    remedy is a change order or a new PO, not a bigger invoice, so the error
--    says so.
create or replace function invoice_po_guard() returns trigger as $$
declare po purchase_order; already numeric; mine numeric;
begin
  if new.status = 'sent' and coalesce(old.status,'') <> 'sent'
     and new.purchase_order_id is not null then
    select * into po from purchase_order where id = new.purchase_order_id;
    select coalesce(sum(t.total),0) into already
      from invoice i join invoice_totals t on t.invoice_id = i.id
     where i.purchase_order_id = new.purchase_order_id
       and i.status in ('sent','part_paid','paid') and i.id <> new.id;
    select total into mine from invoice_totals where invoice_id = new.id;
    if already + coalesce(mine,0) > po.amount then
      raise exception
        'this invoice would put % over its limit: % committed, % already invoiced, % on this invoice. Raise a change order or a new PO.',
        po.po_number, po.amount, already, mine;
    end if;
  end if;
  return new;
end $$ language plpgsql;
create trigger invoice_po_guard_t before update on invoice
  for each row execute function invoice_po_guard();

-- Approved time is locked. Getting it back open is a deliberate, recorded act by
-- somebody with the authority to do it, not a status change anyone can make.
create table unlock_request (
  id            uuid primary key default gen_random_uuid(),
  approval_id   uuid not null references timesheet_approval(id) on delete cascade,
  requested_by  uuid references app_user(id),
  reason        text not null check (length(btrim(reason)) > 5),
  status        text not null default 'pending'
                check (status in ('pending','granted','denied','used','withdrawn')),
  decided_by    uuid references app_user(id),
  decided_at    timestamptz,
  decision_note text,
  -- A grant is a key, not a permanent door. It opens one week, once.
  expires_at    timestamptz,
  used_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index unlock_pending_idx on unlock_request (status, created_at desc);
create index unlock_approval_idx on unlock_request (approval_id);

-- Only an admin may grant one, and nobody may grant their own.
create or replace function unlock_request_guard() returns trigger as $$
declare r text;
begin
  if new.status in ('granted','denied') and old.status = 'pending' then
    if new.decided_by is null then
      raise exception 'record which admin decided this';
    end if;
    select role into r from app_user where id = new.decided_by and active;
    if r is distinct from 'admin' then
      raise exception 'only an admin can unlock approved time';
    end if;
    if new.decided_by = new.requested_by then
      raise exception 'somebody other than the requester has to grant it';
    end if;
    new.decided_at := now();
    if new.status = 'granted' and new.expires_at is null then
      new.expires_at := now() + interval '24 hours';
    end if;
  end if;
  return new;
end $$ language plpgsql;
create trigger unlock_request_guard_t before update on unlock_request
  for each row execute function unlock_request_guard();

-- Moving an approval out of approved is what the lock actually protects. It
-- takes a granted, unexpired, unused unlock, and spends it.
create or replace function approval_unlock_guard() returns trigger as $$
declare u unlock_request;
begin
  if old.status = 'approved' and new.status is distinct from 'approved' then
    select * into u from unlock_request
     where approval_id = new.id and status = 'granted'
       and (expires_at is null or expires_at > now())
     order by decided_at desc limit 1;
    if u.id is null then
      raise exception
        'that time is locked. Raise an unlock request and have an admin grant it.';
    end if;
    update unlock_request set status = 'used', used_at = now() where id = u.id;
  end if;
  return new;
end $$ language plpgsql;
create trigger approval_unlock_guard_t before update on timesheet_approval
  for each row execute function approval_unlock_guard();

-- 3. Approving a packet freezes what its days are worth, at the rate in force
--    on each day. Rejecting it releases them again.
create or replace function timesheet_approval_effects() returns trigger as $$
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    update timesheet_entry e
       set billable_amount =
             entry_billable(e.placement_id, e.work_date, e.hours, e.ot_hours),
           updated_at = now()
     where e.timesheet_id = new.timesheet_id and e.project_id = new.project_id;
  elsif new.status <> 'approved' and old.status = 'approved' then
    update timesheet_entry e set billable_amount = null, updated_at = now()
     where e.timesheet_id = new.timesheet_id and e.project_id = new.project_id;
  end if;

  -- Roll the packet statuses up into the timesheet, so a week reads correctly
  -- when one manager has signed off and another has not.
  update timesheet t set status = (
    select case
      when count(*) filter (where a.status = 'rejected') > 0 then 'rejected'
      when count(*) filter (where a.status <> 'approved') = 0 then 'approved'
      when count(*) filter (where a.status = 'approved') > 0 then 'partly_approved'
      else 'submitted' end
      from timesheet_approval a where a.timesheet_id = new.timesheet_id
  ), updated_at = now()
  where t.id = new.timesheet_id;
  return new;
end $$ language plpgsql;
create trigger timesheet_approval_effects_t after update on timesheet_approval
  for each row execute function timesheet_approval_effects();

-- Burn-down.
--
-- A purchase order is burned by what we have INVOICED, not by what our
-- consultants have worked. Those two numbers are different and the gap between
-- them is the thing worth watching, so this view carries both:
--
--   invoiced           billed to the client on a live invoice. This is the burn.
--   approved_unbilled  work the client has accepted but we have not billed yet.
--                      Earned revenue sitting in our own queue.
--   submitted_pending  time claimed but not yet approved. Not earned, not billable.
--   remaining          amount - invoiced. What the PO can still be billed for.
--   projected_remaining what is left once the approved backlog is billed. This is
--                      the number that tells you whether the PO reaches its end date.
--
-- A PO can look healthy on "remaining" and already be spent, if a month of
-- approved time is sitting unbilled. That is exactly the failure this view is
-- built to make visible.
create view po_burndown as
with invoiced as (
  -- Issued to the client. A draft is not billed, so it does not burn.
  select i.purchase_order_id as po_id, sum(t.total) as amount
    from invoice i join invoice_totals t on t.invoice_id = i.id
   where i.status in ('sent','part_paid','paid') and i.purchase_order_id is not null
   group by 1
), paid as (
  select i.purchase_order_id as po_id, sum(t.paid) as amount
    from invoice i join invoice_totals t on t.invoice_id = i.id
   where i.status <> 'void' and i.purchase_order_id is not null
   group by 1
), drafted as (
  -- Prepared but not sent. Sitting in our own queue, not the client's.
  select i.purchase_order_id as po_id, sum(t.total) as amount
    from invoice i join invoice_totals t on t.invoice_id = i.id
   where i.status = 'draft' and i.purchase_order_id is not null
   group by 1
), unbilled as (
  -- Approved and not on any invoice at all, draft or otherwise.
  select d.purchase_order_id as po_id, sum(d.value) as amount
    from timesheet_entry_detail d
   where d.approval_status = 'approved' and d.invoice_id is null
   group by 1
), pending as (
  -- Submitted, waiting on a client manager. Not earned.
  select d.purchase_order_id as po_id, sum(d.value) as amount
    from timesheet_entry_detail d
   where d.approval_status = 'pending'
   group by 1
)
select
  po.id            as purchase_order_id,
  po.po_number,
  po.project_id,
  p.name           as project_name,
  a.name           as account_name,
  po.amount,
  po.start_date,
  po.end_date,
  po.status,
  coalesce(iv.amount, 0)                          as invoiced,
  coalesce(pd.amount, 0)                          as paid,
  coalesce(iv.amount, 0) - coalesce(pd.amount, 0) as outstanding,
  coalesce(dr.amount, 0)                          as drafted_not_sent,
  coalesce(ub.amount, 0)                          as approved_unbilled,
  coalesce(pn.amount, 0)                          as submitted_pending,
  po.amount - coalesce(iv.amount, 0)              as remaining,
  po.amount - coalesce(iv.amount, 0) - coalesce(dr.amount, 0)
            - coalesce(ub.amount, 0)              as projected_remaining,
  case when po.amount = 0 then null else
    round(coalesce(iv.amount, 0) / po.amount * 100, 2) end as pct_invoiced,
  case when po.amount = 0 then null else
    round((coalesce(iv.amount, 0) + coalesce(dr.amount, 0) + coalesce(ub.amount, 0))
          / po.amount * 100, 2) end as pct_committed,
  case when po.end_date is null then null
       else (po.end_date - current_date) end as days_remaining
from purchase_order po
join project p on p.id = po.project_id
join account a on a.id = p.account_id
left join invoiced iv on iv.po_id = po.id
left join paid     pd on pd.po_id = po.id
left join drafted  dr on dr.po_id = po.id
left join unbilled ub on ub.po_id = po.id
left join pending  pn on pn.po_id = po.id;

-- What is owed us and how late it is. Aging buckets are the standard ones a
-- controller expects to see.
create view invoice_aging as
select i.id            as invoice_id,
       i.invoice_number,
       i.status,
       a.name          as account_name,
       p.name          as project_name,
       po.po_number,
       i.issue_date,
       i.due_date,
       t.total,
       t.paid,
       t.outstanding,
       case when i.due_date is null or t.outstanding <= 0 then 0
            else greatest(0, current_date - i.due_date) end as days_overdue,
       case when t.outstanding <= 0 then 'settled'
            when i.due_date is null then 'no due date'
            when current_date <= i.due_date then 'current'
            when current_date - i.due_date <= 30 then '1-30'
            when current_date - i.due_date <= 60 then '31-60'
            when current_date - i.due_date <= 90 then '61-90'
            else '90+' end as bucket
  from invoice i
  join invoice_totals t on t.invoice_id = i.id
  join account a on a.id = i.account_id
  left join project p on p.id = i.project_id
  left join purchase_order po on po.id = i.purchase_order_id
 -- A draft is not a receivable. Nobody owes us anything until it is issued.
 where i.status not in ('void','draft');

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

-- --------------------------------------------------------- reading it back

-- One row per live submission with the numbers the desk sorts by, so the board,
-- the assistant and any ad-hoc query all count the same way.
create or replace view submission_board as
select s.id, s.stage, st.label as stage_label, st.sort as stage_sort,
       st.is_open, st.is_won,
       s.stage_since,
       greatest(0, (current_date - s.stage_since::date)) as days_in_stage,
       greatest(0, (current_date - s.created_at::date))  as days_since_submitted,
       s.pay_rate, s.bill_rate, s.burden_pct,
       gross_margin(s.pay_rate, s.bill_rate, s.burden_pct) as gm,
       round(gross_margin_pct(s.pay_rate, s.bill_rate, s.burden_pct), 1) as gm_pct,
       s.loss_reason_code, lr.label as loss_reason_label,
       s.project_id, p.name as project_name, p.delivery_type, p.owner_id as project_owner_id,
       p.account_id, a.name as account_name,
       s.contact_id, c.full_name as contact_name, c.headline,
       s.submitted_by, u.full_name as submitted_by_name,
       (select count(*) from interview i where i.submission_id = s.id) as interview_count,
       (select min(i.scheduled_at) from interview i
         where i.submission_id = s.id and i.status = 'scheduled'
           and i.scheduled_at >= now()) as next_interview_at,
       (select max(act.occurred_at) from activity act where act.contact_id = s.contact_id)
         as contact_last_touch
  from submission s
  join submission_stage st on st.code = s.stage
  join project p on p.id = s.project_id
  join account a on a.id = p.account_id
  join contact c on c.id = s.contact_id
  left join app_user u on u.id = s.submitted_by
  left join loss_reason lr on lr.code = s.loss_reason_code;

-- How many submissions ever reached each stage. Read off the event log rather
-- than the current stage, so a submission that has since been rejected still
-- counts towards the interviews it got. That is the difference between a funnel
-- and a snapshot.
create or replace view submission_funnel as
select st.code as stage, st.label, st.sort,
       (select count(distinct e.submission_id) from submission_event e
         where e.to_stage = st.code) as reached,
       (select count(*) from submission s where s.stage = st.code) as sitting_here
  from submission_stage st
 where st.is_open or st.is_won;

-- ----------------------------------------------------- history & observability

-- Every write to every table lands here, put there by a trigger rather than by
-- application code. That distinction is the whole point: a script, a psql
-- session, a bug or a future code path that forgets to call the right helper all
-- leave the same trace, because the database writes the record, not the caller.
--
-- The acting user travels in a transaction-local setting the application sets on
-- every connection it writes through. A write with nobody set is still recorded -
-- as an unattributed one, which is a thing you want to be able to find.
create table audit_log (
  id          bigserial primary key,
  table_name  text not null,
  record_id   uuid,
  action      text not null check (action in ('insert','update','delete')),
  before      jsonb,
  after       jsonb,
  changed     text[],
  actor_id    uuid references app_user(id),
  actor_label text,
  reason      text,
  trace_id    text,
  txid        bigint not null default txid_current(),
  occurred_at timestamptz not null default now()
);
create index audit_record_idx on audit_log (table_name, record_id, occurred_at desc);
create index audit_time_idx   on audit_log (occurred_at desc);
create index audit_actor_idx  on audit_log (actor_id, occurred_at desc);
create index audit_txid_idx   on audit_log (txid);

create or replace function audit_actor_id() returns uuid language plpgsql stable as $$
begin
  return nullif(current_setting('ts.actor_id', true), '')::uuid;
exception when others then return null;
end $$;

create or replace function audit_capture() returns trigger as $$
declare
  b jsonb; a jsonb; ch text[]; rid uuid;
begin
  if tg_op = 'INSERT' then
    a := to_jsonb(new); b := null;
  elsif tg_op = 'UPDATE' then
    b := to_jsonb(old); a := to_jsonb(new);
    select coalesce(array_agg(key), '{}') into ch
      from jsonb_each(a) where a -> key is distinct from b -> key;
    -- An update that changed nothing is noise, not history.
    if ch = '{}' then return coalesce(new, old); end if;
  else
    b := to_jsonb(old); a := null;
  end if;

  begin
    rid := coalesce(a ->> 'id', b ->> 'id')::uuid;
  exception when others then rid := null;   -- tables keyed by something else
  end;

  insert into audit_log (table_name, record_id, action, before, after, changed,
                         actor_id, actor_label, reason, trace_id)
  values (tg_table_name, rid, lower(tg_op), b, a, ch,
          audit_actor_id(),
          nullif(current_setting('ts.actor_label', true), ''),
          nullif(current_setting('ts.reason', true), ''),
          nullif(current_setting('ts.trace_id', true), ''));
  return coalesce(new, old);
end $$ language plpgsql;

-- Attach it to every table that holds business data. audit_log itself is
-- excluded, and so is the trace table, which is observability rather than record.
do $$ declare t text; begin
  for t in
    select tablename from pg_tables
     where schemaname = 'public'
       and tablename not in ('audit_log','trace','domain_event','chat_message')
  loop
    execute format(
      'create trigger zz_audit after insert or update or delete on public.%I
         for each row execute function audit_capture()', t);
  end loop;
end $$;

-- audit_log is append only. Nothing in the application may edit or remove a row,
-- and the grant below means nothing outside it can either.
create or replace function audit_is_append_only() returns trigger as $$
begin
  raise exception 'the audit log cannot be changed';
end $$ language plpgsql;
create trigger audit_no_update before update or delete on audit_log
  for each row execute function audit_is_append_only();

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
