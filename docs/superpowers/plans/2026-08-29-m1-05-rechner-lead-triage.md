# M1-05 — Umsetzungsplan Rechner-Lead → Triage

## Kontext

M1-04 nimmt Rechner-V3-Anfragen bereits sicher und atomar auf, lässt sie aber
im Browser unsichtbar. M1-05 schließt den nächsten kanonischen Golden-Path-
Abschnitt: geschützter Login, echtes Request-Kanban, Projektakte, persistenter
Spaltenwechsel und eine eng begrenzte bewusste Pin-Bestätigung. Kommerzielle
Wahrheit beginnt ausdrücklich erst mit M1-06/M2-01.

## Reihenfolge

1. **Vertrag und RED**
   - Spec und eigene WMEE-Defaultspalten festschreiben.
   - DB-/Service-Tests für Provisioning, Intake-Zuordnung, Reads, Moves,
     Pin-Bestätigung, Tenant-Isolation, Rollen und Rollback hinzufügen.
   - Build-Grenztest für die neuen Modul-Public-APIs ergänzen.
   - Fokussierten Lauf durchführen und das erwartete RED protokollieren.

2. **Schema und Forward-only-Migration**
   - `lib/db/schema/boards.ts` anlegen und aus dem Schema-Barrel exportieren.
   - `project` um Board-/Column-FKs ergänzen.
   - Drizzle-Migration generieren, anschließend bewusst um Backfill,
     Workspace-Provisioning-Trigger, RLS/FORCE und Policy ergänzen.
   - Fresh- und M1-04-Upgradepfad testen; keine bestehende Migration ändern.

3. **Rollenvertrag und Fixtures**
   - Relations-, Function-, RLS-, Policy- und ACL-Inventare in
     `scripts/db-role-contract.mts` aktualisieren.
   - `tests/setup/tenant-fixtures.ts` um neue Tabellen ergänzen.
   - Runtime nur die minimalen SELECT-/bestehenden UPDATE-Rechte geben.

4. **Fachmodule**
   - `modules/boards/` mit Board-DTO und concurrency-sicherem Move-Service.
   - `modules/projects/` mit minimiertem Detail-DTO und engem
     Pin-Bestätigungsservice.
   - M1-04-Intake löst Default-Board/Intake-Spalte vor Project-Insert auf.
   - Events/Audits bleiben PII- und preisfrei.

5. **Sessiongebundene Webgrenze**
   - `authorizedQuery` aus derselben geprüften Session-/Membership-Grenze wie
     `authorizedAction` ableiten.
   - Login/OTP mit dem vorhandenen Better-Auth-Provider umsetzen; internen
     `next`-Pfad validieren.
   - Geschützte Routen unterscheiden unauthenticated, denied und not-found.

6. **Eigene WMEE-Oberfläche**
   - Root-Metadaten, deutsche Sprache und ruhige Design-Tokens ersetzen das
     Next-Starter-Scaffold.
   - `/w/[workspaceId]/anfragen` als echtes Server-Board bauen.
   - `/w/[workspaceId]/anfragen/[projectId]` als echte Projektakte bauen.
   - Kleine Client-Islands für DnD, Move-Formular, OTP und Abmeldung; keine
     Rohdaten an den Client.
   - Mobile Statusfilter/Liste, sichtbare Tastaturalternative, Reduced Motion,
     Loading/Empty/Denied/404/Error-Zustände.

7. **E2E und Abschlussgates**
   - Signed-Fixture-Browser-Smoke mit echter Session/Membership und Reload.
   - Editor-/Viewer-/Cross-Tenant-Negativpfade.
   - Desktop/Mobile, Tastatur, Console/Hydration und Axe prüfen.
   - `npm run check` und `npm run build` vollständig grün.
   - Unabhängigen P0–P3-Review durchführen und P0–P2 schließen.
   - Spec, Paritätsmatrix und Planstatus auf belegten Zustand aktualisieren.

## Kritische Dateien

- `lib/db/schema/boards.ts`, `lib/db/schema/project.ts`
- neue additive Migration unter `drizzle/`
- `scripts/db-role-contract.mts`, `tests/setup/tenant-fixtures.ts`
- `modules/boards/index.ts`, `modules/boards/service.ts`
- `modules/projects/index.ts`, `modules/projects/service.ts`
- `modules/intake/service.ts`
- `lib/action.ts`
- `app/login/*`
- `app/w/[workspaceId]/anfragen/*`
- `app/globals.css`, `app/layout.tsx`, `app/page.tsx`
- DB-, Contract-, Build- und Browser-Tests unter `tests/`

## Verifikation

Der Slice gilt nur als fertig, wenn ein realer Rechner-Fixture-Lead nach
sessiongebundenem Login genau einmal im richtigen Workspace erscheint, ein
Editor ihn per Tastatur und Pointer persistent verschieben kann, ein Viewer
nicht mutieren kann, Pin-Bestätigung nur bei hausgenauer Auswahl gelingt und
alle DB-/RLS-/ACL-/Build-/Browser-Gates grün sind.

## Abschlussstand — 2026-08-29

Alle sieben Schritte sind lokal abgeschlossen. Belegt sind:

- additive Fresh- und M1-04-Upgrade-Migration einschließlich Backfill,
  Provisioning, RLS/FORCE, ACL und Triggervertrag;
- fachliche Service- und Rollbacktests sowie `external_only` fail-closed;
- echter Better-Auth-OTP-Login und zwei echte HMAC-signierte Rechner-Intakes
  in einer vollständig isolierten Browser-Testumgebung;
- Editor-Golden-Path mit Pin, sichtbarem Formular-Move, Pointer-DnD und
  Reload-Persistenz sowie Viewer- und Cross-Tenant-Negativpfad;
- Desktop-, Mobile- und Coarse-Pointer-Tablet-Verhalten, 44px-Fallback,
  Browserkonsole/Page-Errors und Axe serious/critical;
- `npm run check` mit 36 Dateien/307 Tests und 74+5 Rollenproben,
  `npm run test:e2e` mit 5 Chromium-Flows sowie `npm run build`.
- unabhängige Abschlussnachprüfung ohne offene P0–P2-Befunde; die dabei
  gefundenen Harness- und Evidenzlücken wurden geschlossen und erneut geprüft.

Provider-Wiring, öffentliches Preview-Deployment und Produktion bleiben
separate, ausdrücklich freizugebende Schritte.
