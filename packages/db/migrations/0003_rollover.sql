ALTER TABLE "categories" ADD COLUMN "rollover" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "rollover_from" date;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "rollover_opening_milli" bigint DEFAULT 0 NOT NULL;