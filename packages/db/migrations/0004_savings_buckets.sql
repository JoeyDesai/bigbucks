ALTER TABLE "categories" ADD COLUMN "bucket_kind" text DEFAULT 'spending' NOT NULL;--> statement-breakpoint
ALTER TABLE "categories" ADD COLUMN "savings_target_milli" bigint;