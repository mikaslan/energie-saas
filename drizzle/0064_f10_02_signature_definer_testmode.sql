-- ═══════════════════════════════════════════════════════════════════════
-- F10.2 Slice B Nachzug (Gatefix-Pass 3): öffentliche Signatur-DEFINER
-- im Ein-Rollen-Testmodus funktionsfähig machen.
--
-- Kontext: Die M2-04-Token-DEFINER (sign/revoke/view) waren in
-- test-legacy-single NIE lauffähig, weil die RESTRICTIVE-Actor-Policies
-- auf signature_request/signature_view_log den app_owner-Escape-Hatch
-- tragen — der aber nur greift, wenn CURRENT_USER = 'app_owner' ist.
-- Die Funktionen gehörten dort der Migrationsrolle (app_test), also
-- filterte RLS jede Zeile weg: sign lieferte not_found (nachgemessen
-- via f1003, Hash stimmte, Locator stimmte). Der M2-04-Service-Test
-- deckte nur create/withdraw ab — der Sign-Pfad war ungetestet.
--
-- Fix analog 0056/0059/0062: Owner-Tanz NUR im Testmodus (Strict läuft
-- die Migration ohnehin als app_owner und besitzt die Tabellen), plus
-- Grants für alle Relationen, die der öffentliche Pfad anfasst.
-- ═══════════════════════════════════════════════════════════════════════
DO $f1004_signature_owner_dance$
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
    ALTER FUNCTION public.sign_signature_by_token(bytea, text, text, bytea)
      OWNER TO app_owner;
    ALTER FUNCTION public.revoke_signature_by_customer(bytea)
      OWNER TO app_owner;
    ALTER FUNCTION public.record_signature_view(bytea)
      OWNER TO app_owner;
    REVOKE CREATE ON SCHEMA public FROM app_owner;
    SET ROLE app_owner;
    REVOKE EXECUTE ON FUNCTION public.sign_signature_by_token(bytea, text, text, bytea)
      FROM PUBLIC;
    REVOKE EXECUTE ON FUNCTION public.revoke_signature_by_customer(bytea)
      FROM PUBLIC;
    REVOKE EXECUTE ON FUNCTION public.record_signature_view(bytea)
      FROM PUBLIC;
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION public.sign_signature_by_token(bytea, text, text, bytea),
        public.revoke_signature_by_customer(bytea),
        public.record_signature_view(bytea) TO %I',
      v_app
    );
    RESET ROLE;
    EXECUTE pg_catalog.format(
      'GRANT app_owner TO %I WITH inherit false, set false', v_app
    );
    -- Relationen des oeffentlichen Pfads (Strict: Tabellen-Ownership):
    GRANT SELECT ON public.signature_token_locator TO app_owner;
    GRANT SELECT, UPDATE ON public.signature_request TO app_owner;
    GRANT SELECT, INSERT ON public.signature_attestation TO app_owner;
    GRANT SELECT, INSERT ON public.signature_view_log TO app_owner;
    -- Signer-Namens-Aufloesung liest Offer + Kontakt:
    GRANT SELECT ON public.offer TO app_owner;
    GRANT SELECT ON public.contact TO app_owner;
    -- RESTRICTIVE-Actor-Policies evaluieren die Helfer als abfragende
    -- Rolle (app_owner) — ohne EXECUTE 42501 vor dem Escape-Hatch:
    GRANT EXECUTE ON FUNCTION
      public._m204_actor_can_read_signatures(uuid),
      public._m204_actor_can_write_signatures(uuid),
      public._m204_actor_signature_role(uuid)
      TO app_owner;
  END IF;
END
$f1004_signature_owner_dance$;--> statement-breakpoint
