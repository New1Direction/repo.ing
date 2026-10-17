-- A wallet may sign before a response reaches the server. Never infer absence of
-- a signature merely from an empty retained signature slot after byte issuance.
alter table hook_lab_native_signing_operations add column wallet_requested_at timestamptz;
create function hook_lab_native_wallet_issuance_immutable() returns trigger language plpgsql as $$
begin
 if old.wallet_requested_at is not null and new.wallet_requested_at is distinct from old.wallet_requested_at then
  raise exception 'Wallet request issuance is immutable'; end if;
 if old.wallet_requested_at is not null and row(new.review,new.message_sha256,new.settlement_context,new.review_generation)
  is distinct from row(old.review,old.message_sha256,old.settlement_context,old.review_generation) then
  raise exception 'Issued wallet message cannot be replaced'; end if;
 return new;
end $$;
create trigger hook_lab_native_wallet_issuance_immutable before update on hook_lab_native_signing_operations
 for each row execute function hook_lab_native_wallet_issuance_immutable();
