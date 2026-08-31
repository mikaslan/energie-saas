# ADR 0013: Persistierte Katalog-CSV-Vorschau und begrenzter Importworker

- Status: angenommen
- Datum: 2026-08-31
- Bezug: `docs/spec/M1-08b-katalog-csv-import.md`

## Kontext

M1-08a besitzt bereits die fachliche Wahrheit für Produktidentität,
append-only Revisionen, Preise, Provenienz, Aktivierung und Stale-Ableitung.
Der Katalog startet rechtmäßig leer; Einzelpflege skaliert jedoch nicht auf
ein echtes Sortiment. Ein Import darf deshalb weder einen zweiten
Katalogpfad noch einen langen Server-Request mit unklaren Teilerfolgen bauen.

Deutsche CSV-Dateien enthalten regelmäßig Semikolon, Komma-Dezimalwerte und
Windows-1252. Gleichzeitig sind Datei, Mapping, Preisfelder und technische
Freitexte untrusted. Ein vollständiges Alles-oder-nichts-Batch wäre bei einer
gewachsenen Liste praktisch unbrauchbar; ein ungeprüfter Best-effort-Import
würde dagegen nicht reproduzierbare Produktstände erzeugen.

## Entscheidung

Der Import wird zweistufig und persistent:

1. Der Portalservice parst die Datei serverseitig, validiert Mapping und jede
   Zeile, bildet Datei-/Mapping-/Zeilen-/Commandhashes und speichert eine
   immutable Vorschau. Er schreibt noch keinen Katalogstand.
2. Nach expliziter Bestätigung verarbeitet ein pg-boss-Worker ausschließlich
   valide Zeilen in begrenzten Batches. Die Queue transportiert nur
   Contractversion, Workspace-ID und Import-ID.

Teilerfolg ist vertraglich. Jede valide Zeile besitzt eine eigene
Tenant-Transaktion. Produktrevision, Project-Stale, Domain Event, Audit und
append-only Zeilenresultat committen gemeinsam. Ungültige oder später
konfliktierende Zeilen verändern keinen Produktstand und verhindern nicht die
anderen validen Zeilen.

Der Import verwendet denselben kanonischen Seal-Vertrag und dieselben Lock-,
Revision-, Event-, Audit- und Stale-Invarianten wie die manuelle
Katalogpflege. Weil `app_worker` absichtlich keine Katalog-DML besitzt, führt
eine enge versionierte `SECURITY DEFINER`-Funktion die atomare Vollzeilen-
Mutation `create|revise|unchanged` aus. Sie bindet Job, Row, Lease und den
gespeicherten Start-Actor und ist durch Äquivalenztests gegen den manuellen
Pfad abgesichert. Es gibt kein direktes `INSERT catalog_component...` aus
Route, Parser- oder Workeradapter.

Der Worker übergibt an diese Funktion nur Objekt- und Lease-IDs. Für
`create|revise` persistiert der Previewservice einen immutable versiegelten
Zielstand plus dessen JCS-kanonischen Body; bei `unchanged` sind beide
Targetfelder zwingend `NULL` und die gesperrte aktuelle Katalogrevision ist der
Vergleichsstand. Die DB hasht Mapping-, Quellcommand-, Row-Command- und
vorhandenen Zielbody mit dem in PostgreSQL 18 eingebauten `pg_catalog.sha256`, vergleicht
Hashspalten sowie eingebettete Hashwerte, parst jeden Body und verlangt
semantische Gleichheit zum jeweiligen Mapping, Command oder Zielstand. Alle
eingebetteten Operationen, IDs, Job-/Datei-/Mapping-/Zeilenhashes und
Expected-Werte werden gegen die persistierten Spalten und den gesperrten Job
gebunden. Damit muss PostgreSQL JCS nicht neu implementieren, prüft aber die
vom bestehenden TypeScript-Sealer erzeugten Artefakte selbst. Event/Audit
verwenden für diesen Pfad bewusst nur eine gekürzte Hashreferenz, weil der
manuelle Helper derzeit Vollhashes schreibt.

`unchanged` wird an Prepare, Start und Apply nicht allein aus Metadaten
abgeleitet. Der Gateway sperrt die aktuelle Katalogrevision und vergleicht ihre
Darstellung, Technik, Commercial-Daten und technische Provenienz kanonisch mit
dem gespeicherten Quellcommand. Nur exakte Nutzdatengleichheit ist unverändert.
Geänderte Produkte enden wie manuelle Änderungen als `draft`; Aktivierung
bleibt ein bewusster getrennter Schritt.

