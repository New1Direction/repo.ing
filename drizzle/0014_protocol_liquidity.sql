CREATE TABLE "liquidity_intents" (
	"id" serial PRIMARY KEY NOT NULL,
	"idempotency_key" varchar(64) NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"pool" varchar(44) NOT NULL,
	"network" varchar(16) NOT NULL,
	"source_amount" bigint NOT NULL,
	"swap_amount" bigint NOT NULL,
	"min_swap_output" bigint NOT NULL,
	"source_wallet" varchar(44) NOT NULL,
	"token_a_mint" varchar(44) NOT NULL,
	"token_b_mint" varchar(44) NOT NULL,
	"max_amount_token_a" varchar(48) NOT NULL,
	"max_amount_token_b" varchar(48) NOT NULL,
	"quote_identifier" varchar(128),
	"max_slippage_bps" integer NOT NULL,
	"max_price_impact_bps" integer NOT NULL,
	"lp_owner" varchar(44) NOT NULL,
	"position" varchar(44),
	"position_nft_mint" varchar(44),
	"lock_mode" varchar(24) NOT NULL,
	"policy_version" integer NOT NULL,
	"rules_version" integer NOT NULL,
	"rules_json" text NOT NULL,
	"minimum_liquidity" varchar(80) NOT NULL,
	"max_network_cost" bigint NOT NULL,
	"settled_network_cost" bigint,
	"status" varchar(16) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"review" text,
	"simulation" text,
	"signature" varchar(88),
	"signed_transaction" text,
	"last_valid_block_height" bigint,
	"expected_liquidity" varchar(80),
	"settled_debit" bigint,
	"settled_token_a" varchar(48),
	"settled_token_b" varchar(48),
	"settled_liquidity" varchar(80),
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"simulated_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolution_reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "liquidity_intents_amount_check" CHECK ("liquidity_intents"."source_amount" > 0 and "liquidity_intents"."swap_amount" >= 0),
	CONSTRAINT "liquidity_intents_status_check" CHECK ("liquidity_intents"."status" in ('prepared','reviewed','simulated','submitted','settled','aborted')),
	CONSTRAINT "liquidity_intents_settlement_check" CHECK (("liquidity_intents"."status" = 'settled' and "liquidity_intents"."settled_at" is not null and "liquidity_intents"."signature" is not null and "liquidity_intents"."position" is not null and "liquidity_intents"."resolved_at" is null and "liquidity_intents"."resolution_reason" is null) or ("liquidity_intents"."status" = 'aborted' and "liquidity_intents"."settled_at" is null and "liquidity_intents"."resolved_at" is not null and "liquidity_intents"."resolution_reason" is not null) or ("liquidity_intents"."status" in ('prepared','reviewed','simulated','submitted') and "liquidity_intents"."settled_at" is null and "liquidity_intents"."resolved_at" is null and "liquidity_intents"."resolution_reason" is null))
);
--> statement-breakpoint
ALTER TABLE "liquidity_intents" ADD CONSTRAINT "liquidity_intents_github_repo_id_markets_github_repo_id_fk" FOREIGN KEY ("github_repo_id") REFERENCES "public"."markets"("github_repo_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "liquidity_intents_idempotency_key_unique" ON "liquidity_intents" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "liquidity_intents_signature_unique" ON "liquidity_intents" USING btree ("signature");
--> statement-breakpoint
CREATE UNIQUE INDEX "liquidity_intents_one_open_per_market" ON "liquidity_intents" USING btree ("github_repo_id") WHERE "liquidity_intents"."status" in ('prepared','reviewed','simulated','submitted');

--> statement-breakpoint
CREATE UNIQUE INDEX liquidity_intents_position_unique ON liquidity_intents(position);
--> statement-breakpoint
ALTER TABLE liquidity_intents ADD CONSTRAINT liquidity_intents_budget_check CHECK
 (swap_amount > 0 AND swap_amount < source_amount AND min_swap_output > 0 AND max_network_cost > 0
  AND max_slippage_bps > 0 AND max_slippage_bps < 10000 AND max_price_impact_bps > 0 AND max_price_impact_bps <= 10000
  AND lock_mode = 'platform-authority' AND source_wallet = lp_owner);
