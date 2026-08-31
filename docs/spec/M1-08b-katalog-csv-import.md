# M1-08b — Autorisierter Katalog-CSV-Import bis zur Angebots-BOM

Status: **REVIEWED/VERIFIED (lokal) · TECHNISCHES GATE GO**

Datum: 2026-08-31

F-Bezug: F16.1, konsumiert durch F2.1/F2.3

Vorgänger: M1-08a Katalog/Projektauflösung, M2-01 Angebotsvarianten/Snapshot-BOM

## Nutzerergebnis

Ein berechtigter interner Nutzer kann eine eigene oder ausdrücklich
autorisierte Produkt-/Preisliste als CSV prüfen und anschließend asynchron
importieren. Fehler werden vor dem Start und nach der Verarbeitung stabil je
Zeile und Feld ausgewiesen. Neue SKU erzeugen Produktentwürfe, geänderte
bekannte SKU genau eine neue Katalogrevision und identische Stände keinen neuen
Produktstand.

Importierte Produkte bleiben bis zu einer getrennten bewussten Aktivierung
`draft`. Danach können sie über die bereits verifizierte Projektauflösung in
eine neue Angebotsbasis kopiert werden. Bestehende Projektauflösungen,
Varianten und BOM-Zeilen bleiben bei jedem Reimport unverändert; nur die
operative Aktualität wird sichtbar `stale`.

Der lokale Abnahmepfad lautet:

```text
synthetische/autorisierte CSV
  → serverautoritatives Mapping und Vorschau
  → expliziter Importstart
  → ID-only Worker in begrenzten Zeilenbatches
  → revisionsgebundene Produktentwürfe + Fehlerbericht
  → getrennte menschliche Aktivierung
  → aktuelle Projektauflösung
  → neue Offer-Basisvariante mit exakter Snapshot-BOM
```

Ein echter WMEE-/Lieferantenimport wird nicht ausgeführt, solange keine
rechtmäßig bereitgestellte Datei und Rechtebasis vorliegen.

## Evidence und Produktwahrheit

- `DOCUMENTED`: F16.1 verlangt eigene Komponenten, technische Daten, EK/VK,
  Provenienz und kontrollierte Aktualisierung.
- `DOCUMENTED`: M1-Roadmap und M1-08-Spec nennen CSV als Massenweg.
- `DECIDED`: Der Importvertrag, die Grenzwerte, das Mapping, die Jobzustände
  und die Fehlercodes sind eigenständige WMEE-Entscheidungen.
- `UNKNOWN`: Private Reonic-Spaltennamen, Importdialoge, Dateigrenzen und
  Teilerfolgsdetails werden nicht behauptet oder nachgebaut.

## Capabilities und objektive Abnahme

| ID | Job und Ergebnis | Nachweis |
|---|---|---|
| `M108B-01` | Nutzer lädt CSV hoch, ordnet Spalten zu und erhält ohne Katalogmutation eine persistierte deterministische Vorschau | Contract, Service, Browser |
| `M108B-02` | Jede Zeile wird vollständig auf den bestehenden Katalogvertrag validiert; Fehler enthalten Zeile, kanonisches Feld und stabilen Code | Contract, DB, Browser |
| `M108B-03` | Technik-, EK- und VK-Provenienz sowie Datei-/Zeilenhash bleiben an den exakten Import- und Produktstand gebunden | Contract, DB, Privacy |
| `M108B-04` | Expliziter Start verarbeitet valide Zeilen transaktionsweise über einen engen DB-Gateway mit denselben Seal-/Lock-/Revision-/Event-/Audit-Invarianten; Replay dupliziert nichts | Service, Worker, DB |
| `M108B-05` | Neue/geänderte Produkte enden als `draft`; bestehende Aktivierung bleibt bewusst separat; historische Snapshots bleiben unverändert | DB, Browser |
| `M108B-06` | Importiertes Modul, Wechselrichter und Speicher erreichen nach Aktivierung Projektauflösung und neue M2-01-Basis-BOM mit exakten Mengen/Centwerten/Revisionen | E2E |
| `M108B-07` | Upload, Vorschau, Start und Report verlangen `catalog.manage`, `price.edit` und `price.read_purchase`; Viewer, External und fremde Tenants bleiben ausgeschlossen | RBAC, RLS, Browser |
| `M108B-08` | Reimport mit Änderung macht aktuelle Auflösung stale, verändert alte BOM nie und ermöglicht erst nach neuer Auflösung eine neue Basisvariante | DB, E2E |
| `M108B-09` | Aktive importierte SKU bleiben auch hinter Eintrag 200 über serverseitige Suche/ID-Auflösung bis zur Projektauflösung und neuen BOM erreichbar | Service, DB, E2E |

## Datei- und Parservertrag v1

Der autoritative Vertrag heißt `catalog-csv-import.v1`.

- Dateityp ausschließlich `.csv` mit `text/csv` oder defensiv erkanntem
  Textinhalt; Dateiendung und MIME allein sind nie vertrauenswürdig.
- maximal 1 MiB, 1 bis 1.000 Datenzeilen, 1 bis 80 Quellspalten und maximal
  4.096 Unicode-Zeichen pro Zelle;
- UTF-8 mit/ohne BOM; nur bei ungültigem UTF-8 kontrollierter Fallback auf
  Windows-1252;
- Trennzeichen ausschließlich Semikolon oder Komma; Autoerkennung wird in der
  Vorschau angezeigt und serverseitig erneut geprüft;
- RFC-4180-Quoting über den bereits gepinnten `papaparse`-Parser;
- NUL, nicht normalisierbare Unicode-Folgen, mehrdeutige Header,
  uneinheitliche Feldanzahl und Parserabbruch werden fail-closed behandelt;
- leere Schlusszeilen werden ignoriert, leere Zeilen innerhalb des Datensatzes
  bleiben als stabile Zeilenfehler sichtbar;
