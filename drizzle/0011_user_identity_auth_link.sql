-- Codex-Review #17a: user_identity.auth_user_id koppelt die Domänen-Identität
-- an den better-auth-Nutzer (Spalte + UNIQUE kommen aus 0010). Diese Migration
-- sichert die Unveränderlichkeit dieser Kopplung ab.
--
-- ═══════════════════════════════════════════════════════════════════════
-- BEFUND (empirisch verifiziert, siehe final-fix-report.md F11):
--
-- user_identity trägt RLS mit FORCE und hat NUR eine SELECT-Policy
-- (membership-basiert) und eine INSERT-Policy (drizzle/0002). PostgreSQL
-- verlangt für JEDES `insert ... on conflict ...` — auch für DO NOTHING —
-- dass die kollidierende Zeile unter den SELECT-Policies sichtbar ist
-- (WCO_RLS_CONFLICT_CHECK). Beim Erst-Login existiert aber noch keine
-- Membership und kein app.workspace_id, also ist NICHTS sichtbar. Ergebnis:
--
--   insert into user_identity (...) on conflict (lower(email)) do nothing
--   -> ERROR: new row violates row-level security policy for table "user_identity"
--
-- Das galt bereits für den ALTEN Hook (.onConflictDoNothing()) — der wäre bei
-- jedem Erst-Login gescheitert. Der Hook nutzt deshalb jetzt einen schlichten
-- INSERT (der funktioniert, siehe lib/auth.ts).
--
-- Das idempotente Nachtragen von auth_user_id auf eine BEREITS existierende
-- Identität (eingeladen, aber noch nie eingeloggt — ein M1-Fall) ist damit
-- offen und im Report als BLOCKED ausgewiesen: es braucht eine bewusste
-- Entscheidung über eine eng gefasste Bootstrap-Policy bzw. eine eigene
-- Auth-DB-Rolle (docs/adr/0003-db-rollen-trennung.md), keine improvisierte
-- Aufweichung der Identity-RLS.
-- ═══════════════════════════════════════════════════════════════════════
--
-- Der Trigger unten ist die STRUKTURELLE Absicherung für genau diese offene
-- Entscheidung: er wirkt unabhängig von RLS und auch gegen den Tabellen-Owner.
-- Solange keine UPDATE-Policy existiert, ist er nicht erreichbar (RLS verbietet
-- UPDATE vollständig) — sobald aber jemand eine hinzufügt, um den Backfill zu
-- bauen, gilt automatisch:
--   * id, email und created_at bleiben unveränderlich (append-only-Zusage
--     aus drizzle/0002 bleibt gültig),
--   * auth_user_id lässt sich EINMAL setzen und danach nie mehr umbiegen
--     (kein Übernehmen einer fremden Identität durch Re-Pointing).
--
-- WICHTIG für künftige Spalten: der Trigger führt die unveränderlichen Spalten
-- NAMENTLICH. Wer user_identity um eine Spalte erweitert, MUSS hier
-- entscheiden, ob sie unveränderlich ist, und sie ggf. eintragen.
create or replace function user_identity_link_auth_only() returns trigger language plpgsql as $$
begin
  if new.id is distinct from old.id
     or new.email is distinct from old.email
     or new.created_at is distinct from old.created_at then
    raise exception 'user_identity ist append-only — nur auth_user_id darf nachgetragen werden';
  end if;
  if old.auth_user_id is not null and new.auth_user_id is distinct from old.auth_user_id then
    raise exception 'user_identity.auth_user_id ist bereits gesetzt und unveraenderlich';
  end if;
  return new;
end $$;

create trigger user_identity_link_auth_only before update on user_identity
  for each row execute function user_identity_link_auth_only();