Die Rohdatei wird nach dem Parsing nicht gespeichert. Persistiert werden
Datei-Hash, versionierter Mapping-Snapshot samt kanonischen Bodybytes und Hash,
geschlossene normalisierte Commandsnapshots samt kanonischen Quell-/Row-
Command-Bodybytes und minimierte Fehler. Der Commandsnapshot ist
bis zur Redaction ausdrücklich eine geschützte zweite Kopie von Technik,
EK/VK und Provenienz. Quoten begrenzen Vorschauen und 30 MiB unredactete Daten
je Workspace. Ungestartete Vorschauen auto-canceln nach sieben Tagen DB-Zeit.
Ab `greatest(created_at + 30 days, terminal_at)` muss ein enger Cleanup-Gateway
Dateiname, normalisierte SKU, Mapping-, Command-, versiegelten Zielstand und alle kanonischen
Bodybytes gemeinsam irreversibel nullen sowie freie Fehler-Quellheader auf
`null` redigieren. Teilredaction ist durch Guards unmöglich. Der stündliche
Sweep hat ein SLO von Cleanup-Due plus einer Stunde; über 24 Stunden nach Due
Überfälligkeit alarmiert und besitzt einen manuellen Recoverypfad. Hash,
erwartete Bindungen, minimierte Fehler, Resultat und Produktbindung bleiben
append-only.

Private SQL-Validatoren prüfen exakte Schlüsselsets, Typen, Versionen, Enums
und Grenzen aller Mapping-, Command-, Expected-, SealedTarget- und
Fehlerobjekte. Tabellen-Guards und jeder Prepare-/Start-/Apply-Gateway rufen
sie fail-closed auf; Datei- und Mappinghash aus dem Source-Command werden dabei
gegen den gesperrten Job gebunden. Per-Body-Grenzen sind 32/64/256/64 KiB für
Mapping/Source/Row/Target. Das 30-MiB-Budget wird unter Workspace-Lock aus
tatsächlichen `octet_length`-/`pg_column_size`-Werten berechnet und durch einen
deferred Validator an den gespeicherten Zähler gebunden.
Vollredaction setzt Job- und Row-Zähler gemeinsam auf 0; dadurch bleibt die
Bytegleichheit auch danach unkonditional prüfbar.

Job- und Row-BEFORE-Guards begrenzen Mutationen; ein deferred Constraint-
Trigger prüft am Transaktionsende identische DB-Redactionzeit, Due und alle
Rows. Dadurch sind Job-only-, Teil-Row-, Früh- und Replayredaction selbst für
direkte Owner-DML ungültig.

Pro Workspace darf höchstens ein Job aktiv laufen. Ein Claim bindet höchstens
25 Zeilennummern DB-autoritativ an Token und unbeschränkte
`lease_generation`. Nur aufeinanderfolgende technische Fehler zählen bis
drei; erfolgreiche Batches setzen diesen Zähler zurück, sodass 1.000 Zeilen
40 oder mehr Claims durchlaufen können. Start, Lease-Sentinel, Retry und
Batchfortschritt enqueueen den nächsten ID-only-Dispatch atomar. Replay
desselben Import-Intents ist idempotent; ein neues Intent darf dieselben Bytes
nach einem Terminalzustand bewusst neu bewerten.