- Zahlen bleiben bis zur Feldvalidierung Strings. Netto-Preise werden ohne
  Fließkommaarithmetik exakt in Cent konvertiert. Deutsche
  `1.234,56`- und kanonische `1234.56`-Schreibweise sind zulässig;
  mehrdeutige Formate werden abgelehnt.

Der Browser darf Header zur Bedienhilfe lesen. Maßgeblich sind ausschließlich
Serverparser, serverseitige Grenzwerte, Mapping und Hashes.

## Spaltenmapping

Die CSV muss keine proprietären Überschriften besitzen. Der Nutzer ordnet
Quellheadern kanonische Felder zu; exakte kanonische Header werden automatisch
vorbelegt. Ein Quellheader darf höchstens einmal und ein kanonisches Feld darf
genau einmal verwendet werden. Nicht zugeordnete Quellspalten werden
ausdrücklich als ignoriert angezeigt und nie persistiert.

Gemeinsam erforderlich:

```text
internalSku, componentType, displayName, manufacturer, model, unit,
technicalSourceKind, technicalReference, technicalObservedOn,
technicalRightsBasis, purchasePriceNet, purchaseSourceKind,
purchaseReference, purchaseObservedOn, purchaseRightsBasis,
salesPriceNet, salesSourceKind, salesReference, salesObservedOn,
salesRightsBasis
```

Optional gemeinsam:

```text
keyPoints, technicalDocumentSha256,
purchaseDocumentSha256, salesDocumentSha256
```

Typabhängig erforderlich:

```text
module: nominalPowerWatts
inverter: nominalAcPowerWatts, phaseCount, mpptTrackerCount
battery: nominalCapacityWh, usableCapacityWh, maxContinuousPowerWatts,
         roundTripEfficiencyPercent, backupCapability
wallbox: maxChargingPowerWatts, phaseCount, connector,
         bidirectionalCapability
heat_pump: nominalHeatingPowerWatts, scop
mounting: systemName, roofTypes
other: attributes
```

`keyPoints` und `roofTypes` verwenden in v1 `|` als nicht escapbares
Trennzeichen. Einzelwerte werden getrimmt, dürfen nicht leer sein und dürfen
deshalb selbst kein `|` enthalten. Für `keyPoints` gelten höchstens sechs
Einträge. `other.attributes` ist dagegen ausschließlich ein RFC-8259-JSON-
Array aus `{ "name": string, "value": string }`; `name=value` oder eine
Pipe-Sondergrammatik sind nicht zulässig.

`roundTripEfficiencyPercent` ist ein Dezimal-Prozentwert größer 0 bis 100 mit
höchstens zwei Nachkommastellen. Er wird ohne Rundung exakt mit 100
multipliziert und als `roundTripEfficiencyBasisPoints` gespeichert;
`95,00 → 9500`. `scop` ist größer 0 bis 20 mit höchstens zwei
Nachkommastellen und wird ebenso ohne Rundung als `scopHundredths`
gespeichert; `4.75 → 475`. Weitere Präzision ist `invalid_value`.

Workspace, Actor, IDs, Revisionen, Status, Assetkeys, Hashbindungen und
Aktivierungsentscheidung sind niemals CSV-Felder.

## Zeilenvalidierung und Fehlervertrag

Eine Zeile wird in einen geschlossenen
`catalog-import-row-command.v1`-Vertrag überführt. Er enthält:

- normalisierte SKU und Komponententyp;
- vollständige bestehende Create-Form einschließlich Technik, Darstellung,
  EK/VK und fachlicher Provenienz;
- serverseitig bestimmte Operation `create | revise | unchanged`;
- bei `revise|unchanged`: Component-ID, erwartete Revision, erwarteter Status und
  erwarteter Snapshot-Hash;
- Datei-SHA-256, Mapping-SHA-256, Zeilennummer und Zeilen-SHA-256;
- einen serverseitig erzeugten Command-Hash.

Stabile Request-/Dateifehlercodes v1:

```text
invalid_file, file_too_large, invalid_encoding, invalid_filename,
invalid_headers, too_many_columns, too_many_rows, missing_mapping,
mapping_conflict, snapshot_budget_exceeded, parser_error
```

Stabile Zeilen-/Previewfehlercodes v1:

```text
empty_row, missing_mapping, missing_value, invalid_value, invalid_money,
invalid_date, invalid_enum, invalid_sha256, invalid_technical_shape,
duplicate_sku_in_file, sku_type_conflict, archived_requires_manual_reactivation,
mapping_conflict, row_too_large, parser_error
```

Stabile Verarbeitungsresultate v1:

```text
sku_created_since_preview, revision_drift, status_drift, type_drift,
archived_requires_manual_reactivation, catalog_write_conflict
```

Stabile Job-End- und Retrycodes v1:

```text
actor_revoked, capability_revoked, lease_lost, enqueue_failed,
invalid_persisted_input, technical_retry_exhausted, all_rows_conflicted,
queue_locator_invalid
```

Fehler speichern keine vollständige Rohzeile. Report und Oberfläche zeigen
nur Zeilennummer, kanonisches Feld, Quellheader, Code und eine feste eigene
Fehlermeldung. Freie Quelltexte, Preise und Rohdatei gelangen nicht in Events,
Audits oder Logs.

## Teilerfolg, Idempotenz und Parallelität

Teilerfolg ist der vertragliche Normalfall. Die Vorschau persistiert alle
Zeilen immutable als `valid` oder `invalid`. Nur valide Zeilen werden nach
expliziter Bestätigung verarbeitet; jede valide Zeile bildet eine eigene
Tenant-Transaktion. Dadurch kann ein 100-Zeilen-Import mit 7 ungültigen Zeilen
als 93 Produktresultate plus 7 präzise Fehler enden.

- ein vom Browser erzeugtes `import_intent_id` eröffnet genau einen
  Importversuch; der Reservation-Key ist SHA-256 über Intent,
  Contractversion, Datei-SHA, Encoding, Delimiter und kanonisches Mapping;
- Replay desselben Workspace+Intent mit identischen Bindungen liefert
  denselben Job, dasselbe Intent mit abweichenden Bindungen scheitert;
