-- Codex-Review #17a: user_identity.auth_user_id koppelt die Domänen-Identität
-- an den better-auth-Nutzer (Spalte + UNIQUE kommen aus 0010). Diese Migration
-- sichert die Unveränderlichkeit dieser Kopplung ab.
--
-- ═══════════════════════════════════════════════════════════════════════
-- ÜBERHOLT — KORRIGIERT DURCH drizzle/0014_identity_reconcile.sql.
--
-- Hier stand: „PostgreSQL verlangt für JEDES `insert … on conflict …` — auch
-- für DO NOTHING — dass die kollidierende Zeile unter den SELECT-Policies
-- sichtbar ist". Das ist in dieser Allgemeinheit FALSCH. Die SELECT-Prüfung
-- greift bei `do nothing` nur mit SPEZIFIZIERTEM Arbiter
-- (`on conflict (lower(email)) do nothing`); targetloses `on conflict do
-- nothing` — was Drizzles `.onConflictDoNothing()` ohne `target` erzeugt —
-- prüft sie nicht.
--
-- Der echte Defekt war ein anderer: weder ein Plain-Insert noch ein
-- `do nothing` kann eine BESTEHENDE Identität koppeln, und das dafür nötige
-- `do update` scheiterte an der schlicht nicht vorhandenen UPDATE-Policy
-- (RLS mit FORCE verbietet ohne Policy jedes UPDATE, auch dem Owner).
--
-- Geschlossen in drizzle/0014: zwei eng gefasste, transaktionslokal
-- geöffnete Policies plus die SECURITY-DEFINER-Funktion
-- reconcile_user_identity(text, text). Der Hook in lib/auth.ts ruft nur noch
-- diese Funktion.
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
