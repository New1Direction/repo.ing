-- Apply after hooklab-native-signer-custody-schema.sql.
alter table hook_lab_native_signer_custody add column preparation_request jsonb;
create function hook_lab_native_preparation_intent_immutable() returns trigger language plpgsql as $$
begin
 if old.preparation_request is not null and new.preparation_request is distinct from old.preparation_request
 then raise exception 'Native preparation intent is immutable'; end if;
 return new;
end $$;
create trigger hook_lab_native_preparation_intent_immutable before update on hook_lab_native_signer_custody
 for each row execute function hook_lab_native_preparation_intent_immutable();