- nach jedem Terminalzustand darf ein neues Intent dieselbe Datei und dasselbe
  Mapping bewusst erneut bewerten, etwa nach Reaktivierung oder behobenem
  Drift;
- je Job und Zeilennummer existiert genau eine immutable Eingabe und höchstens
  ein append-only Ergebnis;
- derselbe Worker-Dispatch und derselbe Start sind idempotent;
- doppelte normalisierte SKU innerhalb einer Datei sind Vorschaufehler;
- bestehende identische SKU/Revision erzeugt `unchanged` ohne Event oder neue
  Revision;
- geänderter Stand desselben Typs erzeugt genau Revision N+1 und `draft`;
- Typkollision, Archivstatus oder Drift seit der Vorschau scheitern nur für
  diese Zeile mit stabilem Resultat; andere Zeilen bleiben unabhängig;
- Produktlock und frischer Revisionread folgen der bestehenden M1-08-
  Reihenfolge; betroffene Projects werden vor Stale-Markierung sortiert
  gesperrt;
- Produktmutation, Event, Audit und Importzeilenergebnis committen gemeinsam.

Terminalzustände werden ausschließlich aus den DB-Resultaten abgeleitet:

- `succeeded`: jede Eingabezeile war valide und jede valide Zeile endete
  `created|revised|unchanged`;
- `partial`: mindestens ein fachlicher Erfolg einschließlich `unchanged` und
  mindestens ein Previewfehler oder fachlicher Conflict; technische Endfehler
  erzeugen nie `partial`;
- `failed_final`: alle verarbeitbaren Zeilen conflicten ohne fachlichen Erfolg,
  oder der Job endet global wegen technischer Erschöpfung, korruptem Input oder
  entzogenem Actor/Capability — auch wenn bereits einzelne Row-Resultate
  committet sind; ein Import mit null validen Zeilen darf gar nicht starten;
- fachliche Conflicts verbrauchen keinen technischen Retry; Counts werden nie
  vom Worker geliefert, sondern aus Row/Result in der DB gezählt.

## Persistenz

### `catalog_import_job`

Tenantgebundener Job mit Intent/Reservation, Datei-/Mappinghash,
`mapping_snapshot`, Mappingversion, Dateiname, Encoding, Delimiter,
Contract-/Parser-Version, DB-abgeleiteten Counts, Zustand,
`lease_generation`, `lease_token`, höchstens 25 `lease_row_numbers`,
`consecutive_failure_count`, Fehlercode, `created_by`, unveränderlichem
`execution_actor_id` ab erstem Start, `attestation_version`,
`attestation_text_sha256`, `attested_by`, `attested_at` und DB-Zeitpunkten. Die
Datei selbst wird nach dem serverseitigen Parsing nicht gespeichert.
Historische Actor-IDs referenzieren `user_identity`, nicht eine löschhemmende
Membership-FK.

Jede Vorschau erhält DB-autoritativ `preview_expires_at = created_at + 7 days`.
Ist sie dann noch `ready_for_review`, terminalisiert der Maintenance-Handler
sie atomar als `cancelled_before_start`. Die sensible Cleanup-Due-Grenze ist
`greatest(created_at + 30 days, terminal_at)`; ein Preview kann daher nicht
unbegrenzt außerhalb der aktiven Jobquote liegen. Bis zu einem Terminalzustand
ist `snapshot_cleanup_due_at IS NULL`; Cleanup lehnt nichtterminale Jobs ab.

### `catalog_import_row`

Eingabezeile mit Jobbindung, Zeilennummer, Validierungsstatus,
normalisierter SKU, Operation, geschlossenem Commandsnapshot oder
geschlossenem Fehlerarray sowie Zeilen-/Quellcommand-/Row-Commandhash. Für
`create|revise` persistiert der Previewservice zusätzlich den bereits
versiegelten Zielstand, seinen JCS-kanonischen Body als UTF-8-`bytea` und
dessen SHA-256. Bei `unchanged` sind `sealed_target_snapshot` und
`sealed_target_body_canonical` zwingend `NULL`; nur die aktuelle gesperrte
Katalogrevision dient als Vergleichsstand. Für `revise|unchanged` werden zudem
Component-ID, erwartete Revision, Status und Snapshot-Hash gespeichert. Der DB-Gateway
berechnet für Mapping-, Quellcommand-, Row-Command- und Zielbodybytes jeweils
`pg_catalog.sha256(canonical_body)`, vergleicht den Digest mit der zugehörigen
Spalte und den eingebetteten Hashwerten und verlangt, dass jedes als JSON
geparste Bytefeld semantisch exakt seinem Mapping-/Command-/Zielsnapshot
entspricht. Operation, Job-/Datei-/Mapping-/Zeilenhash, Zeilennummer,
Component-ID und sämtliche Expected-Werte müssen zusätzlich exakt den
persistierten Spalten beziehungsweise dem gesperrten Job entsprechen. Keine
Rohzeile.

Bei `unchanged` genügt der erwartete Snapshot-Hash nicht: Prepare, Start und
Row-Apply sperren und laden die aktuelle Katalogrevision erneut und vergleichen
`presentation`, `technicalData`, `commercial` und `technicalProvenance`
kanonisch mit dem gespeicherten `sourceCommand`. Nur vollständige
Nutzdatengleichheit darf `unchanged` erzeugen. Eine korrupte Canonical- oder
Embedded-Bindung endet technisch mit `invalid_persisted_input`; legitime
Katalogdrift seit der Vorschau erzeugt dagegen das passende stabile
Row-Conflict-Resultat ohne technischen Retry.

Private, nicht öffentlich ausführbare SQL-Validatoren prüfen Mapping,
Row-Command, Source-Command, Expected, SealedTarget und Fehlerarray gegen exakt
die erlaubten Schlüssel, JSON-Typen, Versionen, Enums und Grenzen. Tabellen-
Guards sowie Prepare, Start und Apply rufen diese Validatoren zwingend auf und
werten jedes zusammengesetzte Prädikat mit `IS TRUE` beziehungsweise
`IS DISTINCT FROM` fail-closed aus. Prepare, Start und Apply vergleichen
insbesondere `source.fileSha256` und `source.mappingSha256` mit dem jeweils
gesperrten Job; ein fehlender oder zusätzlicher Schlüssel ist ungültig.

