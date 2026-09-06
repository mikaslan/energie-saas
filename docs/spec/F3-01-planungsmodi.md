# F3.1 — Planungsmodi je Angebotsvariante

Status: **REVIEWED/VERIFIED (lokal)** · technisches Gate GO

## Ziel

Jede Angebotsvariante besitzt genau einen Planungsmodus `quick`, `2d` oder
`3d`. Ein revisionsgebundener Workspace-Default bestimmt nur den Startwert
neu angelegter Varianten. Er ändert niemals rückwirkend bestehende oder
signierte Varianten.

## Evidenz und Clean-Room-Einordnung

### FACT — öffentlich dokumentiert

- Reonic bietet Quick-, 2D- und 3D-Planung und einen Default-Planungstyp in
  den Workspace-Einstellungen. Ohne abweichende Konfiguration ist 3D der
  dokumentierte Residential-Produktdefault.
- Quick Planning verwaltet Komponenten und Preise, enthält aber keine
  Dach-/Modulplanung und liefert deshalb keinen belastbaren PV-Ertrag oder
  Wirtschaftlichkeitsoutput.
- Planung lebt variantenbezogen. Eine duplizierte Variante kopiert den
  vorhandenen Variantenstand; eine neue Variante ist davon unabhängig.
- Änderungen an Planung und Modulgruppen lösen die Simulation automatisch
  neu aus, soweit der gewählte Modus eine Simulation unterstützt.
- Eine laufende Signaturanfrage sperrt genau die betroffene Variante. Ein
  Withdraw oder Ablauf hebt diese vorläufige Sperre wieder auf; nach Signatur
  bleibt die gewählte Variante unveränderlich und Weiterarbeit erfolgt per
  Duplikat/Fork.

Quellen:

- <https://docs.reonic.com/docs/en/settings-planning-and-offer-planning>
- <https://docs.reonic.com/docs/en/offers-plan-pv-quick-planning>
- <https://docs.reonic.com/docs/en/offers-overview-create-an-offer>
- <https://docs.reonic.com/docs/en/offers-plan-pv-plan-modules>
- <https://docs.reonic.com/docs/en/offers-plan-additional-optional-variants>
- <https://docs.reonic.com/docs/en/offers-finalise-cat-revoke-offer>
- <https://docs.reonic.com/docs/en/offers-plan-pv-plan-building>

Das öffentliche Reonic-REST-v3-OpenAPI 3.11.0 vom 2026-09-06 enthält
Varianten-GET/-Create/-Update/-Delete-Endpunkte sowie `planningTemplates`,
`planningPackages` und `photogrammetry/jobs`. Die Varianten-Schemas exponieren
jedoch keinen Planungsmodus; ein öffentlicher Duplicate-/Mode-Transition-
Endpunkt fehlt. Private Daten oder Reonic-Code wurden nicht übernommen.

### ESTIMATE — öffentlich nicht eindeutig

Die Hilfeseiten widersprechen sich beim Wechsel von Quick zu 3D: Mehrere Seiten
beschreiben einen Moduswechsel, die Building-Seite fordert dafür eine neue
Variante. 2D↔3D und ein Roundtrip mit Erhalt alter Geometrie sind ebenfalls
nicht eindeutig belegt. Bis ein autorisierter Live-Flow die Kanten klärt, gilt
folgende reversible Projektentscheidung:

- Eine nicht durch `pending`, `signed` oder `revoked_by_customer` gesperrte
  Variante darf zwischen allen drei Modi wechseln.
- Ein Wechsel löscht keine vorhandenen 2D-/3D-Planungsdaten. Quick blendet sie
  nur aus und unterdrückt daraus abgeleitete Ergebniswerte.
- `pending` sperrt vorläufig; `withdrawn` und `expired` entsperren. Eine
  signierte oder kundenseitig widerrufene Variante ist dauerhaft
  unveränderlich; Weiterarbeit erfolgt ausschließlich über Duplizieren/Fork.

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
`{defaultPlanningMode: "3d", revision: 0}`. Der erste Write verlangt
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
  Das ist eine lokale Historienentscheidung: Diese Snapshots entstanden vor
  einem Planungstypvertrag und enthielten ausschließlich die Quick-äquivalente
  Komponenten-/Preisbasis; sie werden nicht rückwirkend zum neuen 3D-Default.
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
- Varianten mit laufender Signaturanfrage sowie signierte/kundenseitig
  widerrufene Varianten zeigen einen Sperrhinweis; Duplizieren/Fork bleibt
  erreichbar. Withdrawn/Expired sperren nicht.
- Quick zeigt Komponenten, Mengen, Preise, Rabatte und kommerzielle Aktionen.
  Dachlayout, Verschattung und daraus berechnete Ertrags-, Autarkie- und
  Wirtschaftlichkeitswerte bleiben verborgen und gelangen nicht in neue
  Ausgaben. Ein kommerzielles Quick-PDF bleibt möglich; leere/manuell
  deaktivierte Template-Kapitel und Stockbilder sind kein berechneter Output.
- Die bestehende Projektberechnung darf im Quick-Modus weiterlaufen, solange
  Produktauflösung/BOM davon abhängen. Ihr Ergebnis wird nicht als
  variantenbezogener Quick-Planungsoutput ausgegeben.

