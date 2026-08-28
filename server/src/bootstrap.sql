-- One-time setup, run as a superuser. Creates the two roles the app uses and
-- hands ownership of the schema to the application role so migrations and
-- resets do not need superuser afterwards.
--
--   psql -d ts_workspace -f src/bootstrap.sql
--
-- The passwords here are development defaults. Change them, and set
-- DATABASE_URL / DATABASE_URL_RO to match, before this is reachable by anyone.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'ts_app') then
    create role ts_app login password 'ts_app_dev';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'ts_readonly') then
    create role ts_readonly login password 'ts_readonly_dev';
  end if;
end $$;

-- Grants naming a database cannot be written literally without pinning the
-- database name, so they go through dynamic SQL and work wherever this is run.
do $$ begin
  execute format('grant connect on database %I to ts_app, ts_readonly',
                 current_database());
  -- ts_app owns its schema, so migrations and resets do not need a superuser.
  execute format('grant create on database %I to ts_app', current_database());
end $$;
alter schema public owner to ts_app;
grant usage on schema public to ts_readonly;

-- The assistant's query tool gets SELECT and nothing else. This grant is the
-- reason a generated statement cannot damage anything: it is refused by the
-- database, not by a pattern match on the SQL text.
grant select on all tables in schema public to ts_readonly;
alter default privileges for role ts_app in schema public
  grant select on tables to ts_readonly;

-- If the schema was applied by a superuser, hand the objects to ts_app so the
-- application can manage its own tables afterwards.
do $$ declare r record; begin
  for r in select tablename as n from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I owner to ts_app', r.n);
  end loop;
  for r in select viewname as n from pg_views where schemaname = 'public' loop
    execute format('alter view public.%I owner to ts_app', r.n);
  end loop;
  for r in select sequencename as n from pg_sequences where schemaname = 'public' loop
    execute format('alter sequence public.%I owner to ts_app', r.n);
  end loop;
end $$;

grant select on all tables in schema public to ts_readonly;
