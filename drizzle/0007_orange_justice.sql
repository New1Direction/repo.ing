CREATE TABLE "trade_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"pool" varchar(44) NOT NULL,
	"signature" varchar(88) NOT NULL,
	"event_index" integer NOT NULL,
	"slot" bigint NOT NULL,
	"traded_at" timestamp with time zone NOT NULL,
	"direction" varchar(4) NOT NULL,
	"input_base_units" varchar(20) NOT NULL,
	"output_base_units" varchar(20) NOT NULL,
	"next_sqrt_price" varchar(40) NOT NULL,
	CONSTRAINT "trade_events_direction_check" CHECK ("trade_events"."direction" in ('buy', 'sell'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "trade_events_chain_event_unique" ON "trade_events" USING btree ("signature","event_index");