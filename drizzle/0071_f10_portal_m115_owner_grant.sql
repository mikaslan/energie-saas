-- ═══════════════════════════════════════════════════════════════════════
-- F10.1/F10.2 Nachzug: Portal-Resolver (SECURITY DEFINER, Owner app_owner
-- seit 0059) braucht EXECUTE auf die M1-15-Actor-Helfer. Die RESTRICTIVE-
-- SELECT-Policies auf project_appointment(_attendee) rufen
-- _m115_actor_can_read_appointments() auf, BEVOR der app_owner-Escape-Hatch
-- greifen kann — ohne Grant scheitert jeder Resolve mit 42501
-- (permission denied for function, nachgemessen via PortalPersistenceError-
-- Cause). Muster: 0065 (M2-04-Helfer-Grants an app_owner).
-- Rollen-Pruefung im Service-Layer bleibt unberuehrt; kein Orakel-Leak
-- (Fehlerbild des Resolvers aendert sich nicht, er wirft nur nicht mehr).
-- ═══════════════════════════════════════════════════════════════════════
DO $f1001_m115_owner_grant$
BEGIN
  IF pg_catalog.to_regrole('app_owner') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION
      public._m115_actor_can_read_appointments(uuid)
      TO app_owner;
  END IF;
END
$f1001_m115_owner_grant$;--> statement-breakpoint
