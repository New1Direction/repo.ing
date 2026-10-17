-- Internal candidate, intentionally not registered with drizzle or the general worker.
-- Apply only to disposable data until target-specific migration/backup approval.
CREATE TABLE hook_native_index_streams (
  id text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
  manifest jsonb NOT NULL,
  next_slot bigint NOT NULL CHECK (next_slot >= 0),
  last_block jsonb
);
CREATE TABLE hook_native_index_blocks (
  stream text NOT NULL REFERENCES hook_native_index_streams(id),
  slot bigint NOT NULL,
  evidence jsonb NOT NULL,
  PRIMARY KEY (stream,slot)
);
CREATE TABLE hook_native_index_transactions (
  stream text NOT NULL,
  signature text NOT NULL,
  slot bigint NOT NULL,
  transaction_index integer NOT NULL CHECK (transaction_index >= 0),
  evidence jsonb NOT NULL,
  PRIMARY KEY (stream,signature),
  UNIQUE (stream,slot,transaction_index),
  FOREIGN KEY (stream,slot) REFERENCES hook_native_index_blocks(stream,slot)
);
