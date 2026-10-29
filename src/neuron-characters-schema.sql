-- Apply explicitly to the isolated publishing/identity database, not the trading DB.
create table neuron_characters (
  id uuid primary key,
  creator_wallet text not null,
  request_id uuid not null,
  snapshot jsonb not null,
  metadata_sha256 text not null check (metadata_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'published', 'rejected')),
  created_at timestamptz not null default clock_timestamp(),
  reviewed_at timestamptz,
  unique (creator_wallet, request_id)
);
create index neuron_characters_owner_created on neuron_characters(creator_wallet, created_at desc);
create index neuron_characters_created on neuron_characters(created_at desc);
create table neuron_character_reviews (
  id bigint generated always as identity primary key,
  character_id uuid not null references neuron_characters(id),
  decision text not null check (decision in ('published', 'rejected')),
  reason text not null check (length(reason) between 10 and 500),
  reviewed_at timestamptz not null default clock_timestamp()
);
