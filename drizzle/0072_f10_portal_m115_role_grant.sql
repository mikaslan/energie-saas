-- ═══════════════════════════════════════════════════════════════════════
-- F10.2 Nachzug (Follow-up zu 0071): der M1-15-Lese-Helfer ruft intern
-- _m115_actor_appointment_role() auf — ohne EXECUTE scheitert der
-- Portal-Resolve weiterhin mit 42501, sobald Terminzeilen existieren
-- (nachgemessen: f1002-DB-01; leere Termine blieben still, f1001 gruen).
-- Muster: 0071/0065.
-- ═══════════════════════════════════════════════════════════════════════
DO $f1002_m115_role_grant$
BEGIN
  IF pg_catalog.to_regrole('app_owner') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION
      public._m115_actor_appointment_role(uuid)
      TO app_owner;
  END IF;
END
$f1002_m115_role_grant$;--> statement-breakpoint
