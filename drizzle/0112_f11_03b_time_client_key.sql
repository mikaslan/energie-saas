ALTER TABLE "time_entry" ADD COLUMN "client_key" uuid;--> statement-breakpoint
ALTER TABLE "time_entry" ADD CONSTRAINT "time_entry_ws_client_key_uq" UNIQUE("workspace_id","client_key");--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F11-03b: Idempotenz-Schlüssel für Offline-Replay manueller Zeiteinträge
-- (je Entwurf genau einmal clientseitig vergeben; NULL = klassischer
-- Pfad, mehrfach zulässig). Keine RLS-/Grant-Änderung (Bestandstabelle,
-- Vertrag unverändert). Replay gibt den Bestand zurück statt zu
-- duplizieren (keine doppelten Events/Audits).
-- ═══════════════════════════════════════════════════════════════════════
