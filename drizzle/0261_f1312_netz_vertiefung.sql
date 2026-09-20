ALTER TABLE "grid_registration" DROP CONSTRAINT "grid_registration_status_ck";--> statement-breakpoint
ALTER TABLE "grid_registration" ADD COLUMN "fertigmeldung_due" date;--> statement-breakpoint
ALTER TABLE "grid_registration" ADD COLUMN "mastr_addon" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "grid_registration" ADD COLUMN "wallbox_addon" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "grid_registration" ADD COLUMN "addon_produkt" text;--> statement-breakpoint
ALTER TABLE "grid_registration" ADD COLUMN "addon_betrag_cents" integer;--> statement-breakpoint
ALTER TABLE "grid_registration" ADD CONSTRAINT "grid_registration_addon_produkt_ck" CHECK ("grid_registration"."addon_produkt" is null or "grid_registration"."addon_produkt" in ('pv', 'wp'));--> statement-breakpoint
ALTER TABLE "grid_registration" ADD CONSTRAINT "grid_registration_addon_betrag_ck" CHECK ("grid_registration"."addon_betrag_cents" is null or "grid_registration"."addon_betrag_cents" >= 0);--> statement-breakpoint
ALTER TABLE "grid_registration" ADD CONSTRAINT "grid_registration_status_ck" CHECK ("grid_registration"."status" in (
        'vorbereitung', 'eingereicht', 'rueckfrage', 'genehmigt',
        'einspeisezusage', 'fertiggemeldet', 'abgeschlossen', 'storniert'
      ));