### `catalog_import_row_result`

Append-only Ergebnis mit genau einem der Zustände
`created | revised | unchanged | conflict` und DB-Zeit. `created`, `revised`
und `unchanged` besitzen eine exakte Component-/Revisions-/Snapshothash-Bindung
und keinen Fehlercode. `conflict` besitzt ausschließlich einen festen
fachlichen Fehlercode; Component, Revision und Snapshothash sind dabei zwingend
NULL. Über Job und Zeile bleibt der Datei-SHA an erfolgreichen resultierenden
Revisionen nachvollziehbar.

Der normalisierte Commandsnapshot enthält bis zur Redaction technische Daten,
EK/VK und freie Provenienz und ist daher ehrlich eine zweite, besonders
geschützte Kopie der Preisliste. Er wird niemals allgemein lesbar. Maximal
drei `ready_for_review`-Jobs je Actor, zehn je Workspace, ein aktiver Job je
Workspace und 30 MiB unredactete Snapshots je Workspace sind zulässig. Eine
enge Cleanup-Funktion muss ab `snapshot_cleanup_due_at =
greatest(created_at + interval '30 days', terminal_at)` in derselben
Transaktion `file_name`, `normalized_sku`, `mapping_snapshot`, dessen
kanonische Bodybytes, `command_snapshot`, Quell-/Row-Command-Bodybytes,
`sealed_target_snapshot` und
`sealed_target_body_canonical` irreversibel nullen. Freie `sourceHeader` in
Fehlern werden dabei auf `null` redigiert; nur Hashes, erwartete
Revision-/Status-/Componentbindungen, feldgebundene feste Fehler und Resultate
bleiben. Row- und Job-Guards erlauben neben Insert nur
diese eine gemeinsam gebundene `snapshot_redacted_at NULL→DB-Zeit`-
Transition. Teilredaction, zu frühe Redaction und erneute Mutation sind
verboten. Cleanup läuft unter `app_worker`, nie über generische Tabellen-DML.

Die DB begrenzt Mapping-, Source-Command-, Target- und Row-Command-Body auf
32 KiB, 64 KiB, 64 KiB und 256 KiB. `sensitive_payload_bytes` wird nicht aus
dem Request übernommen: Der Preview-Gateway berechnet es aus tatsächlichen
stabilen UTF-8-`octet_length`-Werten des JSONB-Textbilds und den im Row-BEFORE-
Trigger abgeleiteten `pg_column_size`-/Bodybyte-Werten. Die Job-Summe darf nicht
von TOAST-Kompression oder einem HOT-Update abhängen.
Ein deferred Validator bindet den gespeicherten Wert an diese Summe; unter dem
Workspace-Lock darf die Summe aller unredacteten Jobs 30 MiB nicht übersteigen.
Bei der Vollredaction werden Job- und sämtliche Row-
`sensitive_payload_bytes` in derselben Transaktion auf 0 gesetzt; der Validator
bleibt deshalb auch nach Redaction unkonditional wahr. Historische Dateigröße,
Counts und nicht sensitive Hash-/Resultatmetadaten bleiben getrennt erhalten.

Redaction besitzt neben engen BEFORE-Guards einen `DEFERRABLE INITIALLY
DEFERRED` Constraint-Trigger auf Job und Rows. Am Transaktionsende verlangt er
für Job und ausnahmslos alle Rows dieselbe DB-erzeugte `snapshot_redacted_at`,
erfülltes Due und vollständig genullte Payloadfelder. Damit scheitern auch
direkte Owner-Transaktionen mit Job-only-, Teil-Row-, Früh- oder Replaymutation;
der Cleanup-Gateway sperrt Job und alle Rows und setzt sie gemeinsam.

Der Cleanup-Sweep läuft mindestens stündlich; 99 % werden bis
`snapshot_cleanup_due_at + 1 hour` redigiert, der harte Betriebsalarm greift
ab `snapshot_cleanup_due_at + 24 hours`. Runbook und manueller Recovery-Dispatch schließen
Ausfälle. Nach Redaction zeigt die Detailseite den ehrlichen Zustand
`snapshot_redacted`: Counts, Fehler, Resultate und Produktlinks bleiben,
Technik-/Preis-/Provenienzvorschau ist nicht mehr verfügbar.

Alle drei Tabellen besitzen `workspace_id`, zusammengesetzte Tenant-FKs,
ENABLE/FORCE RLS, exakt eine permissive `tenant_isolation`-Policy, exakte
Rollen-ACLs und WORM- beziehungsweise spaltenbegrenzte Guards. Runtime und
Worker erhalten keinerlei DML auf den neuen Importtabellen und kein TRUNCATE,
sondern ausschließlich `EXECUTE` auf versionierten, `SECURITY DEFINER`-
Importfunktionen. `app_worker` bleibt zusätzlich ohne Katalog-DML;
`app_runtime` behält unverändert die von der manuellen M1-08-Pflege benötigten
Katalogrechte. Alle Gateways besitzen festen `search_path`, Callerprüfung und
vollständige Objektbindung.

Runtime-Gateways laufen über den bestehenden `withSessionTenant()`-Pfad und
lesen dessen `app.actor_id` über `app_actor_id()`, sperren zuerst
den Workspace, autorisieren danach die aktuelle interne Membership und exakt
`catalog.manage`, `price.edit`, `price.read_purchase` und erzeugen Vorschau,
Start, Cancel sowie private Reads. Vorschaujob und sämtliche Zeilen werden in
einer äußeren Transaktion geschrieben und koppeln darin atomar den ersten
ID-only Expiry-/Cleanup-Dispatch für `preview_expires_at`; Start prüft Counts
und sämtliche Hashbindungen erneut. Der erste Start setzt
`execution_actor_id` unveränderlich.

