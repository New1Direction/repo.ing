-- Candidate only: apply explicitly as the schema owner in the dedicated
-- publishing database AFTER all three publishing/identity schemas exist.
-- psql variables: schema, runtime_role, review_role (SQL identifiers, not secrets).
-- Roles must be distinct, non-owner, non-superuser and unable to assume each
-- other or an administrative role. This does not create roles or credentials.
begin;
revoke all on schema :"schema" from public;
revoke all on schema :"schema" from :"runtime_role", :"review_role";
grant usage on schema :"schema" to :"runtime_role", :"review_role";

revoke all on table :"schema".neuron_characters, :"schema".neuron_character_reviews,
  :"schema".hook_lab_wallet_challenges, :"schema".hook_lab_wallet_sessions,
  :"schema".hook_lab_wallet_request_limits from public, :"runtime_role", :"review_role";
revoke all on sequence :"schema".neuron_character_reviews_id_seq from public, :"runtime_role", :"review_role";

grant select on :"schema".neuron_characters to :"runtime_role", :"review_role";
-- Web submissions can ONLY use the pending/status timestamp defaults.
grant insert (id, creator_wallet, request_id, snapshot, metadata_sha256)
  on :"schema".neuron_characters to :"runtime_role";
grant select, insert on :"schema".hook_lab_wallet_challenges, :"schema".hook_lab_wallet_sessions,
  :"schema".hook_lab_wallet_request_limits to :"runtime_role";
grant update (consumed_at) on :"schema".hook_lab_wallet_challenges to :"runtime_role";
grant update (revoked_at) on :"schema".hook_lab_wallet_sessions to :"runtime_role";
grant update (hits, expires_at) on :"schema".hook_lab_wallet_request_limits to :"runtime_role";

-- Review can publish/remove but cannot rewrite a creator's content or ownership.
grant update (status, reviewed_at) on :"schema".neuron_characters to :"review_role";
grant select on :"schema".neuron_character_reviews to :"review_role";
grant insert (character_id, decision, reason) on :"schema".neuron_character_reviews to :"review_role";
grant usage on sequence :"schema".neuron_character_reviews_id_seq to :"review_role";
commit;
