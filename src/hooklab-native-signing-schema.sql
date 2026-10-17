-- Same database as wallet principals and custody. Never erase signed records on expiry.
create table hook_lab_native_signing_operations (
 id uuid primary key,
 owner_wallet text not null,
 custody_operation_id uuid not null,
 stage text not null check(stage in ('preparation','launch')),
 profile_sha256 text not null,
 review jsonb not null,
 message_sha256 text not null,
 partial_transaction text not null,
 status text not null check(status in ('reviewed','partial','signed','submission-claimed','outcome-unknown','submitted','finalized-success','finalized-failure','review-required')),
 revision bigint not null default 0,
 signature text,
 first_finalized jsonb,
 first_conflict jsonb,
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp(),
 unique(custody_operation_id,stage)
);
create function hook_lab_native_signing_identity_immutable() returns trigger language plpgsql as $$
begin
 if row(new.id,new.owner_wallet,new.custody_operation_id,new.stage,new.profile_sha256,new.review,new.message_sha256,new.created_at)
 is distinct from row(old.id,old.owner_wallet,old.custody_operation_id,old.stage,old.profile_sha256,old.review,old.message_sha256,old.created_at)
 then raise exception 'Native signing identity is immutable'; end if;
 if new.revision<>old.revision+1 then raise exception 'Native signing revision must advance once'; end if;
 if old.first_finalized is not null and new.first_finalized is distinct from old.first_finalized then raise exception 'First finality is immutable'; end if;
 if old.first_conflict is not null and new.first_conflict is distinct from old.first_conflict then raise exception 'First conflict is immutable'; end if;
 return new;
end $$;
create trigger hook_lab_native_signing_identity_immutable before update on hook_lab_native_signing_operations
 for each row execute function hook_lab_native_signing_identity_immutable();