## DB- und Sicherheitsinvarianten

- Forward-only-Migration, FORCE RLS, Tenant-Policy, minimale Runtime-ACLs,
  `TRUNCATE` verboten.
- Enum-/Revision-/Zeit-Checks in DB und Vertrag identisch.
- Workspace-, Offer-, Variant- und Snapshot-Bindungen bleiben unverändert
  vollständig.
- Direkte SQL-Updates dürfen bei `pending`, `signed` oder
  `revoked_by_customer` gesperrte Varianteninhalte nicht verändern.
- Unbekannte Variante, fremdes Offer und fremder Tenant sind nach außen nicht
  unterscheidbar.
- Der Live-Rollenvertrag pinnt Relation, Policy, Trigger und Funktionskörper;
  keine `PENDING-ORAKEL`-Marker.

## Abnahmefälle

1. Kein Settings-Datensatz → virtuell 3D/Revision 0.
2. Admin setzt 2D oder 3D per CAS; stale CAS scheitert ohne Teilzustand.
3. Neue erste/Basisvariante übernimmt den zum Commit gültigen Default.
4. Default-Wechsel verändert bestehende Varianten nicht.
5. Duplikat kopiert Modus und Snapshotinhalt unabhängig vom neuen Default.
6. Legacy v1/v2/v3 liest als Quick, ohne gespeicherte Bytes oder Hash zu
   ändern; erste Mutation resealt als v4.
7. Unterschiedliche Modi erzeugen unterschiedliche v4-Snapshot-Hashes.
8. Unsigned Quick↔2D↔3D erzeugt je genau eine Revision; No-op erzeugt keine.
9. Pending/Signiert/kundenseitig widerrufen blockiert Service, direkte
   SQL-Umgehung und echte Signatur-vs.-Revision-Race; Withdrawn/Expired
   entsperrt, Fork bleibt möglich.
10. Viewer read-only, External/cross-tenant fail-closed, EK-Redaktion bleibt
    unverändert.
11. Quick-PDF bleibt kommerziell erzeugbar, enthält aber keine berechneten
    Dach-/Ertrags-/Simulationswerte.
12. Browser-Gate: 375/768/1440 px, Tastatur, Axe A/AA, keine Console- oder
    Hydration-Fehler, Reload und Zwei-Session-Konflikt.

## Lokaler Verifikationsstand (2026-09-06)

- Migration `0075_f3_01_planning_modes.sql` installiert den Workspace-Default,
  Snapshot-v4-Constraint, FORCE-RLS/ACLs sowie Signatur-/Content-Locks. Der
  Rollenvertrag pinnt Relation, Policies, Trigger und Funktionskörper.
- Der echte 0074→0075-Upgrade-Test hält v1/v2/v3-Snapshot-Bytes, JSON-Text,
  Objektgestalt und SHA-256 unverändert; Leser normalisieren nur im RAM auf
  v4/Quick. Ein unvollständiger v4-Write scheitert in der Datenbank.
- Nebenläufigkeit ist für Settings-CAS, Variant-Save, Create/Default,
  Signatur-Create gegen Revision sowie direkte SQL-Umgehungen geprüft. Die
  gemeinsame Lockreihenfolge lautet Project → Offer → Issuance → Variant.
- Signatur-Replay gibt ausschließlich beim exakt gleichen Token-Hash denselben
  Request zurück. Ein neuer Token zu einer bereits gebundenen Revision
  scheitert geschlossen; das ursprüngliche Token bleibt gültig.
- Abgelaufene Pending-Requests werden im Read-Modell effektiv als `expired`
  behandelt und entsperren die Variante. Signed und `revoked_by_customer`
  bleiben gesperrt; Withdrawn und Expired sind fork-/editierbar.
- `npm run check`: 238/238 Testdateien, 2.149 bestanden, 1 ausdrücklich
  übersprungen; Rollenprobe 88/88 und PG18 5/5. Production-Build grün.
- Chromium-Fokusgate F3.1: 4/4 bestanden. Es belegt isolierte OTP-Sessions,
  Settings-CAS, Offer-Create, Dirty/Save/Reload, Quick-PDF-Unterdrückung,
  echten Konflikt/Rebase, Viewer-Read-only, Pending-Lock und editierbaren Fork
  bei 375/768/1440 px inklusive Axe, Console und Pageerror.
- Vollständiges Chromium-Gate: 110 bestanden, 1 ausdrücklich übersprungen;
  Geoapify-Vertrag 1 Suche/1 Detailauflösung/0 Abweichungen.
- Unabhängiges P0–P2-Review: keine offenen Befunde im F3.1-Scope. Die
  Moduswechsel-Regel bleibt bis zu autorisierter Live-Bestätigung ausdrücklich
  `planning-mode-transition-estimate.v1`.

## Nicht-Ziele dieses Slices

- Dach-/Zonengeometrie, Modulgruppen, Strings oder Verschattung (F3.2–F3.6).
- Photogrammetrie-Upload und Jobausführung (F3.7).
- Neue Simulationsphysik oder 15-Minuten-Rechnung (F4.1).
- Ein neuer PDF-Planungskapitelvertrag; Quick-Suppression wird zunächst gegen
  den vorhandenen PDF-Vertrag bewiesen.