Worker-Gateways ignorieren einen vom Prozess gelieferten Actor. Sie binden
Job, Row, Lease-Token, `lease_generation`, Zeilennummer und den gespeicherten
`execution_actor_id`, sperren Workspace vor Membership, prüfen die drei Rechte
vor Claim und erneut vor jeder Zeilenmutation und setzen für Event/Audit intern
`app.actor_id` auf diesen Actor. Entzug serialisiert gegen den Workspace-Lock
und terminalisiert commitbar; der Adapter wirft danach nicht innerhalb
derselben Transaktion. Der Import ändert damit die M1-08-Rechteaussage nur um
diesen engen Gateway: `app_worker` bekommt weiterhin keine generischen
Katalogrechte.

Der Zeilen-Gateway akzeptiert ausschließlich Workspace-ID, Import-ID,
Zeilennummer, Lease-Token und `lease_generation`; weder Command-JSON,
Zielsnapshot, Actor noch dynamische Spaltennamen kommen aus dem Worker. Er lädt
die immutable Zeile selbst, wiederholt Digest-/Shape-/Preconditionprüfungen und
führt genau eine Zeile atomar aus. Event und Audit enthalten nur IDs,
Revision, Operation, feste Codes und eine gekürzte Hashreferenz; der bestehende
manuelle Helper mit vollem `snapshotSha256` wird nicht blind wiederverwendet.

Versionierte SQL-Gateways v1:

```text
Runtime EXECUTE:
prepare_catalog_import_v1(workspace_id, intent_id, preview_json)
start_catalog_import_v1(workspace_id, import_id, rights_attestation_version)
cancel_catalog_import_v1(workspace_id, import_id)
read_catalog_import_v1(workspace_id, import_id)
read_catalog_import_rows_v1(workspace_id, import_id, after_row, limit)
read_latest_catalog_import_id_v1(workspace_id)

Worker EXECUTE:
claim_catalog_import_v1(workspace_id, import_id, dispatch_id, batch_limit)
apply_catalog_import_row_v1(workspace_id, import_id, row_number,
                            lease_token, lease_generation)
complete_catalog_import_batch_v1(workspace_id, import_id,
                                 lease_token, lease_generation)
finalize_catalog_import_failure_v1(workspace_id, import_id,
                                   lease_token, lease_generation, fixed_code)
record_catalog_import_preclaim_failure_v1(workspace_id, import_id,
                                          dispatch_id, fixed_code)
record_catalog_import_dispatch_failure_v1(workspace_id, import_id,
                                          dispatch_id, fixed_code)
recover_catalog_imports_v1(workspace_id, limit)
cleanup_catalog_import_snapshots_v1(workspace_id, limit)

pgboss SECURITY INVOKER (app_worker):
pgboss.list_catalog_import_recovery_locator_jobs_v1(after_job_id, limit)
pgboss.list_catalog_import_cleanup_locator_jobs_v1(after_job_id, limit)
pgboss.quarantine_catalog_import_locator_job_v1(locator_job_id)
```

`batch_limit` liegt geschlossen bei 1–25. `read_catalog_import_rows_v1`
akzeptiert `after_row` 1–1001 und `limit` 1–100. Recovery, Cleanup und beide
Locator akzeptieren `limit` 1–100. Für beide Locator bedeutet
`after_job_id = NULL` ausschließlich die erste
Seite; danach ist ein nicht-NULL UUID-Cursor des zuletzt gelesenen Locatorjobs
Pflicht. Andere NULL-Parameter, leere/malformed UUID-Texte und unbekannte
Cursorwerte werden fail-closed abgelehnt. Für Lease-Failure ist `fixed_code`
einer der drei retriable Codes
`lease_lost|enqueue_failed|queue_locator_invalid`; Preclaim- und der
zustandsbewusste Dispatch-Failure-Gateway akzeptieren ausschließlich
`enqueue_failed|queue_locator_invalid`. Der jeweilige Gateway leitet Count und
Endcode selbst ab und bindet Replay an Dispatch-ID und Ursache. Null, 0,
Übermaximum und jeder nicht erlaubte Code werden vor Objektmutation abgelehnt.
Trifft eine abweichende Locatorjob-ID auf eine abgelaufene Running-Lease, wird
der eine Lease-Failure-Entscheid atomar als Lease-Receipt unter dem Lease-Token
und als Preclaim-Alias unter der Locatorjob-ID belegt. Der Alias kann dadurch
niemals als Lease-Token replayen. Ein Crash vor der separaten Quarantäne
replayt denselben Count und lässt den Locator erneut quarantänisieren.

Alle Runtime-/Worker-Domainfunktionen sind ownergebunden, `SECURITY DEFINER`,
besitzen festen `search_path`, keine PUBLIC-Ausführung und einen gepinnten
Bodyhash im Rollenvertrag. Read/Report sind paginiert und geben nur explizit
erlaubte Spalten zurück. Die beiden schemaqualifizierten globalen Locator
lesen niemals FORCE-RLS-Domaintabellen: Sie sind `SECURITY INVOKER`,
app_worker-owned und lesen ausschließlich die
eigenen pg-boss-ID-only-Jobs. Sie liefern je Zeile Locatorjob-ID, optional
bindbare Workspace-/Import-ID und exakt den Status
`valid|queue_locator_invalid`; malformed Payloads vergiften daher keine
gesamte Seite. Danach setzt der Worker den Tenantkontext und ruft den
tenantgebundenen CAS-Gateway auf. Ein separater app_worker-eigener Invoker
quarantänisiert ausschließlich tatsächlich malformed Katalog-Locatorjobs und
weist gültige sowie fachfremde Jobs zurück. Keine Rolle erhält BYPASSRLS und
kein Definer schaltet Row Security aus.

Auch beide Locator und der Quarantäne-Gateway besitzen
`REVOKE ALL ... FROM PUBLIC`. Ihre Bodies referenzieren jedes pg-boss-Objekt
schemaqualifiziert, arbeiten mit einem festen sicheren Suchpfad und werden samt
Owner, Security-Modus, ACL und Bodyhash im Rollenvertrag attestiert.

