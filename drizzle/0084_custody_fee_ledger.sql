-- Receipt-only custody bookkeeping. No transaction intent, queue or execution switch.
CREATE TABLE custody_fee_collections (
  signature varchar(88) PRIMARY KEY,
  github_repo_id bigint NOT NULL REFERENCES repositories(github_repo_id),
  role text NOT NULL CHECK (role IN ('creator','partner')),
  position varchar(44) NOT NULL,
  amount numeric(20,0) NOT NULL CHECK (amount > 0),
  slot bigint NOT NULL CHECK (slot > 0),
  receipt jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX custody_fee_collections_repo ON custody_fee_collections(github_repo_id,role);
--> statement-breakpoint
CREATE TABLE custody_fee_payouts (
  signature varchar(88) PRIMARY KEY,
  collection_signature varchar(88) NOT NULL REFERENCES custody_fee_collections(signature),
  beneficiary varchar(44) NOT NULL,
  amount numeric(20,0) NOT NULL CHECK (amount > 0),
  slot bigint NOT NULL CHECK (slot > 0),
  receipt jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX custody_fee_payouts_collection ON custody_fee_payouts(collection_signature);
--> statement-breakpoint
ALTER TABLE repo_claims ADD COLUMN evidence_source text NOT NULL DEFAULT 'signed-intent';
--> statement-breakpoint
ALTER TABLE repo_claims ADD COLUMN custody_payout_signature varchar(88) UNIQUE REFERENCES custody_fee_payouts(signature);
--> statement-breakpoint
ALTER TABLE repo_claims ADD CONSTRAINT repo_claims_custody_evidence CHECK (
  (evidence_source='signed-intent' AND custody_payout_signature IS NULL)
  OR (evidence_source='custody-receipt' AND status='settled' AND signed_transaction IS NULL
    AND last_valid_block_height IS NULL AND damm_amount_base_units=amount_base_units
    AND custody_payout_signature IS NOT NULL AND custody_payout_signature=claim_signature)
);