Failure-Counts sind zustandsgebunden: 0 für Review, Queue und fachliche
Terminalzustände, 0–2 für Running und 1–2 für Retry-Wait. Ein Retry bleibt bis
zum direkten neuen Claim in Retry-Wait; der Claim behält den Count und löscht
den Code. Erst ein erfolgreicher Batch setzt ihn zurück. Fehler drei endet als
Failed-Final `(3, technical_retry_exhausted)`. Die einzigen weiteren Endpaare
sind `(0, actor_revoked)`, `(0, capability_revoked)`,
`(0, invalid_persisted_input)` und `(0, all_rows_conflicted)`. Retry-Wait
bewahrt ausschließlich `lease_lost`, `enqueue_failed` oder
`queue_locator_invalid`. Claim und Lease-Guard erlauben nur eindeutige,
nicht-NULL Zeilennummern 2 bis 1001. Genau Running besitzt vollständig Token,
Expiry und 1–25 Zeilen; jeder andere Zustand besitzt keines der drei Felder.
Vor Claim erkannte Actor-/Capability-Revocation oder Inputkorruption
terminalisiert direkt aus Queue oder Retry-Wait mit Count 0; der Gateway darf
dafür keinen unautorisierten Running-Zustand erzeugen.
Ein fehlgeschlagener atomarer Enqueue rollt zuerst vollständig zurück; ein
enger äußerer Recovery-Gateway zählt ihn anschließend als festen Pre-Claim-
Fehler `queued→retry_wait(1)`, `retry_wait(1)→retry_wait(2)` oder beim dritten
Mal aus `retry_wait(2)` als `failed_final(3, technical_retry_exhausted)`.
Jobbezogen auflösbare Locatorfehler verwenden dieselbe Kaskade.

Recovery und Cleanup beginnen über globale, paginierte `SECURITY INVOKER`-
Locators im app_worker-eigenen pg-boss-Schema. Sie lesen ausschließlich
ID-only-Locatorjobs, nie FORCE-RLS-Domaintabellen. Jede Locatorzeile wird
geschlossen als `valid` oder `queue_locator_invalid` klassifiziert; ein
malformed Payload verwirft deshalb nicht die gesamte Seite. Soweit Workspace-
und Import-ID bindbar sind, zeichnet ein zustandsbewusster Domain-Gateway den
Fehler genau einmal auf. Danach beziehungsweise bei unbindbaren IDs darf ein
enger app_worker-eigener Gateway ausschließlich den malformed Locatorjob
quarantänisieren; gültige oder fachfremde Jobs werden abgelehnt. Bei einer
abgelaufenen Running-Lease bindet der Gateway denselben Failure-Entscheid als
Lease-Receipt an das Lease-Token und als Preclaim-Alias an eine davon
abweichende Locatorjob-ID.
Scheitert die nachgelagerte Quarantäne, replayt derselbe Locator deshalb ohne
weiteren Failure-Count und bleibt erneut quarantänisierbar. Der Worker setzt
für Domainoperationen den Tenantkontext und ruft objektgebundene
CAS-Gateways auf; global gelesen werden nur Locatorjob-, Workspace- und
Import-ID plus der feste Locatorstatus, niemals Domain- oder Sensitivpayload.
Es gibt keine globale Domainmutation, kein BYPASSRLS und kein
`row_security=off`. Bereits Preview-Erzeugung und danach Start, Sentinel,
Batch, Terminal-/Expirytransition und Cleanup koppeln Domain-Gateway und
appworker-eigenes Enqueue in derselben äußeren Transaktion.
Bis zur Terminalisierung bleibt `snapshot_cleanup_due_at` zwingend `NULL`;
ein Cleanup nichtterminaler Jobs ist verboten.
Beide Locator und der Quarantäne-Gateway sind app_worker-owned,
schemaqualifiziert, mit festem Suchpfad und für PUBLIC vollständig entzogen;
Security-Modus, ACL und Bodyhash gehören zum Rollenvertrag. Nur für die erste
Seite ist `after_job_id = NULL` erlaubt. Folgeseiten verwenden die UUID des
zuletzt gelesenen Locatorjobs; unbekannte Cursor und ungültige Limits werden
fail-closed abgelehnt, während malformed Payloads als einzelne geschlossene
Ergebniszeilen zurückkehren.

## Security-Auswirkungen

- Upload/Vorschau/Start/Report verlangen `catalog.manage`, `price.edit` und
  `price.read_purchase`; External bleibt ausgeschlossen.
- Attestation v1 pinnt exakt den in der Spec genannten 149-Byte-UTF-8-Text ohne
  Zeilenumbruch und Digest
  `4511413a407acc4c073184ecbb127b449b13c72db28fe8b1682ba17cced1b4f8`;
  Version, Digest, Actor und identischer Start-Replay werden DB-seitig geprüft.
- Runtimefunktionen laufen über `withSessionTenant()` und lesen den Actor aus
  `app_actor_id()`; Workerfunktionen
  ignorieren Prozess-Actorwerte, laden den unveränderlichen
  `execution_actor_id`, sperren Workspace vor Membership und prüfen vor Claim
  sowie jeder Zeile live alle drei Capabilities.
