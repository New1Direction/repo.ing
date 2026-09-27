CREATE TABLE "platform_fee_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"pool" varchar(44) NOT NULL,
	"position" varchar(44) NOT NULL,
	"slot" bigint NOT NULL,
	"amount_base_units" bigint NOT NULL,
	"cumulative_earned" bigint NOT NULL,
	"cumulative_claimed" bigint NOT NULL,
	"evidence_hash" varchar(64) NOT NULL,
	"evidence" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_fee_events_positive_amount_check" CHECK ("platform_fee_events"."amount_base_units" > 0)
);
--> statement-breakpoint
CREATE TABLE "platform_fee_claims" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"pool" varchar(44) NOT NULL,
	"wallet" varchar(44) NOT NULL,
	"amount" bigint NOT NULL,
	"status" varchar(16) NOT NULL,
	"signature" varchar(88) NOT NULL,
	"signed_transaction" text NOT NULL,
	"last_valid_block_height" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolution_reason" text,
	CONSTRAINT "platform_fee_claims_amount_check" CHECK ("platform_fee_claims"."amount" > 0),
	CONSTRAINT "platform_fee_claims_status_check" CHECK ("platform_fee_claims"."status" in ('pending','settled','aborted')),
	CONSTRAINT "platform_fee_claims_settlement_check" CHECK (("platform_fee_claims"."status" = 'pending' and "platform_fee_claims"."settled_at" is null and "platform_fee_claims"."resolved_at" is null and "platform_fee_claims"."resolution_reason" is null) or ("platform_fee_claims"."status" = 'settled' and "platform_fee_claims"."settled_at" is not null and "platform_fee_claims"."resolved_at" is null and "platform_fee_claims"."resolution_reason" is null) or ("platform_fee_claims"."status" = 'aborted' and "platform_fee_claims"."settled_at" is null and "platform_fee_claims"."resolved_at" is not null and "platform_fee_claims"."resolution_reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "platform_fee_events" ADD CONSTRAINT "platform_fee_events_github_repo_id_repositories_github_repo_id_fk" FOREIGN KEY ("github_repo_id") REFERENCES "public"."repositories"("github_repo_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "platform_fee_claims" ADD CONSTRAINT "platform_fee_claims_github_repo_id_markets_github_repo_id_fk" FOREIGN KEY ("github_repo_id") REFERENCES "public"."markets"("github_repo_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "platform_fee_events_position_cumulative_earned_key" ON "platform_fee_events" USING btree ("position","cumulative_earned");
--> statement-breakpoint
CREATE UNIQUE INDEX "platform_fee_claims_signature_unique" ON "platform_fee_claims" USING btree ("signature");
--> statement-breakpoint
CREATE UNIQUE INDEX "platform_fee_claims_one_pending" ON "platform_fee_claims" USING btree ("github_repo_id") WHERE "platform_fee_claims"."status" = 'pending';
