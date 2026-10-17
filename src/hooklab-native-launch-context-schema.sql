-- Durable owner-scoped requested launch intent and server-reviewed debit limits.
create table hook_lab_native_launch_context (
 custody_operation_id uuid primary key references hook_lab_native_signer_custody(operation_id),
 owner_wallet text not null,
 launch_request jsonb not null,
 preparation_limits jsonb not null,
 launch_limits jsonb not null,
 created_at timestamptz not null default clock_timestamp()
);
create function hook_lab_native_launch_context_immutable() returns trigger language plpgsql as $$
begin raise exception 'Launch context is immutable'; end $$;
create trigger hook_lab_native_launch_context_immutable before update or delete on hook_lab_native_launch_context
 for each row execute function hook_lab_native_launch_context_immutable();