## Zustandsmaschine

```text
missing
  → ready_for_review
  → queued
  → running

running → queued          (erfolgreicher Batch, weitere valide Zeilen)
running → retry_wait      (erster/zweiter technischer Fehler)
queued → retry_wait       (erster technischer Pre-Claim-/Recoveryfehler)
retry_wait → retry_wait   (zweiter technischer Pre-Claim-/Recoveryfehler)
retry_wait → running      (direkter neuer Claim; kein queued-Zwischenzustand)
running → succeeded       (keine Zeilenfehler/Conflicts)
running → partial         (mindestens ein Resultat und mindestens ein Fehler)
running → failed_final    (kein fachlicher Erfolg oder dritter technischer Fehler)
queued|retry_wait → failed_final
                           (Revocation oder Inputkorruption; Count 0)
retry_wait(2) → failed_final
                           (dritter Technikfehler; Count 3)

ready_for_review → cancelled_before_start
```

Ein Start mit null validen Zeilen ist unzulässig. Pro Workspace darf höchstens
ein Job in `queued|running|retry_wait` stehen. Ein Claim bindet DB-autoritativ
höchstens 25 eindeutige, noch nicht erledigte Zeilennummern in
`lease_row_numbers`; jede Row-Funktion weist eine 26. Zeile, falschen Token,
alte Generation oder abgelaufene Lease per CAS ab. Die Queue enthält
ausschließlich Contractversion, Workspace-ID und Import-ID. Claim und
Lease-Guard erzwingen darüber hinaus ausschließlich eindeutige, nicht-NULL
Zeilennummern im gültigen CSV-Datenbereich 2 bis 1001.
`running` besitzt genau dann Token, Ablaufzeit und 1 bis 25 Lease-Zeilen
sämtlich non-null; in jedem anderen Zustand sind alle drei Felder `NULL`.

`lease_generation` steigt bei jedem Claim ohne fachliches Dreierlimit. Nur
technische Fehler/Lease-Abläufe erhöhen `consecutive_failure_count` bis drei;
ein technisch erfolgreich abgeschlossenes Batch setzt ihn auf null. So sind
1.000 Zeilen in mindestens 40 erfolgreichen 25er-Batches zulässig. Das
pg-boss-Transportlimit `retryLimit=10` ist davon getrennt.

Die Zustandsform ist geschlossen: `ready_for_review`, `queued`, `succeeded`,
`partial` und `cancelled_before_start` besitzen Failure-Count 0, `running`
erlaubt 0 bis 2 und `retry_wait` genau 1 bis 2. Ein Retry-Dispatch verändert
den Domainzustand nicht; der Claim wechselt direkt von `retry_wait` nach
`running`, behält den Count und löscht nur den Retrycode. Ein erfolgreicher
Batch setzt den Count vor `queued|succeeded|partial` auf 0. Der dritte
aufeinanderfolgende technische Fehler wechselt unmittelbar nach `failed_final`
mit Count 3 und ausschließlich `technical_retry_exhausted`; fachliche und
Autorisierungs-Endzustände besitzen Count 0.
`retry_wait` speichert den letzten festen retriable Code aus
`lease_lost|enqueue_failed|queue_locator_invalid`. Freie Fehlermeldungen werden
nie persistiert.

Die Vor-Claim-Reautorisierung darf keinen unautorisierten Running-Zustand
erzeugen. Bei entzogenem Actor beziehungsweise Capability oder einem bereits
vor Claim erkannten korrupten Input terminalisiert der Gateway daher direkt
aus `queued|retry_wait`, setzt technische Count-/Retryfelder auf 0/NULL und
persistiert ausschließlich den passenden festen Endcode.

Die erlaubten `failed_final`-Paare sind abschließend
`(3, technical_retry_exhausted)`, `(0, actor_revoked)`,
`(0, capability_revoked)`, `(0, invalid_persisted_input)` und
`(0, all_rows_conflicted)`. Retrycodes selbst sind niemals Endcodes.

Scheitert ein atomarer Enqueue, rollt dessen Domaintransaktion zunächst
vollständig zurück. Der äußere Recoverypfad persistiert den festen technischen
Fehler danach in einer neuen engen Transaktion: `queued → retry_wait(1)`,
`retry_wait(1) → retry_wait(2)` oder beim dritten aufeinanderfolgenden Fehler
direkt `retry_wait(2) → failed_final(3, technical_retry_exhausted)`.
Dasselbe gilt für einen jobbezogen auflösbaren ungültigen Queue-Locator.

Start, Retry, Claim-Sentinel und Batchfortschritt erzeugen den nächsten
ID-only-Dispatch atomar in derselben DB-Transaktion. Claim legt einen
verzögerten Sentinel zur Lease-Fälligkeit an; erfolgreicher Batchfortschritt
stellt denselben nächsten Dispatch sofort fällig. Recovery erfasst auch
`queued` ohne zustellbaren Job sowie `retry_wait`, abgelaufene `running`-
Leases und malformed/failed Queue-Locators. Bereits committete Resultate
werden bei Crash-Replay übersprungen.

## Rechte und Datenschutz

- Lesen des Workspace-Katalogs bleibt `catalog.read`.
- Upload, Vorschau, Start, Abbruch und Importreport verlangen gemeinsam
  `catalog.manage`, `price.edit` und `price.read_purchase`.
- `admin` erfüllt Einzelrechte wie im bestehenden zentralen `can()`-Vertrag;
  ein Editor benötigt die expliziten Capabilities.
