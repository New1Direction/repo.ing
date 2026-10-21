-- Apply after native signing / selected-hook request migrations. Registration is operator-owned.
alter table hook_lab_native_signing_operations drop constraint if exists hook_lab_native_signing_operations_stage_check;
alter table hook_lab_native_signing_operations add constraint hook_lab_native_signing_operations_stage_check
 check(stage in ('hook-setup','preparation','launch','inclusive-buy','inclusive-sell','wallet-fund','wallet-withdraw','native-buy','native-sell','native-claim','local-prepare-holding','local-inclusive-collection'));
alter table hook_lab_launch_requests add column hook_publication jsonb;
alter table hook_lab_native_launch_context add column setup_limits jsonb;
create table hook_lab_selected_hook_setup_intents (
 custody_operation_id uuid primary key references hook_lab_native_signer_custody(operation_id),
 owner_wallet text not null,
 profile_sha256 text not null,
 mint text not null unique,
 selected_config text not null,
 hook_publication jsonb not null,
 setup_request jsonb not null,
 created_at timestamptz not null default clock_timestamp()
);
create function hook_lab_selected_hook_setup_immutable() returns trigger language plpgsql as $$
begin raise exception 'Selected hook setup intent is immutable'; end $$;
create trigger hook_lab_selected_hook_setup_immutable before update or delete on hook_lab_selected_hook_setup_intents
 for each row execute function hook_lab_selected_hook_setup_immutable();
create function hook_lab_launch_publication_immutable() returns trigger language plpgsql as $$
begin
 if new.hook_publication is distinct from old.hook_publication then raise exception 'Hook publication and creator configuration are immutable'; end if;
 return new;
end $$;
create trigger hook_lab_launch_publication_immutable before update on hook_lab_launch_requests
 for each row execute function hook_lab_launch_publication_immutable();
