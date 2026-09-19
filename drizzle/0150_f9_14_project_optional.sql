ALTER TABLE "time_entry" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "time_entry_revision" ALTER COLUMN "project_id" DROP NOT NULL;