- `app_runtime` und `app_worker` erhalten keine Tabellen-DML auf die neuen
  Importtabellen, sondern nur `EXECUTE` auf enge Funktionen. `app_runtime`
  behält seine bestehenden manuellen M1-08-Katalogrechte; nur `app_worker`
  bleibt ohne Katalog-DML. Damit wird die
  M1-08-Aussage „keine Katalogrechte für app_worker“ ausschließlich um diesen
  objektgebundenen Gateway ergänzt; allgemeine Auth-, Settings-, Storage- oder
  zusätzliche Offer-Graph-Rechte entstehen nicht.
- Preise, Rohzeilen, freie Provenienztexte und Vollhashes gelangen nicht in
  Event, Audit oder Log. Eine nichtautoritative Referenz ist exakt der
  16-stellige lowercase-Hexpräfix.
- Fehlerreport-CSV neutralisiert Spreadsheet-Formeln.
- Revoked Actor und Drift werden beim Claim beziehungsweise je Zeile
  fail-closed behandelt. Terminalisierung wird als Envelope committet und
  nicht durch einen anschließenden Throw derselben Transaktion zurückgerollt.
- Die Start-Attestation `catalog-import-rights-attestation.v1` bindet bewusst
  Actor, Datei-/Mapping-/Reservationhash, Version, Erklärungstext-Hash und
  DB-Zeit; CSV-Inhalte können ihre eigene rechtliche Autorisierung nicht
  behaupten.

## Datenmigration und Recovery

Die Änderung ist expand-only: drei neue tenantgebundene Tabellen, Guards,
versionierte Runtime-/Worker-Funktionen, neue Policies/ACLs sowie zwei neue
Queue-Dispatches. Bootstrap erstellt `catalog.import.v1` und
`catalog.import.cleanup.v1` vor Migration/Worker;
Migration 0036 attestiert pg-boss v38 und identische Queueoptionen bei Fresh
und Upgrade. Bestehende Katalog-, Project- und Offer-Zeilen werden nicht
migriert oder zurückgeschrieben.

Produktionsrollback erfolgt forward-only: beide Queue-Registrierungen stoppen,
`ready_for_review|queued|retry_wait` sichtbar pausieren und in einer neuen
Migration erst nach belegter Nichtnutzung Funktionen/Rechte entfernen. Bereits
erzeugte Katalogrevisionen bleiben gültige historische Wahrheit; sie werden
nicht zurückgerollt.

## Konsequenzen

- Ein Nutzer sieht Fehler vor der Mutation und kann große Dateien ohne langen
  Portalrequest verarbeiten.
- 93 gültige und 7 ungültige Zeilen ergeben nachvollziehbar 93 Resultate und
  7 Fehler statt „alles fehlgeschlagen“.
- Imports bleiben reproduzierbar und auditierbar; normalisierte Preislisten
  existieren höchstens für die definierte geschützte Retention doppelt.
- Der Worker- und Rollenvertrag wird größer und benötigt eigene DB-, Recovery-
  und Shutdown-Tests.
- CSV ist produktiv erst mit einer autorisierten realen Datei nutzbar; die
  technische Abnahme erfolgt mit synthetischen Daten.

## Verworfen

### Gesamte Datei synchron in einer Server Action importieren

Verworfen wegen Requestdauer, schlechter Recovery, fehlender
Mandantenfairness und unklarem Zustand nach Prozessabbruch.

### Gesamtes Batch in einer Transaktion

Verworfen, weil ein einzelner historischer Zeilenfehler alle brauchbaren
Produkte blockiert. Zeile = Transaktion, Job = Bericht.

### Rohdatei dauerhaft speichern

Verworfen. Für Replay und Provenienz reichen Datei-Hash, Mapping und versiegelte
Zeilencommands; eine zweite Kopie kompletter Preislisten vergrößert den
Schutzbedarf ohne fachlichen Mehrwert.

### Import direkt in Tabellen schreiben

Verworfen. Das würde Seal-, Revisions-, Event-, Audit- und Stale-Invarianten
umgehen und einen zweiten Katalog-Wahrheitsweg schaffen.

### Automatische Aktivierung

Verworfen. Ein erfolgreicher Parserlauf ist keine menschliche Produkt- und
Preisfreigabe.
