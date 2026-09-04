# F9.4 Slice C — GPS am Start-Event (mit Consent-Konzept)

Status: **SPECIFIED (DISCOVERED abgeschlossen)**

Lane: `codex/muse-welle-03-e2e` off `origin/codex/m1-wave-02`.
Vorgänger: F9.1 (CRUD), F9.2 (Stoppuhr), F9.3 (Filter), F9.4-A (Export),
F9.4-B (Verlauf), F9.4-D (Auslastung). Katalog: F9.3-Rest „GPS am
Start-Event" (Modulkatalog M9).

## Angewendete Skill-Regeln
- reonic-parity: TDD RED→IMPLEMENTED, keine erfundenen Felder.
- contract-first: Koordinaten im Start-Command + DTOs.
- database-migrations: Spalten per Migration (Nummer GLOBAL prüfen:
  0058 ist frei, `ls drizzle | sort`); DB-CHECKs symmetrisch zu Zod
  (Kimi-P2-1-Lehre); keine RLS-/Grant-/Pin-Änderung (Spalten sind
  tabellen-neutral — Pins hashen nur Policy-Definitionen).

## Consent-Konzept (DECIDED)
- Opt-in PRO Startvorgang: Checkbox „Standort beim Start speichern" in
  der Stoppuhr-Sektion, default AUS. Kein Profil, kein Tracking, kein
  Hintergrund — nur das Start-Event (Katalog-Wortlaut).
- Browser-Geolocation erst beim Klick auf „Stoppuhr starten"
  (`navigator.geolocation.getCurrentPosition`, Timeout 10 s).
  Verweigert/nicht verfügbar/Timeout → Start OHNE Koordinaten (kein
  Fehler, kein Block). Fail-open beim Start, fail-closed bei Werten:
  nie erfundene Koordinaten, NULL ist der ehrliche Wert.
- Manuelle Einträge („Neuer Zeiteintrag") bekommen KEIN GPS (nur
  Start-Event — Scope-Disziplin, kein stilles Erweitern).
- Anzeige: Eintragszeile zeigt „Standort: lat, lng" (4 Dezimalen,
  ≈11 m — nicht genauer nötig). Keine Karte (kein Provider, kein
  Leaflet — Nicht-Ziel).

## Scope
1. Migration `0058_f9_04_time_entry_gps`: `time_entry.start_lat` /
   `start_lng` (double precision, NULL) + CHECKs (lat −90..90, lng
   −180..180, beide gemeinsam NULL oder gemeinsam gesetzt) +
   identische Spalten/CHECKs auf `time_entry_revision` (Vollbild-Prinzip
   aus Slice B — Revision kopiert die Werte, kein neuer Pfad).
2. Contract: `startTimeEntryCommandSchema` += `startLat`/`startLng`
   (nullable, finite, Range, beide-oder-keiner-Refine);
   `timeEntryDtoSchema` + `timeEntryRevisionDtoSchema` += beide Felder
   (nullable) zur Anzeige.
3. Service: `startTimeEntry` schreibt Koordinaten; Update-CTE sichert
   sie in die Revision (old_entry-Spalten + INSERT-Spalten erweitern);
   alle Entry-SELECTs/RETURNINGs liefern sie mit. Halbe Paare und
   Out-of-Range → `TimeTrackingValidationError` (Zod + DB-CHECK).
4. UI (Client-Komponente, ohne neue Deps): Checkbox in der
   Stoppuhr-Sektion + Hidden-Fields; Submit-Handler füllt sie per
   Geolocation (async, dann `requestSubmit`); ohne Consent/bei Fehler
   normaler Submit ohne Koordinaten. Eintragszeile zeigt Standort.
5. Tests: (a) Vitest-DB: Start MIT Koordinaten (gespeichert, DTO
   enthält sie); Start ohne → NULL; lat 91 / halbes Paar →
   ValidationError; Update behält Koordinaten + Revision trägt sie;
   (b) E2E (eigenes f94c-Projekt in run.mts — laufender Eintrag darf
   D-Summen nicht sehen... präzise: Isolation wie D): Geolocation per
   `context.grantPermissions` + `setGeolocation` (52.52/13.405),
   Checkbox an, starten, „Standort:"-Zeile sichtbar, stoppen
   (aufräumen — kein laufender Eintrag zurücklassen).

## Nicht-Ziele
- Keine Karte/kein Provider (keine Leaflets, keine Tiles, keine Keys).
- Kein GPS bei Stop/Update/manuellen Einträgen.
- Kein Consent-Profil/keine Workspace-Einstellung (pro Start reicht).
- Keine Export-Spalten (Export unverändert), keine Verlauf-Änderung
  außer mitkopierten Werten.

## Akzeptanz
- `npm run check` grün, `db:generate` ohne Drift, E2E-Spec grün (CI),
  Reviews Exit-3 (Selbstreview + Gates).
- Verweigerte Geolocation blockiert den Start NICHT (Test-Aussage auf
  Service-Ebene: Start ohne Koordinaten → NULL).
- Keine Koordinaten ohne expliziten Haken (E2E-Aussage: ohne Checkbox
  keine Standort-Zeile).
