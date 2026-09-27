CREATE TABLE "markets" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"status" varchar(16) NOT NULL,
	"mint" varchar(44),
	"pool" varchar(44),
	"launcher_wallet" varchar(44) NOT NULL,
	"creator_wallet" varchar(44) NOT NULL,
	"token_name" text NOT NULL,
	"token_symbol" varchar(16) NOT NULL,
	"token_image" text,
	"launch_signature" varchar(88),
	"blockhash" varchar(44),
	"last_valid_block_height" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "markets_status_check" CHECK ("markets"."status" in ('reserved', 'prepared', 'submitted', 'confirmed', 'failed', 'ambiguous')),
	CONSTRAINT "markets_confirmed_evidence_check" CHECK ("markets"."status" <> 'confirmed' or ("markets"."mint" is not null and "markets"."pool" is not null and "markets"."launch_signature" is not null))
);
--> statement-breakpoint
CREATE TABLE "repositories" (
	"github_repo_id" bigint PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"full_name" text NOT NULL,
	"description" text,
	"avatar_url" text,
	"stars" integer NOT NULL,
	"forks" integer NOT NULL,
	"archived" boolean NOT NULL,
	"github_updated_at" timestamp with time zone NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "markets" ADD CONSTRAINT "markets_github_repo_id_repositories_github_repo_id_fk" FOREIGN KEY ("github_repo_id") REFERENCES "public"."repositories"("github_repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "markets_github_repo_id_unique" ON "markets" USING btree ("github_repo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "markets_mint_unique" ON "markets" USING btree ("mint");--> statement-breakpoint
CREATE UNIQUE INDEX "markets_pool_unique" ON "markets" USING btree ("pool");--> statement-breakpoint
CREATE UNIQUE INDEX "markets_launch_signature_unique" ON "markets" USING btree ("launch_signature");