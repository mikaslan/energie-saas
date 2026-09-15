# F16-11 Paket-Vorlagen (Katalog F16.2, erster Offshoot)

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/m1-wave-02` · Stand 2026-09-15 (DB F1611 3/3, Tenant-Invarianten 18/18, Rollenvertrag grün inkl. geerntetem Pin, E2E F16-11 3/3, Nachbar-E2E F16-06/08/09 9/9, tsc/eslint/depcruise/generate-check grün, lokal beobachtet).

Ziel: Die in F16-06/F16-09 als „Positions-/Paket-Presets (Planning
Packages, F16.2)" bewusst offen geführte Lücke schließen — erster
Offshoot: ersetzende Stücklisten-Presets. Ein Paket ist eine Sektion
(Titel + Kategorie) mit freien Positionen; das Einsetzen an einer
Angebotsvariante ersetzt die frei editierbare (Custom-)Ebene in einer
Revision. Kein Reonic-Referenzbeleg; reversible eigene Näherung
(ESTIMATE).

## ESTIMATE (reversibel, Referenzfrage offen)

- Ersetzen = Custom-Ebene: Rein-Custom-Sektionen fallen ganz,
  gemischte Sektionen verlieren nur ihre Custom-Zeilen;
  Katalog-Seed-Zeilen bleiben durch die M2-Invariante unangetastet
  (`remove_custom_*` verweigert Nicht-Custom).
- Op-Reihenfolge Add→Removes→Lines (Add-Position zum Lesezeitpunkt
  gültig, Removes per Domain-ID positionsfest); Fremdänderung
  dazwischen fällt auf Revisions-Konflikt, nie auf Halbstand.
- Steuer fix `standard_19` (0-%-Pakete bleiben offen); Sektionen-Cap
  25 und Zeilen-Cap 500 des Angebots-Vertrags gelten fail-closed.
- Speicherung: `package_template` (Migration 0148, RLS
  tenant_isolation + FORCE, Archiv statt Delete), Zeilen-Cap 50.
- Keine neue Permission (`discount_template.read/write` wie F16-06,
  Angebots-Schreibschutz prüft der Revise-Pfad); kein Provider.
- Einstellungen-Seite `paket-vorlagen` (dynamische Positionszeilen,
  Euro-/Mengen-Parsing fail-closed); Apply-Panel „Paket einsetzen"
  mit eigenen Strings (kein F16-06-Selektor-Kollisionsraum).

## Geschlossene Testmatrix

- DB (`f1611`, F1611-DB-01..03): Anlegen → Liste → Anwenden ersetzt
  Custom-Sektion, Katalog-Zeilen überleben (Snapshot-Read-back),
  Paket-Sektion mit beiden Zeilen am Ende; stale Revision →
  OfferConflict ohne neue Revision; Duplikat/Archiv/Fremdmandant/
  Viewer fail-closed; Cap 0/51/Stück-Bruch/Leername/Negativpreis/
  Fremdeinheit → Validation.
- E2E (`F16-11-E2E-01..03`, W3-Workspace): Paket mit zwei Positionen
  per UI (Karte „2 Positionen"), Archiv/Restore, Viewer read-only;
  Angebot erstellen → Paket einsetzen → Erfolgsmeldung + Revision 2
  persistent (Snapshot enthält Sektion + beide Zeilen).
- Nachbarn: F16-06/08/09-E2E 9/9 grün (geteilte Angebots-Seite).

## Bewusst offen

- Katalog-komponentengebundene Paket-Zeilen (nur freie Positionen).
- Mengenverknüpfte Positionen („Linked amounts", F16.2).
- Öffentlich-Flag fürs Energiehaus (F16.2, Funnel-Referenz offen).
- 0-%-Steuer-Pakete.
