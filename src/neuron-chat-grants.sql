-- Optional mock preview, AFTER neuron-chat-schema.sql and publishing grants.
-- Same distinct non-owner runtime_role / review_role and schema psql variables.
begin;
revoke all on table :"schema".neuron_chat_attempts from public, :"runtime_role", :"review_role";
grant select on :"schema".neuron_chat_attempts to :"runtime_role";
grant insert (id,wallet,request_id,conversation_id,character_id,message)
  on :"schema".neuron_chat_attempts to :"runtime_role";
grant update (status,reply) on :"schema".neuron_chat_attempts to :"runtime_role";
commit;