- `external_only` ist immer ausgeschlossen.
- Vor dem ersten Start bestätigt der Actor bewusst
  `catalog-import-rights-attestation.v1` (eigene oder ausdrücklich
  autorisierte Daten). Die exakten UTF-8-Bytes ohne BOM und ohne abschließenden
  Zeilenumbruch lauten: `Ich bestätige, dass dieser Workspace zur Verarbeitung
  und Nutzung der in dieser CSV enthaltenen Produkt-, Preis- und
  Provenienzdaten berechtigt ist.` Ihr SHA-256 ist
  `4511413a407acc4c073184ecbb127b449b13c72db28fe8b1682ba17cced1b4f8`.
  Die Attestation wird mit Actor, Datei-, Mapping- und Reservationhash,
  Version, Text-Digest und DB-Zeit gebunden; CSV-`*RightsBasis`-Werte ersetzen
  diese Autorität nicht.
- Jede Action und Route reautorisiert Session, Workspace, Rolle, Objektbindung
  und Importzustand; UI-Gates sind keine Sicherheitsgrenze.
- Fremdtenant und erratene IDs liefern kein Objektoracle.
- Events/Audits enthalten nur Import-/Component-ID, Revision, Zustand, Counts,
  feste Codes und die ersten exakt 16 lowercase Hexzeichen eines SHA-256 als
  nichtautoritative Hashreferenz; niemals Datei, Rohzeile, Beträge,
  freie Provenienztexte oder Vollhashes.
- Fehler-CSV neutralisiert Zellen, die beim Öffnen in Tabellenprogrammen als
  Formel interpretiert werden könnten.

## Portaloberflächen

- `/w/{workspaceId}/katalog`: Link und letzter Importstatus nur für
  Importberechtigte.
- `/w/{workspaceId}/katalog/import`: Datei, serverseitig bestätigte
  Encoding-/Delimitererkennung, Mapping, Grenzwerte und Vorschauaktion. Upload
  läuft nicht über eine Server Action, sondern über einen same-origin
  Route-Handler mit `application/vnd.wmee.catalog-csv-preview.v1`: vier Byte
  Big-Endian-Metadatenlänge (maximal 32 KiB), danach dieses strict UTF-8-JSON
  und danach die unveränderten CSV-Bytes. Das versionierte Metadatenobjekt
  enthält Modus `inspect|preview`, Import-Intent, NFKC-normalisierten
  Dateinamen und optional das Mapping; unbekannte Keys sind verboten. Der
  Stream ist auf `4 + 32 KiB + 1 MiB` plus ein Erkennungsbyte begrenzt,
  Dateibytes separat exakt auf 1 MiB. Origin/`Sec-Fetch-Site`/Session werden
  geprüft; fehlender/ungültiger Dateiname, Metadatenüberlauf und Bodyüberlauf
  scheitern vor Parser/Persistenz.
  Inspektion und persistierte Vorschau senden dieselbe lokale Datei erneut;
  dadurch braucht der Server keine temporäre Rohdatei.
- `/w/{workspaceId}/katalog/importe/{importId}`: Counts, feste Fehler,
  rechtegeschützte normalisierte Technik-, EK-/VK- und Provenienzvorschau,
  Start-/Abbruchaktion, aktiver Fortschritt, Ergebnislinks.
- privater Fehlerreport als `text/csv; charset=utf-8`, `private, no-store`.
- private kanonische Vorlage mit UTF-8-BOM und Semikolon.

Erforderliche UI-Zustände: Loading, Empty, Mapping unvollständig, Parserfehler,
Ready, Duplicate-Replay, Queued, Running, Retry, Partial, Success,
Failed-final, Cancelled, Permission denied und Session expired. Formfehler
führen den Fokus zum ersten betroffenen Feld. Keyboard, 320-CSS-px-Reflow,
400-%-Zoom, Reduced Motion und Axe werden geprüft.

## Worker- und Betriebsvertrag

- Queues `catalog.import.v1` und `catalog.import.cleanup.v1`, vor `work()`
  explizit angelegt;
- Queueoptionen sind im Bootstrap und Worker identisch gepinnt; Migration 0036
  attestiert pg-boss v38 und den Queuevertrag bei Fresh und Upgrade;
- ID-only-Payload; der Worker lädt nur über die engen Definer-Gateways;
- eigener kleiner Fachpool neben dem pg-boss-Adapterpool;
- Portal bleibt bei Worker-Ausfall verfügbar und zeigt den ehrlichen Zustand;
- Recovery-Sweep repariert `queued` ohne Zustellung, fällige Retryzustände,
  abgelaufene Leases und sichere malformed/failed Locator-Fälle;
- Start, Sentinel, Batchfortschritt, Terminalisierung, Preview-Ablauf und
  Cleanup-Due schreiben Domainzustand und den passenden pg-boss-Dispatch in
  derselben äußeren DB-Transaktion; ohne Dispatch committen sie nicht;
- globale Recovery-/Cleanup-Locators lesen nur pg-boss-ID-only-Jobs;
  jede Domainmutation erfolgt danach im gesetzten Tenantkontext;
- Workerlogs enthalten ausschließlich Job-ID, sichere Zustände und feste Codes;
- der `catalog.import.v1`-Handler nutzt kein Netzwerk, Dateisystem, Provider
  oder Storage; der gemeinsame Workerprozess behält nur seine bereits
  vorhandenen, anders gebundenen Offer-/Rendererfähigkeiten;
- produktiver Worker-Rollout bleibt ein separates externes Gate.

## Tests und Abnahme

- `M108B-CONTRACT-01`: Encoding, Delimiter, Mapping, alle sieben Typen,
  Geld-/Provenienzfelder, JSON-Attributes, exakte Basispoint-/Hundredths-
  Konversion, Limits, Hashing und alle vier Fehlercodeklassen.
- `M108B-ROUTE-01`: Wire-v1-Metadaten/Dateiname/Mapping, gültiges Maximum,
  32-KiB-Metadatenüberlauf, 1 MiB, 1 MiB+1, Content-Type, Origin und Session.
- `M108B-SVC-01`: Preview, Reservation, Start/Cancel, Create/Revise/Unchanged,
  93/7-Teilerfolg, Replay, Drift, Rollback je Zeile.
