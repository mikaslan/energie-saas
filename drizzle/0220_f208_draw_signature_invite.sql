-- ═══════════════════════════════════════════════════════════════════════
-- F2.8 Portal-Draw-Signatur: Invite-Kapsel für Annehmen per gezeichneter
-- Unterschrift (Modus draw + PNG-Artefakt). Muster 0140
-- sign_signature_by_invite (Invite über portal_token_locator prüfen,
-- Beleg gehört zum Invite-Projekt — sonst uniform not_found, kein
-- Orakel). Bei Treffer Delegation an die verifizierte Terminalkante
-- sign_signature_by_token (Modus draw, Artefakt); Won-Kopplung, Events
-- und Audit laufen dort bzw. per Trigger (F2.8b). Envelope (MIME/Magic/
-- Size) prueft dieser Wrapper fail-soft, SHA-/Laengen-Bindung der
-- signature_attestation_artifact_ck. Keine zweite Terminalimplementierung.
-- ═══════════════════════════════════════════════════════════════════════
CREATE FUNCTION public.sign_signature_draw_by_invite(
  requested_invite_token_hash bytea,
  requested_issuance_id uuid,
  requested_artifact_mime_type text,
  requested_artifact_bytes bytea
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $f208_sign_draw_invite$
DECLARE
  located_workspace_id uuid;
  located_invite_id uuid;
  invite_row public.portal_invite%ROWTYPE;
  request_token_hash bytea;
  mutation_time timestamptz := pg_catalog.statement_timestamp();
BEGIN
  PERFORM pg_catalog.set_config('app.actor_id', '', true);

  SELECT locator.workspace_id, locator.portal_invite_id
    INTO located_workspace_id, located_invite_id
    FROM public.portal_token_locator AS locator
   WHERE locator.token_hash = requested_invite_token_hash;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  PERFORM pg_catalog.set_config('app.workspace_id', located_workspace_id::text, true);

  SELECT * INTO invite_row
    FROM public.portal_invite
   WHERE workspace_id = located_workspace_id
     AND id = located_invite_id
     FOR SHARE;
  -- Entzogen/abgelaufen: fail-closed ohne Mutation (kein Orakel).
  IF NOT FOUND OR invite_row.status <> 'active'
     OR invite_row.expires_at <= mutation_time THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  -- Beleg gehört zum Invite-Projekt (eine Issuance ↔ höchstens ein
  -- Request: signature_request_ws_issuance_uq).
  SELECT request_record.token_hash INTO request_token_hash
    FROM public.signature_request AS request_record
   WHERE request_record.workspace_id = located_workspace_id
     AND request_record.issuance_id = requested_issuance_id
     AND request_record.project_id = invite_row.project_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  -- Draw-Envelope: MIME strikt image/png, PNG-Magic (8-Byte-Signatur),
  -- Size 1..524288. Verletzt fail-soft validation_error (kein Orakel,
  -- keine CHECK-Exception); Service mappt auf SignatureValidationError.
  IF requested_artifact_mime_type IS DISTINCT FROM 'image/png'
     OR requested_artifact_bytes IS NULL
     OR pg_catalog.octet_length(requested_artifact_bytes) NOT BETWEEN 1 AND 524288
     OR pg_catalog.substr(requested_artifact_bytes, 1, 8) <> '\x89504E470D0A1A0A'::bytea THEN
    RETURN pg_catalog.jsonb_build_object('status', 'validation_error');
  END IF;

  -- Delegation: Expiry, Signer, Attestierung, Won-Trigger laufen in der
  -- verifizierten Kapsel (Modus fest draw, PNG-Artefakt).
  RETURN public.sign_signature_by_token(
    request_token_hash, 'draw', requested_artifact_mime_type, requested_artifact_bytes
  );
END
$f208_sign_draw_invite$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.sign_signature_draw_by_invite(bytea, uuid, text, bytea) FROM PUBLIC;--> statement-breakpoint

-- Owner-Tanz NUR im Testmodus (Muster 0140): Ohne app_owner-Ownership
-- scheitert der Invite-Lookup an der Actor-Restrictive-Policy
-- (portal_invite, FORCE RLS).
DO $f208_sign_draw_invite_owner_dance$
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
    ALTER FUNCTION public.sign_signature_draw_by_invite(
      bytea, uuid, text, bytea
    ) OWNER TO app_owner;
    REVOKE CREATE ON SCHEMA public FROM app_owner;
    SET ROLE app_owner;
    REVOKE ALL ON FUNCTION public.sign_signature_draw_by_invite(
      bytea, uuid, text, bytea
    ) FROM PUBLIC;
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION public.sign_signature_draw_by_invite(
        bytea, uuid, text, bytea
      ) TO %I',
      v_app
    );
    RESET ROLE;
    EXECUTE pg_catalog.format(
      'GRANT app_owner TO %I WITH inherit false, set false', v_app
    );
    -- Relationen des oeffentlichen Pfads (Strict: Tabellen-Ownership;
    -- Muster 0140 — ohne scheitert der Invite-Lookup an FORCE RLS).
    GRANT SELECT ON public.portal_token_locator TO app_owner;
    GRANT SELECT ON public.portal_invite TO app_owner;
    GRANT SELECT ON public.signature_request TO app_owner;
    GRANT SELECT ON public.signature_token_locator TO app_owner;
  END IF;
END
$f208_sign_draw_invite_owner_dance$;--> statement-breakpoint

-- Oeffentliche Ausfuehrung rollenunabhaengig (Muster 0140):
-- Der Owner-Tanz oben greift nur im Testmodus (v_app); Strict migriert
-- als app_owner und wuerde den EXECUTE-Grant sonst nie vergeben.
DO $f208_sign_draw_invite_acl$
BEGIN
  IF pg_catalog.to_regrole('app_runtime') IS NOT NULL THEN
    GRANT EXECUTE ON FUNCTION public.sign_signature_draw_by_invite(
      bytea, uuid, text, bytea
    ) TO app_runtime;
  END IF;
END
$f208_sign_draw_invite_acl$;--> statement-breakpoint
