# F3.1 — Planungsmodi je Angebotsvariante

Status: **SPECIFIED** · Umsetzung und Abnahme ausstehend

## Ziel

Jede Angebotsvariante besitzt genau einen Planungsmodus `quick`, `2d` oder
`3d`. Ein revisionsgebundener Workspace-Default bestimmt nur den Startwert
neu angelegter Varianten. Er ändert niemals rückwirkend bestehende oder
signierte Varianten.

## Evidenz und Clean-Room-Einordnung

### FACT — öffentlich dokumentiert

- Reonic bietet Quick-, 2D- und 3D-Planung und einen Default-Planungstyp in
  den Workspace-Einstellungen.
- Quick Planning verwaltet Komponenten und Preise, enthält aber keine
  Dach-/Modulplanung und liefert deshalb keinen belastbaren PV-Ertrag oder
  Wirtschaftlichkeitsoutput.
- Planung lebt variantenbezogen. Eine duplizierte Variante kopiert den
  vorhandenen Variantenstand; eine neue Variante ist davon unabhängig.
- Änderungen an Planung und Modulgruppen lösen die Simulation automatisch
  neu aus, soweit der gewählte Modus eine Simulation unterstützt.

Quellen:

- <https://docs.reonic.com/docs/en/settings-planning-and-offer-planning>
- <https://docs.reonic.com/docs/en/offers-plan-pv-quick-planning>
- <https://docs.reonic.com/docs/en/offers-overview-create-an-offer>
- <https://docs.reonic.com/docs/en/offers-plan-pv-plan-modules>

Das öffentliche Reonic-REST-v3-OpenAPI vom 2026-09-06 enthält
`planningTemplates`, `planningPackages` und `photogrammetry/jobs`, aber keinen
öffentlichen Varianten-Endpunkt für den Planungsmodus. Private Daten oder
Reonic-Code wurden nicht übernommen.

### ESTIMATE — öffentlich nicht eindeutig

Die Hilfeseiten widersprechen sich beim Wechsel von Quick zu 3D: Eine Seite
beschreibt den Moduswechsel unter Erhalt vorhandener Daten, eine andere fordert
eine neue Variante. Bis ein autorisierter Live-Flow die Kante eindeutig belegt,
gilt folgende reversible Projektentscheidung:

- Eine **nicht signierte** Variante darf zwischen allen drei Modi wechseln.
- Ein Wechsel löscht keine vorhandenen 2D-/3D-Planungsdaten. Quick blendet sie
  nur aus und unterdrückt daraus abgeleitete Angebots-/PDF-Ausgaben.
- Eine signierte oder kundenseitig widerrufene Variante ist unveränderlich;
  Weiterarbeit erfolgt ausschließlich über Duplizieren/Fork.

Diese Regel heißt `planning-mode-transition-estimate.v1` und bleibt im
Abschlussbericht als `ESTIMATE`, bis Live-Evidenz sie bestätigt oder ersetzt.

## Domänenvertrag

### Workspace-Default

Singleton je Workspace:

```text
workspace_id              uuid, PK/FK
default_planning_mode     quick | 2d | 3d
revision                  integer >= 1
updated_by                uuid
created_at / updated_at   timestamptz
```

Fehlt die Zeile, ist das serverseitige Read-Modell
`{defaultPlanningMode: "quick", revision: 0}`. Der erste Write verlangt
`baseRevision=0`; weitere Writes verwenden CAS. Nur `settings.manage` darf
schreiben. Interne Workspace-Mitglieder dürfen lesen, External bleibt
fail-closed.

### Varianten-Snapshot

`planningMode` ist Bestandteil jedes unveränderlichen
`offer_variant_revision.revision_snapshot` und seines kanonischen Hashs. Es
gehört nicht nur auf die stabile Variantenzeile: PDF-, Release-, Signatur- und
Historienbindungen müssen exakt denselben Modus sehen wie die gebundene BOM.

- Neue Writes verwenden `offer-variant-snapshot.v4` mit Pflichtfeld
  `planningMode`.
- Gespeicherte v1/v2/v3-Bytes und deren SHA-256 werden niemals umgeschrieben.
- Leser normalisieren gültige v1/v2/v3-Snapshots auf `planningMode="quick"`.
- Die erste Variante und eine neue Variante aus aktueller Produktauflösung
  lesen den Workspace-Default **innerhalb ihrer Schreibtransaktion**.
- Duplizieren kopiert den Modus des Quellsnapshots und liest den aktuellen
  Default nicht.
- Ein später geänderter Workspace-Default verändert keine Variante.

### Mutation

Die vorhandene revisionsgebundene Variantenoperation wird erweitert:

