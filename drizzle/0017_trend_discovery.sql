-- P6 uses the existing canonical launch attribution. Once indexed, it cannot
-- be reassigned or retroactively enrolled under a different discovery policy.
CREATE FUNCTION protect_indexed_discoverer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.indexed_at IS NOT NULL AND (
    ROW(NEW.github_repo_id,NEW.launcher_wallet,NEW.creator_wallet,NEW.mint,NEW.pool,NEW.launch_signature,NEW.discovery_version,NEW.launch_slot,NEW.launch_finality)
    IS DISTINCT FROM ROW(OLD.github_repo_id,OLD.launcher_wallet,OLD.creator_wallet,OLD.mint,OLD.pool,OLD.launch_signature,OLD.discovery_version,OLD.launch_slot,OLD.launch_finality)
    OR (OLD.launch_block_time IS NOT NULL AND NEW.launch_block_time IS DISTINCT FROM OLD.launch_block_time)
    OR NEW.indexed_at IS NULL
  ) THEN RAISE EXCEPTION 'Indexed launch attribution is immutable'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER protect_indexed_discoverer BEFORE UPDATE ON markets FOR EACH ROW EXECUTE FUNCTION protect_indexed_discoverer();
--> statement-breakpoint
CREATE TABLE "trend_candidates" (
	"github_repo_id" bigint PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"description" text,
	"state" varchar(16) DEFAULT 'detected' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error" text,
	"approved_config" varchar(44),
	"approved_discovery_version" integer,
	"approved_window_ms" bigint,
	"approved_at" timestamp with time zone,
	CONSTRAINT "trend_state_check" CHECK ("trend_candidates"."state" in ('detected','reviewed','approved','launched','active','rejected','duplicate'))
);
--> statement-breakpoint
CREATE TABLE "trend_launches" (
	"mint" varchar(44) PRIMARY KEY NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"wallet" varchar(44) NOT NULL,
	"config" varchar(44) NOT NULL,
	"candidate_revision" integer NOT NULL,
	"evidence" text NOT NULL,
	"prepared_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trend_observations" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"evidence" text NOT NULL,
	"evidence_hash" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trend_reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"from_state" varchar(16) NOT NULL,
	"to_state" varchar(16) NOT NULL,
	"operator" text NOT NULL,
	"evidence" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trend_signals" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"source" varchar(32) NOT NULL,
	"url" text NOT NULL,
	"note" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"operator" text
);
--> statement-breakpoint
CREATE TABLE "trend_source_health" (
	"source" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"detail" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "trend_launches" ADD CONSTRAINT "trend_launches_github_repo_id_trend_candidates_github_repo_id_fk" FOREIGN KEY ("github_repo_id") REFERENCES "public"."trend_candidates"("github_repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trend_observations" ADD CONSTRAINT "trend_observations_github_repo_id_trend_candidates_github_repo_id_fk" FOREIGN KEY ("github_repo_id") REFERENCES "public"."trend_candidates"("github_repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trend_reviews" ADD CONSTRAINT "trend_reviews_github_repo_id_trend_candidates_github_repo_id_fk" FOREIGN KEY ("github_repo_id") REFERENCES "public"."trend_candidates"("github_repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trend_signals" ADD CONSTRAINT "trend_signals_github_repo_id_trend_candidates_github_repo_id_fk" FOREIGN KEY ("github_repo_id") REFERENCES "public"."trend_candidates"("github_repo_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trend_observation_unique" ON "trend_observations" USING btree ("github_repo_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "trend_signal_unique" ON "trend_signals" USING btree ("github_repo_id","source","url");
