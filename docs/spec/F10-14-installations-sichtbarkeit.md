# F10-14 Installations-Sichtbarkeit je Anzeigestand

Status: **IMPLEMENTIERT/LOKAL VERIFIZIERT** · Lane: `codex/muse-fleet-3-portal-install` · Stand 2026-09-17
Beleg: `npm run check` exit 0 (408 Dateien, 2890 bestanden/1 skipped,
Rollen 88/88, PG18 5/5), F1014 DB 3/3 + Contract 1/1, E2E F10-14 1/1
(375/768/1440 + Axe, aus/ein/Reset, Direktaufruf-Fallback),
Nachbar-E2E f10-05/f10-09/f10-03* (5) gruen, Build exit 0,
db:generate ohne Drift, 2 Reviews + Re-Review GO (P1 i18n + P1 Race
gefunden und gefixt, alle P2 geschlossen)
Basis: Modulkatalog F10.2 („Admin mappt interne Status auf Kundennamen +
Sichtbarkeit"). Baut auf F10-05 (gleiche Tabelle/Schluessel/Seite/Rechte).
Kein Reonic-Referenzbeleg; Verhalten ist reversible eigene Naeherung
(ESTIMATE).

## Ziel und Abgrenzung

Admins pflegen je Workspace pro Installationsstand (`active | completed |
handover`) nicht nur die kundenlesbare Bezeichnung (F10-05), sondern
auch, ob der Stand im Kundenportal ueberhaupt erscheint. Verborgener
aktueller Stand ⇒ Installations-Tab erscheint ehrlich nicht
(kein Orakel-Hinweis auf den verborgenen Stand).

Nicht in diesem Slice: neue Scopes/Schluessel, Projektebene (nur je
Workspace), Kunden-Schreibpfad, Aenderung an Label-/FAQ-Validierung
(F10-05/F10-09), neue Permission, Sichtbarkeit anderer Portalbereiche.

## ESTIMATEs (Reonic-Referenz unbekannt)

- Toggle je Zeile auf `einstellungen/portal-status` („Im Portal
  anzeigen", Default an) mit eigenem Speichern-Button — Platzierung
  und Wortlaut eigene Naeherung.
- Verborgener Stand blendet den ganzen Tab aus (Status + Timeline +
  FAQ, nie leere Bloecke); Direktaufruf `?tab=installation` faellt
  auf die Uebersicht zurueck (Muster unbekannter `tab`-Wert).
- Reine Sichtbarkeits-Zeile ohne Label-Override: `label` ist NULLABLE,
  NULL = kein Override (reine Sichtbarkeits-Zeile), damit uebersetzte
  Portal-Fallbacks je Sprache greifen statt deutschem Default-Text
  (Review P1-1: Standardtext-Anlage waere nicht display-neutral fuer
  nicht-deutsche Sprachen). Normalisierung (Invariante: Zeile ⟺
  explizites Label ODER versteckt): Einblenden ohne Zeile = No-Op,
  Einblenden reiner Sichtbarkeits-Zeile loescht sie, Ausblenden ohne
  Zeile legt (NULL, false) an.
- Alle Punkte reversibel.

## Vertrag

- `portal_status_label.visible` (Migration 0171): `boolean NOT NULL
  DEFAULT true`. Kein Werte-CHECK noetig (BOOLEAN + NOT NULL =
  zweiwertig); alle bestehenden CHECKs unveraendert. Default `true` =
  verhaltenserhaltend (Bestandszeilen bleiben sichtbar, kein Backfill).
  `label` wird NULLABLE (NULL = reine Sichtbarkeits-Zeile, s. ESTIMATEs).
- Semantik: keine Zeile fuer Schluessel K ⇒ sichtbar + Standardtext
  (Alt-Verhalten). Zeile mit `visible = false` ⇒ Anzeigestand K im
  Portal ausgeblendet. Zuruecksetzen loescht die Zeile.
- Service (`modules/installations`, Muster Label-Upsert):
  - `listInstallationStatusVisibility(tx, ctx)` →
    `{active, completed, handover: boolean}` (fehlende Zeile = `true`).
    Lesen `installation.read`.
  - `setInstallationStatusVisibility(tx, ctx, {key, visible})` —
    strikter Key (Allowlist), striktes Boolean, normalisierend,
    absichtlich SELECT-frei: Ausblenden = INSERT (NULL, false) mit
    Conflict-Update nur auf `visible` (Label bleibt, Race-frei);
    Einblenden = DELETE nur-NULL-Label + UPDATE `visible = true`
    (konkurrierend gesetzte Labels sind unbedingt sicher und werden
    ehrlich eingeblendet; fehlende Zeile = No-Op). Vorhandene
    explizite Labels bleiben beim Toggle erhalten, Label-Upsert
    nach Hide veraendert `visible` nicht. Schreiben
    `installation.write` (keine neue Permission). Audit
    `installation.set_status_visibility` mit `{key, visible}` (kein PII).
  - Label-Upsert/Reset bleiben verhaltensidentisch (beruehren
    `visible` nicht; Reset loescht ⇒ sichtbar); Label-Liste
    ueberspringt NULL-Labels (kein Override).
- Resolver (`resolve_portal_public_view`, SECURITY DEFINER):
  `installation.statusVisibility` als Override-Objekt
  (`jsonb_object_agg(source_key, visible)` ueber Zeilen mit Scope
  `installation`; nur vorhandene Schluessel, Wert = `visible`; nie
  interne IDs/Namen). Fehlende Map ⇒ `{}` (Muster statusLabels).
  `statusLabels`-Aggregation filtert NULL-Labels
  (`label IS NOT NULL`), damit reine Sichtbarkeits-Zeilen die
  uebersetzten Fallbacks nicht verdraengen (Review P1-1).
- Contract (`PortalPublicViewV1.installation`): `statusVisibility`
  als striktes Objekt mit optionalen Booleans je Allowlist-Schluessel;
  fehlend ⇒ `{}` (Alt-Projektion, Muster statusLabels/statusFaq);
  deformiert (fremde Schluessel, nicht-boolean) ⇒ `null` fail-closed.
- Portal leitet den Anzeigeschluessel wie bisher ab (Abnahme >
  Abschluss > laufend, `resolvePortalInstallationFaqKey`). Ist der
  aktuelle Schluessel unsichtbar (`statusVisibility[key] === false`):
  Tab-Link „Installation" entfaellt, Sektion entfaellt,
  `?tab=installation` faellt auf die Uebersicht zurueck. Kein Hinweis
  auf den verborgenen Stand (kein Orakel). `installation === null`
  unveraendert (Leertext-Tab wie bisher).
- Minimierte Projektion: nur `(source_key → boolean)` fuer die drei
  Allowlist-Schluessel; keine internen Statusnamen, IDs, Akteure oder
  Zeitstempel ueber F10-03 hinaus.

## Datenmodell (Migration 0171, additiv)

- Generator-Anteil: `portal_status_label.visible` (Schema-TS +
  `db:generate`, danach auf 0171 umnummeriert, Re-Run ohne Drift).
- Hand-Anteil: `CREATE OR REPLACE resolve_portal_public_view` (beide
  Ruempfe im Owner-Tanz, Muster 0170: `status_visibility_map` +
  `'statusVisibility'`-Merge; Signatur unveraendert — Grants bleiben).
- Rollenvertrag (`scripts/db-role-contract.mts`): Stufenmarker
  `hasPortalStatusVisibilityProjection` (prosrc enthaelt
  `status_visibility_map`, Muster `hasPortalStatusFaqProjection`);
  bedingter Prosrc-Pin als neue Kettenstufe (Hash per Embedded-Probe
  geerntet, alte Prefixe bleiben gruen).
- Journal-/Upgrade-Pins: `TOTAL_MIGRATION_COUNT` 150 → 151, End-Eintrag
  `0171_...` (Erweiterung, kein Umbau).

## Geschlossene Testmatrix

- `F1014-DB-01`: Set-Roundtrip Sichtbarkeit je Schluessel (an/aus),
  Default sichtbar ohne Zeile, Label bleibt bei Toggle erhalten,
  Toggle ohne Zeile legt Standardtext-Zeile an, Reset ⇒ sichtbar +
  Standard.
- `F1014-DB-02`: Validierung fail-closed (unbekannter Schluessel,
  nicht-boolean), Viewer read-only (lesen ja, schreiben nein),
  Mandantentrennung (fremder Actor sieht/leakt nichts).
- `F1014-DB-03`: Resolver projiziert `statusVisibility` (nur
  Zeilen-Schluessel mit echtem Boolean); ohne Mapping `{}`.
- `F1014-CONTRACT-01`: Alt-Projektion ohne `statusVisibility` parst
  ⇒ `{}`; gesetzte/fehlende Schluessel; deformierte Werte (fremde
  Schluessel, nicht-boolean) ⇒ `null`.
- `F1014-E2E-01` (isolierter Workspace, Muster F10-05): Editor blendet
  aktiven Stand aus ⇒ Tab-Link weg, Direktaufruf zeigt Uebersicht;
  Einblenden ⇒ Tab wieder da; keine Browser-Fehler. Viewports
  375/768/1440 + Axe als anonymer Kunde.

## Bewusst offen

- Sichtbarkeit je Projekt statt je Workspace; Sichtbarkeit anderer
  Portalbereiche (Termine, Dateien, Foerderung, Service).
- Tab-Verschwinden ist fuer Token-Inhaber beobachtbar (inhaerent, kein
  Inhalt leckt — genaue Reonic-Darstellung UNKNOWN).
- Alternative Modellierung (eigene Tabelle statt Spalte) verworfen:
  eine Zeile = ein Mapping (Name + Sichtbarkeit), ein Reset-Begriff.
