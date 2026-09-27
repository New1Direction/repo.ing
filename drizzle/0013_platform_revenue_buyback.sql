CREATE TABLE "platform_revenue_policies" (
	"version" integer PRIMARY KEY NOT NULL,
	"buyback_permille" integer NOT NULL,
	"liquidity_permille" integer NOT NULL,
	"activated_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_revenue_policies_permille_check" CHECK ("platform_revenue_policies"."buyback_permille" >= 0 and "platform_revenue_policies"."liquidity_permille" >= 0 and "platform_revenue_policies"."buyback_permille" + "platform_revenue_policies"."liquidity_permille" <= 1000)
);
--> statement-breakpoint
CREATE TABLE "platform_revenue_allocations" (
	"id" serial PRIMARY KEY NOT NULL,
	"allocation_group" varchar(64) NOT NULL,
	"claim_signature" varchar(88) NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"claimed_amount" bigint NOT NULL,
	"buyback_amount" bigint NOT NULL,
	"liquidity_amount" bigint NOT NULL,
	"treasury_amount" bigint NOT NULL,
	"policy_version" integer NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_revenue_allocations_parts_check" CHECK ("platform_revenue_allocations"."buyback_amount" + "platform_revenue_allocations"."liquidity_amount" + "platform_revenue_allocations"."treasury_amount" = "platform_revenue_allocations"."claimed_amount" and "platform_revenue_allocations"."buyback_amount" >= 0 and "platform_revenue_allocations"."liquidity_amount" >= 0 and "platform_revenue_allocations"."treasury_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "buyback_intents" (
	"id" serial PRIMARY KEY NOT NULL,
	"idempotency_key" varchar(64) NOT NULL,
	"allocation_group" varchar(64) NOT NULL,
	"amount" bigint NOT NULL,
	"wallet_source" varchar(44) NOT NULL,
	"destination_mint" varchar(44),
	"destination_token_account" varchar(44),
	"quote_identifier" varchar(128),
	"expected_output" varchar(40),
	"minimum_output" varchar(40),
	"max_slippage_bps" integer,
	"max_price_impact_bps" integer,
	"policy_version" integer NOT NULL,
	"network" varchar(16) NOT NULL,
	"status" varchar(16) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"review" text,
	"simulation" text,
	"signature" varchar(88),
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"simulated_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolution_reason" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "buyback_intents_amount_check" CHECK ("buyback_intents"."amount" > 0),
	CONSTRAINT "buyback_intents_status_check" CHECK ("buyback_intents"."status" in ('prepared','reviewed','simulated','settled','aborted')),
	CONSTRAINT "buyback_intents_settlement_check" CHECK (("buyback_intents"."status" = 'settled' and "buyback_intents"."settled_at" is not null and "buyback_intents"."signature" is not null and "buyback_intents"."resolved_at" is null and "buyback_intents"."resolution_reason" is null) or ("buyback_intents"."status" = 'aborted' and "buyback_intents"."settled_at" is null and "buyback_intents"."resolved_at" is not null and "buyback_intents"."resolution_reason" is not null) or ("buyback_intents"."status" in ('prepared','reviewed','simulated') and "buyback_intents"."settled_at" is null and "buyback_intents"."resolved_at" is null and "buyback_intents"."resolution_reason" is null))
);
--> statement-breakpoint
ALTER TABLE "platform_revenue_allocations" ADD CONSTRAINT "platform_revenue_allocations_github_repo_id_markets_github_repo_id_fk" FOREIGN KEY ("github_repo_id") REFERENCES "public"."markets"("github_repo_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "platform_revenue_allocations_claim_unique" ON "platform_revenue_allocations" USING btree ("claim_signature");
--> statement-breakpoint
CREATE UNIQUE INDEX "buyback_intents_idempotency_key_unique" ON "buyback_intents" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "buyback_intents_signature_unique" ON "buyback_intents" USING btree ("signature");
--> statement-breakpoint
CREATE VIEW "platform_revenue" AS
select 'DAMM' as phase, e.github_repo_id, e.amount_base_units as earned_amount, e.slot, e.evidence_hash, e.created_at
  from platform_fee_events e
union all
select 'DBC' as phase, f.github_repo_id, f.partner_amount as earned_amount, f.slot, null::varchar as evidence_hash, f.traded_at as created_at
  from discovery_fee_events f;
