ALTER TABLE "project_note" ADD COLUMN "client_key" uuid;--> statement-breakpoint
ALTER TABLE "project_note" ADD CONSTRAINT "project_note_ws_client_key_uq" UNIQUE("workspace_id","client_key");--> statement-breakpoint
-- ═══════════════════════════════════════════════════════════════════════
-- F11-03a: Idempotenz-Schlüssel für Offline-Replay (je Entwurf genau
-- einmal clientseitig vergeben; NULL = klassischer Pfad, mehrfach
-- zulässig). Keine RLS-/Grant-Änderung (Bestandstabelle, Vertrag
-- unverändert). Replay gibt den Bestand zurück statt zu duplizieren
-- (keine doppelten Events/Mentions).
-- ═══════════════════════════════════════════════════════════════════════
