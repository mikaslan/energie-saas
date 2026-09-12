-- ═══════════════════════════════════════════════════════════════════════
-- F10-12 Download-Protokollierung (Katalog F10.7 „Download-
-- Protokollierung/Audit"): Jeder ausgelieferte Portal-Dokument-
-- Download schreibt genau eine Zeile in portal_download_log
-- (Invite + Issuance + Zeitpunkt). Nur erfolgreiche Auslieferungen
-- werden protokolliert (404/Integritätsfehler schreiben nichts —
-- kein Orakel, kein Rauschen). Intern sichtbar als Download-Zähler
-- je aktivem Invite (getPortalStatus, project.read).
-- Rechte: GRANT SELECT/INSERT an app_owner für die DEFINER-Funktion
-- (Muster file_request_upload); RLS tenant_isolation + FORCE wie
-- portal_view_log; kein DELETE-Grant, keine neue Permission.
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE "portal_download_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"portal_invite_id" uuid NOT NULL,
	"issuance_id" uuid NOT NULL,
	"downloaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "portal_download_log_downloaded_at_ck" CHECK (pg_catalog.isfinite("portal_download_log"."downloaded_at"))
);
--> statement-breakpoint
ALTER TABLE "portal_download_log" ADD CONSTRAINT "portal_download_log_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_download_log" ADD CONSTRAINT "portal_download_log_invite_fk" FOREIGN KEY ("workspace_id","portal_invite_id") REFERENCES "public"."portal_invite"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "portal_download_log_ws_id_uq" ON "portal_download_log" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "portal_download_log_ws_invite_idx" ON "portal_download_log" USING btree ("workspace_id","portal_invite_id","downloaded_at","id");--> statement-breakpoint
ALTER TABLE public.portal_download_log ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.portal_download_log FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON public.portal_download_log
  USING (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = NULLIF(pg_catalog.current_setting('app.workspace_id', true), '')::uuid);
--> statement-breakpoint
-- F10-12: Download-Insert in der Artefakt-Kapsel (gleiche Sichtbarkeit
-- wie F10-07: nur gültiger Invite + freigegebene Issuance ohne Rückzug
-- erreicht den Insert; null Zeilen schreiben nichts). Owner-Tanz wie
-- 0135 (Muster 0116): CREATE OR REPLACE scheitert als Nicht-Owner;
-- Strict migriert ohnehin als app_owner.
DO $f1012_replace_artifact$
DECLARE
  v_app name := current_user;
BEGIN
  IF v_app = 'app_owner' THEN
    EXECUTE $ddl$CREATE OR REPLACE FUNCTION public.read_portal_issuance_artifact(
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
AS $f1012_read_portal_issuance_artifact$
DECLARE
  located_workspace_id uuid;
  located_invite_id uuid;
  invite_row public.portal_invite%ROWTYPE;
  downloaded_issuance_id uuid;
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

  -- F10-12: genau eine Protokollzeile je ausgelieferter Fassung
  -- (Auslieferungsbedingung = gleiche Sichtbarkeit wie unten).
  SELECT issuance.id
    INTO downloaded_issuance_id
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
         )
   LIMIT 1;
  IF FOUND THEN
    INSERT INTO public.portal_download_log (
      workspace_id, portal_invite_id, issuance_id, downloaded_at
    ) VALUES (
      invite_row.workspace_id, invite_row.id,
      downloaded_issuance_id, mutation_time
    );
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
$f1012_read_portal_issuance_artifact$;$ddl$;
  ELSE
    EXECUTE pg_catalog.format(
      'GRANT app_owner TO %I WITH inherit false, set true', v_app
    );
    GRANT CREATE ON SCHEMA public TO app_owner;
    -- Definer-Rechte fuer den Download-Insert (Muster file_request_upload:
    -- ohne Tabellen-Grant scheitert der Insert mit 42501).
    GRANT SELECT, INSERT ON public.portal_download_log TO app_owner;
    SET ROLE app_owner;
    EXECUTE $ddl$CREATE OR REPLACE FUNCTION public.read_portal_issuance_artifact(
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
AS $f1012_read_portal_issuance_artifact$
DECLARE
  located_workspace_id uuid;
  located_invite_id uuid;
  invite_row public.portal_invite%ROWTYPE;
  downloaded_issuance_id uuid;
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

  -- F10-12: genau eine Protokollzeile je ausgelieferter Fassung
  -- (Auslieferungsbedingung = gleiche Sichtbarkeit wie unten).
  SELECT issuance.id
    INTO downloaded_issuance_id
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
         )
   LIMIT 1;
  IF FOUND THEN
    INSERT INTO public.portal_download_log (
      workspace_id, portal_invite_id, issuance_id, downloaded_at
    ) VALUES (
      invite_row.workspace_id, invite_row.id,
      downloaded_issuance_id, mutation_time
    );
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
$f1012_read_portal_issuance_artifact$;$ddl$;
    RESET ROLE;
    REVOKE CREATE ON SCHEMA public FROM app_owner;
    EXECUTE pg_catalog.format(
      'GRANT app_owner TO %I WITH inherit false, set false', v_app
    );
  END IF;
END
$f1012_replace_artifact$;
--> statement-breakpoint
DO $f1012_download_log_grants$
BEGIN
  IF pg_catalog.to_regrole('app_owner') IS NOT NULL THEN
    -- F10-12: Download-Protokoll der DEFINER-Funktion (Muster
    -- file_request_upload: SELECT + INSERT, kein DELETE).
    GRANT SELECT, INSERT ON public.portal_download_log TO app_owner;
  END IF;
  IF pg_catalog.to_regrole('app_runtime') IS NOT NULL
     AND pg_catalog.to_regrole('app_owner') IS NOT NULL THEN
    GRANT SELECT ON public.portal_download_log TO app_runtime;
  END IF;
END
$f1012_download_log_grants$;
