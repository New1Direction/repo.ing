-- Optional mock-chat preview only. Apply explicitly to the isolated publishing DB.
create table neuron_chat_attempts (
  id uuid primary key,
  wallet text not null,
  request_id uuid not null,
  conversation_id uuid not null,
  character_id uuid not null references neuron_characters(id),
  message text not null check (length(message) between 1 and 500),
  reply text check (length(reply) between 1 and 4000),
  status text not null default 'pending' check (status in ('pending','complete','blocked','failed')),
  created_at timestamptz not null default clock_timestamp(),
  unique (wallet, request_id)
);
create index neuron_chat_owner_day on neuron_chat_attempts(wallet, created_at);
create index neuron_chat_created on neuron_chat_attempts(created_at);
create index neuron_chat_conversation on neuron_chat_attempts(wallet, character_id, conversation_id, created_at);
