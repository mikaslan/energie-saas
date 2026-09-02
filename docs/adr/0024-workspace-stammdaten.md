# ADR 0024 — Workspace-Stammdaten: Singleton-Settings-Tabelle statt JSONB-in-workspace

- Status: VORGESCHLAGEN (im Rahmen der M3-00-Spec DISCOVERED→SPECIFIED)
- Datum: 2026-09-03
- Betroffene Slice-Spec: `docs/spec/M3-00-workspace-stammdaten.md`
- Basis: `tooling` HEAD `1287488` (Spec-/ADR-Ablage; M3-00 ist reine Spezifikation)

## Kontext

M3-00 spezifiziert die Workspace-Stammdaten „Ausstellungsdetails“ (F8.2):
Firmendaten, Steuer-/Zahlungsdetails, Land (DE/AT/CH/FR/UK/JE), Nummernserien-
Defaults je Dokumenttyp und den GoBD-Retention-Default. Die bestehende
`workspace`-Tabelle trägt nur `name` und `featureFlags` (JSONB). Für diese erste
workspaceweite Stammdaten-Entität muss entschieden werden, ob sie als
getypte Singleton-Tabelle, als JSONB-Erweiterung von `workspace` oder als
Spalten-Erweiterung von `workspace` modelliert wird. Die Entscheidung prägt
auch die Folge-Settings (Textvorlagen, Branding, Organisation), weil M3-01
daraus Nummernserien seedet und das Precondition-Gate „Issuing Details
vollständig“ prüfen muss.

## Entscheidung

Wir modellieren eine **getypte Singleton-Tabelle** `workspace_invoicing_settings`
(eine Zeile je `workspaceId`, `revision`-CAS) plus eine **Kind-Tabelle**
`workspace_document_number_format` (eine Zeile je `(workspaceId, type)`).
Damit bleiben Pflichtfelder, Länder-/Zahlen-CHECKs und das Vollständigkeits-Gate
in der Datenbank erzwingbar; die Nummernserien-Defaults sind normalisiert und
per `type` indexierbar.

## Alternativen betrachtet

### Alternative 1: JSONB-Erweiterung von `workspace.featureFlags` (oder neues JSONB-Feld)
- **Pros:** keine neue Tabelle, additive Spalte, flexibel für künftige Settings.
- **Cons:** Pflichtfelder und Länder-/Retention-CHECKs nicht schema-erzwingbar;
  Vollständigkeits-Gate wandert in die Anwendung; Nummernserien-Defaults nicht
  per `type` normalisiert/indexierbar; Revision-CAS schwer abbildbar.
- **Warum nicht:** Das Precondition-Gate (fehlende Stammdaten → fail-closed) ist
  Kern des Slices und braucht DB-seitig erzwingbare Pflichtfelder.

### Alternative 2: Spalten direkt auf `workspace`
- **Pros:** eine Zeile, keine Join, kein Singleton-Separat.
- **Cons:** vermischt Mandanten-Identität mit Invoicing-Settings; jede neue
  Settings-Gruppe (Branding, Textvorlagen) bläht `workspace` weiter auf;
  `revision`/`updatedBy`-Historie gehört nicht zur Mandanten-Kernzeile.
- **Warum nicht:** `workspace` bleibt schlank; Settings sind ein eigener,
  revisionsfähiger Änderungsgegenstand.

## Konsequenzen

### Positiv
- Pflichtfelder, Länder-Enum und Retention-Bereich sind CHECK-erzwingbar.
- Nummernserien-Defaults normalisiert und deterministisch von M3-01 seedbar.
- Revision-CAS und `updatedBy`-Audit je Settings-Änderung möglich.
- Muster ist auf Folge-Settings übertragbar (eine Singleton-Tabelle je Gruppe
  oder eine gemeinsame mit Gruppen-Diskriminator).

### Negativ
- Eine zusätzliche Tabelle + Kind-Tabelle (vs. eine JSONB-Spalte).
- Singleton-Pflicht (`workspaceId` = PK) muss durch Insert-Idempotenz/CAS
  abgesichert werden (nicht mehrere Zeilen je Workspace).

### Risiken
- **Settings-Gruppen-Wucherung:** künftige Gruppen (Branding, Textvorlagen)
  könnten je eigene Singleton-Tabellen erzeugen. Mitigation: bewusst bei der
  nächsten Settings-Gruppe prüfen, ob eine gemeinsame Tabelle mit
  Gruppen-Diskriminator sinnvoller ist; M3-00 hält bewusst nur Invoicing-Daten.
