-- ═══════════════════════════════════════════════════════════════════════
-- F10-07 Portal-Dokument-Download (My-Files-Rest): token-gebundener
-- Lesezugriff auf freigegebene Ausstellungsfassungen. Gibt die
-- Artefakt-Zeile genau dann zurück, wenn (a) der Invite zum Token
-- gültig ist (aktiv, nicht abgelaufen), (b) die Issuance im selben
-- Mandat+Projekt liegt, (c) sie der Portal-Projektion entspricht
-- (2/2 Freigaben, kein Rückzug — gleiche Bedingungen wie
-- resolve_portal_public_view), sonst null Zeilen (kein Orakel).
-- Read-only (kein Event, kein Touch). Integrität (SHA/Größe/%PDF)
-- prüft der Service/Route wie am internen Pfad.
-- ═══════════════════════════════════════════════════════════════════════
CREATE FUNCTION public.read_portal_issuance_artifact(
  requested_token_hash bytea,
  requested_issuance_id uuid
)
RETURNS TABLE (
  offer_number text,
  document_date date,
  artifact_mime_type text,
  artifact_sha256_hex text,
  artifact_size_bytes integer,
  artifact_bytes bytea
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $f1007_read_portal_issuance_artifact$
DECLARE
  located_workspace_id uuid;
  located_invite_id uuid;
  invite_row public.portal_invite%ROWTYPE;
  mutation_time timestamptz := pg_catalog.statement_timestamp();
BEGIN
  PERFORM pg_catalog.set_config('app.actor_id', '', true);

  SELECT locator.workspace_id, locator.portal_invite_id
    INTO located_workspace_id, located_invite_id
    FROM public.portal_token_locator AS locator
   WHERE locator.token_hash = requested_token_hash;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  PERFORM pg_catalog.set_config('app.workspace_id', located_workspace_id::text, true);

  SELECT *
    INTO invite_row
    FROM public.portal_invite
   WHERE workspace_id = located_workspace_id
     AND id = located_invite_id
   FOR SHARE;
  -- Abgelaufen/entzogen: fail-closed ohne Unterschied (kein Orakel).
  IF NOT FOUND OR invite_row.status <> 'active'
     OR invite_row.expires_at <= mutation_time THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT issuance.offer_number,
         issuance.document_date,
         issuance.artifact_mime_type,
         pg_catalog.encode(issuance.artifact_sha256, 'hex'),
         issuance.artifact_size_bytes,
         issuance.artifact_bytes
    FROM public.offer_issuance AS issuance
   WHERE issuance.workspace_id = invite_row.workspace_id
     AND issuance.project_id = invite_row.project_id
     AND issuance.id = requested_issuance_id
     AND issuance.artifact_bytes IS NOT NULL
     AND issuance.artifact_sha256 IS NOT NULL
     AND issuance.artifact_size_bytes IS NOT NULL
     AND (
           SELECT pg_catalog.count(*)
             FROM public.offer_issuance_approval AS approval
            WHERE approval.workspace_id = issuance.workspace_id
              AND approval.issuance_id = issuance.id
         ) = 2
     AND NOT EXISTS (
           SELECT 1
             FROM public.offer_issuance_withdrawal AS withdrawal
            WHERE withdrawal.workspace_id = issuance.workspace_id
              AND withdrawal.issuance_id = issuance.id
         );
END;
$f1007_read_portal_issuance_artifact$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.read_portal_issuance_artifact(bytea, uuid) FROM PUBLIC;--> statement-breakpoint
-- Owner-Tanz NUR im Testmodus (Muster 0064/0104 — dort identischer Befund:
-- RESTRICTIVE-Actor-Policies tragen den app_owner-Escape-Hatch, der nur
-- greift, wenn CURRENT_USER = 'app_owner' ist; Strict migriert ohnehin
-- als app_owner).
DO $f1007_read_artifact_owner_dance$
DECLARE
  v_app name := current_user;
BEGIN
  IF v_app <> 'app_owner' THEN
    IF pg_catalog.to_regrole('app_owner') IS NULL THEN
      CREATE ROLE app_owner nologin noinherit nosuperuser nobypassrls
        nocreatedb nocreaterole noreplication;
    END IF;
    EXECUTE pg_catalog.format(
      'GRANT app_owner TO %I WITH inherit false, set true', v_app
    );
    GRANT CREATE ON SCHEMA public TO app_owner;
    ALTER FUNCTION public.read_portal_issuance_artifact(
      bytea, uuid
    ) OWNER TO app_owner;
    REVOKE CREATE ON SCHEMA public FROM app_owner;
    SET ROLE app_owner;
    REVOKE ALL ON FUNCTION public.read_portal_issuance_artifact(
      bytea, uuid
    ) FROM PUBLIC;
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION public.read_portal_issuance_artifact(
        bytea, uuid
      ) TO %I',
      v_app
    );
    RESET ROLE;
    EXECUTE pg_catalog.format(
      'GRANT app_owner TO %I WITH inherit false, set false', v_app
    );
    -- Relationen des oeffentlichen Pfads (Strict: Tabellen-Ownership):
    GRANT SELECT ON public.portal_token_locator TO app_owner;
    GRANT SELECT ON public.portal_invite TO app_owner;
    GRANT SELECT ON public.offer_issuance TO app_owner;
    GRANT SELECT ON public.offer_issuance_approval TO app_owner;
  END IF;
END
$f1007_read_artifact_owner_dance$;--> statement-breakpoint

DO $f1007_read_artifact_acl$
BEGIN
  IF pg_catalog.to_regrole('app_runtime') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.read_portal_issuance_artifact(
      bytea, uuid
    ) TO app_runtime;
  END IF;
END
$f1007_read_artifact_acl$;
