-- Run with the application's schema installer. Publications cannot be replaced or deleted.
create table if not exists hook_lab_hook_publications (
 digest text primary key check (digest ~ '^[a-f0-9]{64}$'),
 publisher text not null,
 program text not null,
 version text not null,
 publication jsonb not null,
 published_at timestamptz not null default clock_timestamp(),
 unique(publisher,program,version)
);
create or replace function hook_lab_publication_append_only() returns trigger language plpgsql as $$
begin raise exception 'Hook publications are append-only'; end;
$$;
drop trigger if exists hook_lab_publication_append_only on hook_lab_hook_publications;
create trigger hook_lab_publication_append_only before update or delete on hook_lab_hook_publications
 for each row execute function hook_lab_publication_append_only();
