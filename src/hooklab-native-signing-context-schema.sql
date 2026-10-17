-- Private immutable original pre-state. Never expose settlement_context in HTTP.
alter table hook_lab_native_signing_operations add column configuration_sha256 text;
alter table hook_lab_native_signing_operations add column settlement_context jsonb;
alter table hook_lab_native_signing_operations add column resolved_request jsonb;
-- Legacy rows without context are retained but cannot authorize further execution.
alter table hook_lab_native_signing_operations add constraint signing_configuration_hash check(configuration_sha256 is null or configuration_sha256 ~ '^[a-f0-9]{64}$');
create function hook_lab_native_signing_context_immutable() returns trigger language plpgsql as $$
begin
 if tg_op='INSERT' then
  if new.configuration_sha256 is null or new.settlement_context is null then raise exception 'Verified signing context required'; end if;
 elsif row(new.configuration_sha256,new.settlement_context,new.resolved_request) is distinct from row(old.configuration_sha256,old.settlement_context,old.resolved_request) then
  raise exception 'Original signing context is immutable';
 end if;
 return new;
end $$;
create trigger hook_lab_native_signing_context_immutable before insert or update on hook_lab_native_signing_operations
 for each row execute function hook_lab_native_signing_context_immutable();
