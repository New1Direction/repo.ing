-- Patch 07, deliberately NOT registered in shared migrations. Apply only to an
-- explicitly provisioned journal database; tests use disposable local PostgreSQL.
-- This schema stores offline assertions, not production acceptance or authority.
create table hook_lab_custom_preparation (
  id uuid primary key,
  github_user_id text not null check (github_user_id ~ '^[1-9][0-9]{0,17}$'),
  profile_sha256 text not null check (profile_sha256 ~ '^[a-f0-9]{64}$'),
  providers jsonb not null check (jsonb_typeof(providers) = 'array' and jsonb_array_length(providers) = 2),
  evidence_mode text not null check (evidence_mode in ('synthetic-fixture', 'configured-readonly-rpc')),
  genesis_hash text not null,
  mint text not null,
  intent_sha256 text not null check (intent_sha256 ~ '^[a-f0-9]{64}$'),
  message_sha256 text not null check (message_sha256 ~ '^[a-f0-9]{64}$'),
  preparation_input_sha256 text not null check (preparation_input_sha256 ~ '^[a-f0-9]{64}$'),
  preparation_input jsonb not null,
  derived_record jsonb not null,
  signature text not null,
  signed_transaction text not null,
  signed_transaction_sha256 text not null check (signed_transaction_sha256 ~ '^[a-f0-9]{64}$'),
  latest_evidence jsonb not null,
  retained_evidence jsonb,
  evidence_conflict boolean not null default false,
  first_conflict jsonb,
  created_at timestamptz not null default clock_timestamp(),
  checked_at timestamptz not null default clock_timestamp(),
  unique (genesis_hash, mint),
  unique (genesis_hash, signature),
  unique (profile_sha256, intent_sha256),
  unique (profile_sha256, message_sha256),
  check (evidence_conflict = (first_conflict is not null))
);
create index hook_lab_custom_preparation_owner_created
  on hook_lab_custom_preparation (github_user_id, profile_sha256, created_at desc, id);
create index hook_lab_custom_preparation_pending
  on hook_lab_custom_preparation (profile_sha256, checked_at, id);

create table hook_lab_custom_preparation_events (
  id bigint generated always as identity primary key,
  journal_id uuid not null references hook_lab_custom_preparation(id),
  kind text not null check (kind in ('retained', 'observed', 'conflict')),
  outcome jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
create index hook_lab_custom_preparation_events_journal
  on hook_lab_custom_preparation_events (journal_id, id);

-- Application transactions are the primary writer. These constraints also stop
-- accidental alternate writers replacing the identity or historical evidence.
create function hook_lab_custom_preparation_immutable() returns trigger language plpgsql as $$
begin
  if row(new.id, new.github_user_id, new.profile_sha256, new.providers, new.evidence_mode,
         new.genesis_hash, new.mint, new.intent_sha256, new.message_sha256,
         new.preparation_input_sha256, new.preparation_input, new.derived_record,
         new.signature, new.signed_transaction, new.signed_transaction_sha256, new.created_at)
     is distinct from
     row(old.id, old.github_user_id, old.profile_sha256, old.providers, old.evidence_mode,
         old.genesis_hash, old.mint, old.intent_sha256, old.message_sha256,
         old.preparation_input_sha256, old.preparation_input, old.derived_record,
         old.signature, old.signed_transaction, old.signed_transaction_sha256, old.created_at)
  then raise exception 'Custom preparation identity is immutable'; end if;
  if old.retained_evidence is not null and new.retained_evidence is distinct from old.retained_evidence
  then raise exception 'Original finalized preparation evidence is immutable'; end if;
  if old.evidence_conflict and (not new.evidence_conflict or new.first_conflict is distinct from old.first_conflict)
  then raise exception 'Preparation evidence conflict requires independent review'; end if;
  return new;
end $$;
create trigger hook_lab_custom_preparation_immutable
  before update on hook_lab_custom_preparation
  for each row execute function hook_lab_custom_preparation_immutable();