```json
{"operation":"set_planning_mode","planningMode":"quick|2d|3d"}
```

Sie verlangt `project.write`, die erwartete Variantenrevision und eine
änderbare Variante. Gleichwertiger Modus ist ein No-op ohne Revision, Event
oder Audit. Ein echter Wechsel erzeugt genau eine neue Snapshot-Revision und
ein domänengebundenes Audit-Event.

Signatur und Variantenmutation müssen dieselbe Variantenzeile sperren. Eine
Signatur darf nur die weiterhin aktuelle, ausgegebene Revision terminal
binden; eine parallele Modus-/BOM-Änderung darf weder still mit signiert noch
nachträglich neben ein signiertes Artefakt geschrieben werden.

`payment_option_id`, Primary-Status und optionale Bundles sind bestehende
Variantenfelder. Ein neuer DB-Guard darf deren erlaubte Pfade nicht
versehentlich blockieren; signaturgebundene Inhaltsänderungen müssen jedoch
dieselbe Lock-Regel nutzen.

## Sichtbares Verhalten

- Workspace-Einstellungen zeigen drei beschriftete Modi und den aktuellen
  CAS-Stand.
- Der Angebotseditor zeigt den Modus der aktiven Variante. Modusänderungen
  nehmen am bestehenden Dirty-/Save-/Conflict-/Rebase-Vertrag teil.
- Read-only-Rollen sehen den Modus, aber kein aktives Steuerelement.
- Signierte/widerrufene Varianten zeigen einen Sperrhinweis; Duplizieren/Fork
  bleibt erreichbar.
- Quick zeigt Komponenten, Mengen, Preise, Rabatte und kommerzielle Aktionen.
  Dachlayout, Verschattung, Ertrag, Autarkie, Wirtschaftlichkeit und daraus
  erzeugte PDF-Kapitel bleiben verborgen beziehungsweise absent.
- Die bestehende Projektberechnung darf im Quick-Modus weiterlaufen, solange
  Produktauflösung/BOM davon abhängen. Ihr Ergebnis wird nicht als
  variantenbezogener Quick-Planungsoutput ausgegeben.

## DB- und Sicherheitsinvarianten

- Forward-only-Migration, FORCE RLS, Tenant-Policy, minimale Runtime-ACLs,
  `TRUNCATE` verboten.
- Enum-/Revision-/Zeit-Checks in DB und Vertrag identisch.
- Workspace-, Offer-, Variant- und Snapshot-Bindungen bleiben unverändert
  vollständig.
- Direkte SQL-Updates dürfen signierte/widerrufene Varianteninhalte nicht
  verändern.
- Unbekannte Variante, fremdes Offer und fremder Tenant sind nach außen nicht
  unterscheidbar.
- Der Live-Rollenvertrag pinnt Relation, Policy, Trigger und Funktionskörper;
  keine `PENDING-ORAKEL`-Marker.

## Abnahmefälle

1. Kein Settings-Datensatz → virtuell Quick/Revision 0.
2. Admin setzt 2D oder 3D per CAS; stale CAS scheitert ohne Teilzustand.
3. Neue erste/Basisvariante übernimmt den zum Commit gültigen Default.
4. Default-Wechsel verändert bestehende Varianten nicht.
5. Duplikat kopiert Modus und Snapshotinhalt unabhängig vom neuen Default.
6. Legacy v1/v2/v3 liest als Quick, ohne gespeicherte Bytes oder Hash zu
   ändern; erste Mutation resealt als v4.
7. Unterschiedliche Modi erzeugen unterschiedliche v4-Snapshot-Hashes.
8. Unsigned Quick↔2D↔3D erzeugt je genau eine Revision; No-op erzeugt keine.
9. Signiert/widerrufen blockiert Service, direkte SQL-Umgehung und echte
   Signatur-vs.-Revision-Race; Fork bleibt möglich.
10. Viewer read-only, External/cross-tenant fail-closed, EK-Redaktion bleibt
    unverändert.
11. Quick-PDF enthält keine Planungs-/Simulationsausgabe.
12. Browser-Gate: 375/768/1440 px, Tastatur, Axe A/AA, keine Console- oder
    Hydration-Fehler, Reload und Zwei-Session-Konflikt.

## Nicht-Ziele dieses Slices

- Dach-/Zonengeometrie, Modulgruppen, Strings oder Verschattung (F3.2–F3.6).
- Photogrammetrie-Upload und Jobausführung (F3.7).
- Neue Simulationsphysik oder 15-Minuten-Rechnung (F4.1).
- Ein neuer PDF-Planungskapitelvertrag; Quick-Suppression wird zunächst gegen
  den vorhandenen PDF-Vertrag bewiesen.
