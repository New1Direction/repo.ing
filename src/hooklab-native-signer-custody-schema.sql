-- Explicit opt-in candidate tables in the same application DB as wallet identity.
-- Stores ciphertext only. No automatic expiration or key erasure.
create table hook_lab_native_signer_custody (
 operation_id uuid primary key,
 custody_session_id uuid not null unique,
 owner_wallet text not null,
 profile_sha256 text not null,
 mint text not null unique,
 selected_config text not null unique,
 stage text not null check(stage in ('reserved','preparation-reviewed','preparation-signed','preparation-finalized','launch-reviewed','launch-signed','launch-finalized','reconcile-required')),
 revision bigint not null default 0 check(revision>=0),
 sealed_signers jsonb not null,
 evidence_sha256 text,
 created_at timestamptz not null default clock_timestamp(),
 updated_at timestamptz not null default clock_timestamp()
);
create function hook_lab_native_signer_identity_immutable() returns trigger language plpgsql as $$
begin
 if row(new.operation_id,new.custody_session_id,new.owner_wallet,new.profile_sha256,new.mint,new.selected_config,new.created_at)
  is distinct from row(old.operation_id,old.custody_session_id,old.owner_wallet,old.profile_sha256,old.mint,old.selected_config,old.created_at)
 then raise exception 'Native signer identity is immutable'; end if;
 if new.revision<>old.revision+1 then raise exception 'Native signer revision must advance exactly once'; end if;
 return new;
end $$;
create trigger hook_lab_native_signer_identity_immutable before update on hook_lab_native_signer_custody
 for each row execute function hook_lab_native_signer_identity_immutable();

-- Preserve every public stage/revision witness. No keys or ciphertext in history.
create table hook_lab_native_signer_custody_history (
 operation_id uuid not null references hook_lab_native_signer_custody(operation_id),
 revision bigint not null,
 stage text not null,
 evidence_sha256 text,
 key_id text not null,
 recorded_at timestamptz not null default clock_timestamp(),
 primary key(operation_id,revision)
);
create function hook_lab_native_signer_history_append() returns trigger language plpgsql as $$
begin
 insert into hook_lab_native_signer_custody_history(operation_id,revision,stage,evidence_sha256,key_id)
 values(new.operation_id,new.revision,new.stage,new.evidence_sha256,new.sealed_signers->>'keyId');
 return new;
end $$;
create trigger hook_lab_native_signer_history_append after insert or update on hook_lab_native_signer_custody
 for each row execute function hook_lab_native_signer_history_append();
