CREATE TABLE "fee_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"mint" varchar(44) NOT NULL,
	"pool" varchar(44) NOT NULL,
	"signature" varchar(88) NOT NULL,
	"event_index" integer NOT NULL,
	"amount_base_units" bigint NOT NULL,
	"asset" varchar(44) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"slot" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fee_events_positive_amount_check" CHECK ("fee_events"."amount_base_units" > 0),
	CONSTRAINT "fee_events_kind_check" CHECK ("fee_events"."kind" = 'dbc_creator_quote')
);
--> statement-breakpoint
ALTER TABLE "fee_events" ADD CONSTRAINT "fee_events_github_repo_id_repositories_github_repo_id_fk" FOREIGN KEY ("github_repo_id") REFERENCES "public"."repositories"("github_repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fee_events_chain_event_unique" ON "fee_events" USING btree ("signature","event_index","kind");