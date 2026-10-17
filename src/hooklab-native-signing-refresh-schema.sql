-- Explicit refresh is allowed only before ANY retained signature or signer/send claim.
alter table hook_lab_native_signing_operations add column review_generation bigint not null default 0;
create table hook_lab_native_signing_review_history (
 operation_id uuid not null references hook_lab_native_signing_operations(id),
 generation bigint not null, original_row jsonb not null, archived_at timestamptz not null default clock_timestamp(),
 primary key(operation_id,generation)
);
create or replace function hook_lab_native_signing_identity_immutable() returns trigger language plpgsql as $$
begin
 if row(new.id,new.owner_wallet,new.custody_operation_id,new.stage,new.profile_sha256,new.resolved_request,new.configuration_sha256,new.created_at)
 is distinct from row(old.id,old.owner_wallet,old.custody_operation_id,old.stage,old.profile_sha256,old.resolved_request,old.configuration_sha256,old.created_at)
 then raise exception 'Native signing identity is immutable'; end if;
 if new.revision<>old.revision+1 then raise exception 'Native signing revision must advance once'; end if;
 if row(new.review,new.message_sha256,new.settlement_context) is distinct from row(old.review,old.message_sha256,old.settlement_context) then
  if old.status<>'reviewed' or new.status<>'reviewed' or old.signature is not null or new.signature is not null
    or old.pending_signer is not null or new.pending_signer is not null or new.review_generation<>old.review_generation+1
    or exists(select 1 from hook_lab_native_signing_attempts where operation_id=old.id)
  then raise exception 'Signed or claimed review cannot be replaced'; end if;
  insert into hook_lab_native_signing_review_history(operation_id,generation,original_row) values(old.id,old.review_generation,to_jsonb(old));
 elsif new.review_generation<>old.review_generation then raise exception 'Review generation differs'; end if;
 if old.first_finalized is not null and new.first_finalized is distinct from old.first_finalized then raise exception 'First finality is immutable'; end if;
 if old.first_conflict is not null and new.first_conflict is distinct from old.first_conflict then raise exception 'First conflict is immutable'; end if;
 return new;
end $$;
create or replace function hook_lab_native_signing_context_immutable() returns trigger language plpgsql as $$
begin
 if tg_op='INSERT' then
  if new.configuration_sha256 is null or new.settlement_context is null then raise exception 'Verified signing context required'; end if;
 elsif row(new.configuration_sha256,new.resolved_request) is distinct from row(old.configuration_sha256,old.resolved_request) then
  raise exception 'Signing configuration and intent are immutable';
 end if;
 -- Main identity trigger permits context replacement only for an unsigned refresh.
 return new;
end $$;

create function hook_lab_native_signing_history_immutable() returns trigger language plpgsql as $$
begin raise exception 'Archived signing review is immutable'; end $$;
create trigger hook_lab_native_signing_history_immutable before update or delete on hook_lab_native_signing_review_history
 for each row execute function hook_lab_native_signing_history_immutable();
