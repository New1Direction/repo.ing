-- Isolated wallet-owned candidate evidence. Never register in automatic migrations.
create table hook_lab_wallet_preparations (
 id uuid primary key,
 owner_wallet text not null,
 profile_sha256 text not null,
 providers jsonb not null,
 genesis_hash text not null,
 mint text not null,
 intent_sha256 text not null,
 message_sha256 text not null,
 preparation_input_sha256 text not null,
 preparation_input jsonb not null,
 signed_transaction text not null,
 signed_transaction_sha256 text not null,
 signature text not null,
 latest_evidence jsonb,
 retained_evidence jsonb,
 evidence_conflict boolean not null default false,
 first_conflict jsonb,
 created_at timestamptz not null default clock_timestamp(),
 checked_at timestamptz not null default clock_timestamp(),
 check(evidence_conflict = (first_conflict is not null)),
 unique(genesis_hash,mint), unique(genesis_hash,signature), unique(profile_sha256,intent_sha256), unique(profile_sha256,message_sha256)
);
create function hook_lab_wallet_preparation_immutable() returns trigger language plpgsql as $$
begin
 if row(new.id,new.owner_wallet,new.profile_sha256,new.providers,new.genesis_hash,new.mint,new.intent_sha256,new.message_sha256,
        new.preparation_input_sha256,new.preparation_input,new.signed_transaction,new.signed_transaction_sha256,new.signature,new.created_at)
    is distinct from row(old.id,old.owner_wallet,old.profile_sha256,old.providers,old.genesis_hash,old.mint,old.intent_sha256,old.message_sha256,
        old.preparation_input_sha256,old.preparation_input,old.signed_transaction,old.signed_transaction_sha256,old.signature,old.created_at)
 then raise exception 'Wallet preparation identity is immutable'; end if;
 if old.retained_evidence is not null and new.retained_evidence is distinct from old.retained_evidence
 then raise exception 'Original evidence is immutable'; end if;
 if old.evidence_conflict and (not new.evidence_conflict or new.first_conflict is distinct from old.first_conflict) then raise exception 'Evidence conflict is sticky'; end if;
 return new;
end $$;
create trigger hook_lab_wallet_preparation_immutable before update on hook_lab_wallet_preparations
 for each row execute function hook_lab_wallet_preparation_immutable();
