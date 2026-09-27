CREATE TABLE "builder_allocation_claims" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"github_user_id" bigint NOT NULL,
	"mint" varchar(44) NOT NULL,
	"wallet" varchar(44) NOT NULL,
	"amount" bigint NOT NULL,
	"status" varchar(16) NOT NULL,
	"signature" varchar(88) NOT NULL,
	"signed_transaction" text NOT NULL,
	"last_valid_block_height" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"resolution_reason" text,
	CONSTRAINT "builder_allocation_amount_check" CHECK ("builder_allocation_claims"."amount" = 10000000000000),
	CONSTRAINT "builder_allocation_status_check" CHECK ("builder_allocation_claims"."status" in ('pending','settled','aborted')),
	CONSTRAINT "builder_allocation_settlement_check" CHECK (("builder_allocation_claims"."status" = 'settled') = ("builder_allocation_claims"."settled_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "repository_participation" (
	"github_repo_id" bigint PRIMARY KEY NOT NULL,
	"github_user_id" bigint NOT NULL,
	"github_login" text NOT NULL,
	"enabled" boolean NOT NULL,
	"opted_in_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discovery_claims" DROP CONSTRAINT "discovery_claims_amount_check";--> statement-breakpoint
ALTER TABLE "markets" DROP CONSTRAINT "markets_discovery_version_check";--> statement-breakpoint
ALTER TABLE "markets" ADD COLUMN "builder_allocation_version" integer;--> statement-breakpoint
ALTER TABLE "builder_allocation_claims" ADD CONSTRAINT "builder_allocation_claims_github_repo_id_markets_github_repo_id_fk" FOREIGN KEY ("github_repo_id") REFERENCES "public"."markets"("github_repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_participation" ADD CONSTRAINT "repository_participation_github_repo_id_markets_github_repo_id_fk" FOREIGN KEY ("github_repo_id") REFERENCES "public"."markets"("github_repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "builder_allocation_signature_unique" ON "builder_allocation_claims" USING btree ("signature");--> statement-breakpoint
CREATE UNIQUE INDEX "builder_allocation_one_payout" ON "builder_allocation_claims" USING btree ("github_repo_id") WHERE "builder_allocation_claims"."status" in ('pending','settled');--> statement-breakpoint
ALTER TABLE "discovery_claims" ADD CONSTRAINT "discovery_claims_amount_check" CHECK ("discovery_claims"."amount" > 0 and "discovery_claims"."amount" <= 2500000000);--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_builder_allocation_version_check" CHECK ("markets"."builder_allocation_version" is null or "markets"."builder_allocation_version" = 1);--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_discovery_version_check" CHECK ("markets"."discovery_version" is null or "markets"."discovery_version" in (1,2));