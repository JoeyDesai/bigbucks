ALTER TABLE "categories" ADD COLUMN "icon" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "accent" text;--> statement-breakpoint
-- Backfill the household defaults (setup:household uses the same): admins blue, members pink.
UPDATE "users" SET "accent" = CASE WHEN "role" = 'admin' THEN 'blue' ELSE 'pink' END WHERE "accent" IS NULL;
