CREATE TABLE "damm_trade_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"pool" varchar(44) NOT NULL,
	"signature" varchar(88) NOT NULL,
	"event_index" integer NOT NULL,
	"slot" bigint NOT NULL,
	"traded_at" timestamp with time zone NOT NULL,
	"quote_amount" bigint NOT NULL,
	"direction" varchar(4) NOT NULL,
	"evidence" text NOT NULL,
	CONSTRAINT "damm_trade_amount_check" CHECK ("damm_trade_events"."quote_amount">0),
	CONSTRAINT "damm_trade_direction_check" CHECK ("damm_trade_events"."direction" in ('buy','sell'))
);
--> statement-breakpoint
CREATE TABLE "graduation_alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_key" text NOT NULL,
	"github_repo_id" bigint,
	"kind" varchar(48) NOT NULL,
	"detail" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" text
);
--> statement-breakpoint
CREATE TABLE "graduation_events" (
	"github_repo_id" bigint PRIMARY KEY NOT NULL,
	"signature" varchar(88) NOT NULL,
	"pool" varchar(44) NOT NULL,
	"slot" bigint NOT NULL,
	"evidence_hash" varchar(64) NOT NULL,
	"evidence" text NOT NULL,
	"previous_observation" text,
	"reconciliation" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "graduation_observations" (
	"github_repo_id" bigint PRIMARY KEY NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"status" varchar(32) NOT NULL,
	"observation" text,
	"reconciliation" text,
	"error_code" text
);
--> statement-breakpoint
ALTER TABLE "damm_trade_events" ADD CONSTRAINT "damm_trade_events_github_repo_id_markets_github_repo_id_fk" FOREIGN KEY ("github_repo_id") REFERENCES "public"."markets"("github_repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graduation_alerts" ADD CONSTRAINT "graduation_alerts_github_repo_id_markets_github_repo_id_fk" FOREIGN KEY ("github_repo_id") REFERENCES "public"."markets"("github_repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graduation_events" ADD CONSTRAINT "graduation_events_github_repo_id_markets_github_repo_id_fk" FOREIGN KEY ("github_repo_id") REFERENCES "public"."markets"("github_repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graduation_observations" ADD CONSTRAINT "graduation_observations_github_repo_id_markets_github_repo_id_fk" FOREIGN KEY ("github_repo_id") REFERENCES "public"."markets"("github_repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "damm_trade_chain_event_unique" ON "damm_trade_events" USING btree ("signature","event_index");--> statement-breakpoint
CREATE UNIQUE INDEX "graduation_alert_event_unique" ON "graduation_alerts" USING btree ("event_key");--> statement-breakpoint
CREATE UNIQUE INDEX "graduation_signature_unique" ON "graduation_events" USING btree ("signature","github_repo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "graduation_pool_unique" ON "graduation_events" USING btree ("pool");