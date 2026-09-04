ALTER TABLE "time_entry" ADD COLUMN "start_lat" double precision;--> statement-breakpoint
ALTER TABLE "time_entry" ADD COLUMN "start_lng" double precision;--> statement-breakpoint
ALTER TABLE "time_entry_revision" ADD COLUMN "start_lat" double precision;--> statement-breakpoint
ALTER TABLE "time_entry_revision" ADD COLUMN "start_lng" double precision;--> statement-breakpoint
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_gps_ck" CHECK (("time_entry"."start_lat" is null and "time_entry"."start_lng" is null) or ("time_entry"."start_lat" between -90 and 90 and "time_entry"."start_lng" between -180 and 180));--> statement-breakpoint
ALTER TABLE "time_entry_revision" ADD CONSTRAINT "time_entry_revision_gps_ck" CHECK (("time_entry_revision"."start_lat" is null and "time_entry_revision"."start_lng" is null) or ("time_entry_revision"."start_lat" between -90 and 90 and "time_entry_revision"."start_lng" between -180 and 180));