-- Isolated, opt-in wallet authentication schema. Not in shared migrations.
-- No GitHub identity, transaction signing, grant or execution authority.
create table hook_lab_wallet_challenges (
  nonce text primary key check (nonce ~ '^[a-f0-9]{64}$'),
  wallet text not null,
  origin text not null,
  audience text not null,
  genesis_hash text not null,
  browser_binding_sha256 text not null,
  message text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz
);
create table hook_lab_wallet_sessions (
  token_sha256 text primary key check (token_sha256 ~ '^[a-f0-9]{64}$'),
  wallet text not null,
  origin text not null,
  audience text not null,
  genesis_hash text not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
