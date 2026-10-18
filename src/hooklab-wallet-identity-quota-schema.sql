-- Explicit isolated identity database only. No shared migration registration.
create table hook_lab_wallet_request_limits (
  scope text primary key,
  hits integer not null check (hits > 0),
  expires_at timestamptz not null
);
