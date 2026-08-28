-- Hand every object in the public schema to ts_app, then re-grant SELECT to the
-- read-only role. Run as a superuser after applying schema.sql as a superuser.
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