- `M108B-DB-01`: Fresh-/Upgrade-Migration, RLS/FORCE, FKs, Checks, WORM/
  einmalige Redaction, ACLs, Preview-Atomizität, leere DB und Schema-Drift;
  echte Negativproben lehnen insbesondere Terminalzustand ohne Cleanup-Due,
  teilweise Expected-Bindungen, Erfolg ohne Revision, aktiven Failure-Count 3,
  Running-Lease ohne Zeilen, partielle Lease-Bindungen, Leasefelder außerhalb
  von Running sowie NULL-, Duplikat-, 1-, 1002- oder 26er-Leases und jeden
  Digest-/JSON-Semantikdrift ab. Fehlende, zusätzliche oder falsche
  `source.fileSha256`, `source.mappingSha256`, Operation-, Target-, Expected-
  und SealedTarget-Keys sowie `unchanged`-Payloaddrift werden separat an
  Prepare, Start und Apply geprüft. Per-Body-Maxima und die aus echten
  Bytegrößen abgeleitete 30-MiB-Grenze besitzen Grenztests. Attestationstests
  lehnen falsche Version, falschen Text-Digest, Actor-Mismatch und abweichenden
  Start-Replay ab. Gatewaytests lehnen `batch_limit` 0/26, Pagination 0/über
  Maximum, fremde `fixed_code`, Runtime↔Worker-EXECUTE-Kreuzaufrufe und fremde
  Tenant-/Objektbindungen ab.
- `M108B-RBAC-01`: Admin, vollständiger Editor, unvollständiger Editor,
  Viewer, External, revoked actor und fremder Tenant.
- `M108B-PRIVACY-01`: keine Preise/Rohzeilen/freien Quellen/Vollhashes in
  Events, Audit, Reportmetadaten oder Logs; exakt 16 Hexzeichen erlaubt,
  64-Hex-Vollhash explizit abgelehnt.
- `M108B-WORKER-01`: ID-only, exakt 40 erfolgreiche Batches für 1.000 Zeilen,
  26.-Zeile abgelehnt, alte/neue Lease-CAS, Crash nach Teilbatch und vor
  Enqueue, `queued`-/Retry-/Lease-/Locator-Recovery, Shutdown und Poolgrenzen.
- `M108B-RETENTION-01`: ab Due-Grenze werden Dateiname, normalisierte SKU,
  Mapping, Command, versiegelter Zielstand, kanonische Bodybytes und freie
  Fehler-`sourceHeader` atomar/idempotent redigiert; vor Due, nichtterminal,
  Teilredaction und spätere Payloadmutation scheitern; SLO/Alarm sind messbar.
- `M108B-PREVIEW-TTL-01`: nicht gestartete Vorschau auto-cancelt nach exakt
  sieben Tagen und wird spätestens zur 30-Tage-Due-Grenze vollständig
  redigiert; Replay/Start an der Ablauf-CAS sind race-sicher.
- `M108B-E2E-01`: Datei → Mapping → Vorschau → 93/7 → Start → Resultat/Report.
- `M108B-E2E-02`: importierte Produkte → Aktivierung → Projektauflösung →
  Basis-BOM; Reimport → Stale → neue Resolution/Basis ohne Mutation der alten.
- `M108B-E2E-03`: neues Intent mit identischen Bytes nach Reaktivierung/Drift
  sowie aktive importierte SKU hinter Katalogeintrag 200 → Resolution → BOM.
- `M108B-A11Y-01`: Keyboard, Fokus, Axe und Reflow.

Danach vollständig: Lint, Next-Typegen, TypeScript, Dependency-Cruiser,
Vitest, reale PostgreSQL-18-Tests, Rollenproben, Migration aus leerer DB,
Upgrade-Migration, Production-Build und Chromium-E2E.

## Tatsächlicher Abnahmestand vom 31. August 2026

- `npm run check` ist auf dem aktuellen Dirty-Worktree vollständig grün:
  Lint, Next-Typegen/TypeScript, Contract-Drift, Dependency-Cruiser, 144/144
  Testdateien mit 1.371 bestandenen und einem ausdrücklich opt-in
  übersprungenen Test sowie 88/88 Rollen- und 5/5 PG18-Proben.
- Das generierte Schema ist mit SHA-256
  `5e1bc0ee180439944953106f17c3de1d551b320fd555c442a14797cac16f9e1b`
  gepinnt; Dependency-Cruiser prüfte 276 Module und 946 Abhängigkeiten.
- Der vollständige Chromium-Lauf bestand 24 Fälle bei einem opt-in
  übersprungenen Visual-Candidate-Fall. Der fokussierte M1-08b-Lauf bestand
  7/7 einschließlich echtem separatem Strict-Role-Worker, drei RBAC-
  Negativrollen und A11y/Reflow.
- Unit-/DB-Evidenz belegt exakt 40 erfolgreiche 25er-Batches für 1.000
  Zeilen. Production-Build und `db:generate` sind grün.
- Ein unabhängiger read-only Abschlussreview fand keine belastbaren P0–P2-
  Befunde.

Diese lokale Abnahme verwendete ausschließlich synthetische beziehungsweise
selbst autorisierte Testdaten. Es wurde keine reale WMEE-/Lieferantendatei
importiert, kein Reonic-Innenzugang verwendet und kein Commit, Push, Deploy,
Providerkauf oder produktiver Worker-Rollout ausgeführt.

## Nichtziele

- kein Reonic-Katalog, keine Reonic-SKU, Preise, Texte, Bilder oder Datenblätter;
- kein realer WMEE-/Lieferantenimport ohne autorisierte Datei;
- kein XLSX, DATANORM, IDS-Connect, Großhandelsfeed oder Live-Preis-Sync;
- kein Asset-/Datenblatt-Upload und kein Object Storage;
- kein automatisches Matching, keine Kompatibilitäts- oder
  Herstellerempfehlung;
- keine automatische Aktivierung und keine Paket-/Offer-Templates;
- kein Klimaanlagenmodell über den unzureichenden Typ `other`;
- keine Projektzuweisung, Teams oder External-Freischaltung;
- kein Deploy, Push, Providerkauf oder produktiver Import.
