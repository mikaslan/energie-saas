# ADR 0007: Site-Profilrevisionen und projektbezogene Berechnungssnapshots

- Status: angenommen
- Datum: 2026-08-29
- Bezug: `docs/spec/M1-07-energieprofil-planungsrechnung.md`

## Kontext

Der Rechner-V3-Intake speichert einen authentisch übertragenen, aber fachlich
unverifizierten `calculator_snapshot`. Sein Ergebnis nutzt Marktpreisannahmen
und darf keine Angebots- oder Serverwahrheit werden. Zugleich verlangt F1.4
Gebäude-/Energiedaten an der Site, während die Zielprodukte zum konkreten
Project gehören. Für reproduzierbare Berechnungen müssen Adresse, Pin,
Profil, Projektanforderung, Engine, Defaults und Wetterdaten gemeinsam
versioniert sein.

Eine Site kann mehrere Projects tragen. Das Energieprofil beschreibt das
Gebäude und soll deshalb geteilt werden; ein Rechenergebnis hängt zusätzlich
von der Absicht des einzelnen Projects ab und darf nicht geteilt werden.

## Entscheidung

Der unveränderliche Rechner-Snapshot bleibt reine Intake-Evidenz.

Gebäude-, Verbrauchs-, Bestandsanlagen- und Dachangaben werden als aktuelle
operative Wahrheit in genau einer optionalen `site_energy_profile`-Zeile je
Site gespeichert. Speichern ersetzt den Inhalt in place und erhöht atomar
einen positiven Revisionszähler. Alte Draft-Profile werden aus
Datenminimierungsgründen nicht dupliziert.

Systemverlust, Speicherwirkungsgrad/-entladetiefe, Degradation,
Betrachtungshorizont und Inbetriebnahme sind projekt-/variantenbezogen und
gehören nicht in die geteilte Site-Wahrheit. Der M1-07-Calculation-Request löst
sie je Feld als expliziten Rechnerinput mit Source-Pointer oder als
versionierten Default mit stabilem Schlüssel auf. Eine spätere manuelle
Änderung verlangt eine eigene Project-Settings-Revision; `known` im
Site-Profil bezeichnet nie einen Engine-Default.

Unbekannte Profilwerte bleiben speicherbar, dürfen aber nicht durch versteckte
Engineannahmen verschwinden. Dachverschattung muss für jedes berechnete Dach
bekannt sein; im Bestandszweig muss der Speicher `known_present` oder
`known_absent` sein. Contract, Input-Builder und Engine lehnen `unknown` an
diesen Stellen fail-closed ab. Damit sind weder ein pauschaler 0,9-
Verschattungsfaktor noch ein stiller 0-kWh-Bestandsspeicher zulässig.

Die menschliche Bestätigung wird durch eigene Confirmation-Felder derselben
Zeile an die exakte Profil- und Site-Adressrevision sowie deren
Pin-Bestätigungsrevision gebunden. Speichern setzt diese Bindung zurück;
Confirm verändert den Profilinhalt nicht. `current` beziehungsweise `stale`
wird beim Lesen aus den Revisionsbindungen abgeleitet.

Die erste wirksame Confirmation legt in derselben Transaktion genau einen
`project_calculation_job` mit einem schon vor Provider-I/O berechenbaren
Reservation-Key an. Der mutable Job trägt ausschließlich die enge
Queue-/Lease-/Retry-Zustandsmaschine; der finale Input-/Provider-Snapshot wird
einmalig gesetzt und bei Retries wiederverwendet.

Teure neue Reservations werden durch die versionierte Policy
`project-calculation-reservation-rate-limit.v1` begrenzt: 10 Sekunden
Actor-Cooldown, 30 neue Reservations je Actor und rollender Stunde sowie 300
je Workspace und rollender Stunde. Actor-Fenster sind innerhalb ihres
Workspace isoliert; alle Jobzustände einschließlich beider terminaler
Zustände zählen. Ein exakter Reservation-Replay wird zuerst erkannt, zählt
nicht erneut und darf auch bei ausgeschöpfter Quota einen fehlenden
`queued`-Dispatch reparieren. Nur neue Reservations nehmen in konsistenter
Reihenfolge einen workspaceweiten und danach einen workspace-/actorbezogenen
transaktionsgebundenen Advisory-Lock. Die maßgebliche Zeit ist ein nach beiden
Locks aufgenommenes `clock_timestamp()` der Datenbank, nicht Prozess- oder
Transaktionsstartzeit. `rate_limited` enthält keine Fach- oder Personendaten,
nur aufgerundete `retryAfterSeconds`; der Fehler rollt Confirmation,
Reservation, Event und Audit als eine Transaktion zurück.

Die technische Zustellung bleibt von der fachlichen Reservation getrennt, aber
atomar: Migration 0025 legt unter `app_worker` genau die SECURITY-DEFINER-Routine
`pgboss.enqueue_project_calculation(uuid,uuid)` an. Runtime erhält nur
`USAGE` auf das Schema und `EXECUTE` auf diese Routine, keinerlei pg-boss-
Relationsrecht. Die Routine akzeptiert ausschließlich einen RLS-sichtbaren,
`queued` Domainjob mit 32-Byte-Reservation und schreibt nur
`{schemaVersion, workspaceId, jobId}` in die vorab worker-initialisierte Queue
`calculation.execute`. pg-boss ist auf Schema v38, Queuepolicy `exclusive`,
initial `retryLimit=0` und `notify=false` gepinnt. Der idempotente
`db:pgboss:bootstrap` erzeugt diesen historischen Startvertrag vor 0025; er
stuft einen bereits wirksamen 0029-Stand niemals zurück. Advisory Lock, exakter
aktiver Singleton-Replay und zufällige technische pg-boss-ID liefern
Race-Idempotenz, ohne einen späteren fachlichen Retry durch eine terminale
Queuezeile zu sperren. Die additive Migration 0026 erweitert diese Naht
vorwärtskompatibel auf attempt-spezifische Singletons. Migration 0029 hebt die
technischen Vor-Claim-Zustellversuche auf zehn mit 1–60 Sekunden Backoff; der
fachliche `attempt_count` steigt weiterhin erst beim committeten Claim. Der
Claim materialisiert atomar einen
Recovery-Lauf zum Ablauf seiner 15-Minuten-Lease; ein Retry verschiebt genau
diesen Lauf auf den exponentiellen Backoff-Zeitpunkt. So bleiben Provider- und
Engineaufrufe außerhalb der Fachtransaktion, während Crash-Recovery, maximal
zehn Attempts und terminale No-ops ohne einen periodischen Scan funktionieren.
`app_migrator` besitzt dafür getrennte `NOINHERIT/NOADMIN/SET-only`-Kanten zu
`app_owner` und `app_worker`; zwischen den beiden Ownerrollen existiert keine
Membership.

Erfolgreiche Serverläufe werden getrennt davon pro Project als immutable
`project_calculation_revision` gespeichert. Sie binden die exakte
Site-Profilconfirmation, die aktuelle Project-Requirement-Revision,
Engine/Vertrag/Defaults sowie den normalisierten Provider- und Input-Snapshot.
Der semantische Input-Hash schließt nur volatile Fetchzeitpunkte aus, sortiert
roofId-Mengen und bindet alle übrigen IDs, Revisionen, Rohhashes, Serien und
Rezepte. Der Result-Hash schließt nur sein eigenes Feld aus.

Schema-, Hash- und mathematische Semantikprüfung bilden zunächst eine leichte
Paargrenze. Vor Persistenz und beim Lesen folgt zusätzlich ein modellexakter
Vergleich gegen den gepinnten Clean-Room-v1-Kern. Damit reichen passende
Gegenänderungen an `directConsumption`, `fromStorage`, `storageLoss`,
`storageFullCycles` und Einspeisung trotz neuem Result-Hash nicht aus. Die
Neuberechnung ist provider- und netzwerkfrei, auf den validierten
8.760-Stunden-Input begrenzt und schreibt selbst keinen Zustand.

Der CalculationPort ist die einzige Enginegrenze. UI-, Wizard-, URL- und
Rechner-Repository-Typen dürfen sie nicht durchdringen. M1-07 speichert nur
Energieergebnisse; die `market_estimate`-Wirtschaftlichkeit des heutigen
Rechnerkerns bleibt außerhalb.

Der stündliche Clean-Room-Kern verwendet eine zyklische Jahresrandbedingung:
Aus der geklemmten 8.760-Stunden-Abbildung wird ohne iterativen Warm-up der
deterministisch kleinste stationäre Ladezustand gewählt, sodass Anfangs- und
End-SOC identisch sind. Speicherenergie darf Monatsgrenzen überschreiten.
Darum prüft der Resultvertrag je Monat Einspeisung gegen Erzeugung sowie alle
Monats-/Jahressummen, aber nicht die fachlich falsche lokale Ungleichung
`selfConsumption + feedIn <= generation`. Die Jahresbilanz bleibt geschlossen;
als `storageLossKwh` gilt nur die reale ladeseitige Umwandlungsdifferenz, kein
offener End-SOC. Die paarweise Prüfung leitet diesen Verlust aus
`fromStorageKwh` und dem gepinnten Wirkungsgrad sowie `storageFullCycles` aus
entladener Energie und nutzbarer Kapazität ab. Direktverbrauch wird aus den
nicht negativen Stundenwerten summiert, damit separat gerundete Jahressummen
keinen negativen Kleinlastwert erzeugen.

Der EV-Ladeverbrauch wird unabhängig vom Wallbox-Produktwunsch aus Fahrleistung
und Ladeprofil aufgebaut. Bidirektionales Laden und Backup-Reserve verändern
M1-07 bewusst keine Energieflüsse; ein angefragtes Feature erzeugt stattdessen
einen stabilen Warncode und `fromVehicleKwh` bleibt nullenergetisch. Eine
spätere V2H-/Reservephysik verlangt einen neuen Model-Pin statt stiller
Semantik unter demselben Modell.

Resultvalidierung ist deshalb paarweise: Neben dem isolierten Schema und Hash
müssen Input-Hash, Branch, gewünschte Speichergröße, bekannte Bestands-PV- und
Speicherkapazität, PV-Leistung, Speicherverlust, volle Zyklen und explizite
Direct-/Storage-/Vehicle-Zuordnung zum persistierten Request passen. Die exakt
erwartete Warnmenge bindet F4-Qualität, Provider-Schätzung, Profildefaults,
Bestandsgrenze und angefragte Featuregrenzen. Engine und Finalisierung verwenden
dieselbe Contractfunktion; ein branchfremdes, aber isoliert valides Resultat
ist kein persistierbarer Erfolg.

`model.sourceRevision` bezeichnet ausschließlich das tatsächlich ausgeführte
Engine-Artefakt. Für den vorläufigen Clean-Room-Kern ist dies die Git-Blob-ID
`2095ec8462aa32f7b7c9e075997b420620bde5de` von `engine.ts`; der nur lesend
geprüfte Rechner-v3-HEAD bleibt getrennte Referenzevidenz und darf nicht als
Laufzeitprovenienz ausgegeben werden. Ein späterer freigegebener Artefaktadapter
erhält einen neuen Model-Pin und kann deshalb nicht unter demselben
Idempotenzschlüssel mit dem Fixture-Kern kollidieren. Ein automatischer
Contracttest führt `git hash-object lib/integrations/calculation/engine.ts` aus
und verlangt Bytegleichheit mit diesem Pin.

Provideraufrufe und Engineausführung liegen außerhalb kurzer
Tenant-Transaktionen. Confirmation/Reservation, Job-Claim, einmaliges
Input-Setzen und Result-Finalisierung besitzen jeweils eine atomare Grenze. Die
Finalisierung validiert alle Revisionen erneut und persistiert Result, Event,
Audit und Jobstatus gemeinsam.

## Konsequenzen

- Ein Client-Ergebnis kann nicht still zur verifizierten Berechnung werden.
- Site-Fakten werden bei mehreren Projekten korrekt geteilt; Anforderungen und
  Ergebnisse bleiben projektbezogen.
- Zwei Tabs und doppelte Jobs sind über erwartete Revisionen, Reservation-Key,
  aktiven-Job-Unique-Index, den geschlossenen pg-boss-Dispatcher, Leases und
  Input-Hash konfliktfest.
- Parallele Projekte können Actor-/Workspace-Limits nicht überrennen;
  Advisory-Hashkollisionen würden ausschließlich zusätzliche Serialisierung
  verursachen. Ein Policywechsel braucht eine neue Policy-ID und aktualisierte
  Vertrags-/Race-Tests statt still geänderter Schwellen unter `v1`.
- Historische **ausgeführte** Ergebnisse bewahren ihren exakten Profilinput im
  projektbezogenen Calculation-Snapshot, bleiben reproduzierbar und werden nach Änderungen
  sichtbar stale, statt still neu beschriftet zu werden.
- Nicht ausgeführte Draft-Zwischenstände werden nicht historisiert; das
  verkleinert die personenbezogene Datenfläche und entspricht ADR 0006.
- Wetterreihen vergrößern den Snapshot. Das ist für maximal vier Dächer im
  ersten Residential-Slice akzeptiert; Content-addressed Object Storage kann
  später hinter demselben Vertrag ergänzt werden.
- Profil-/Rechendaten erweitern die DSGVO-Fläche. M1-07 erweitert deshalb den
  expliziten Contact-/Site-Erasuregraph und die 24-Monats-Retentionprüfung;
  Migration 0027 schließt diesen Pfad mit Legal-Hold-/Vertrags-/Lease-Gates,
  DB-Zeit über dem vollständig gelockten Aktivitätsgraphen, einem kanonischen
  ID-/Hash-only-WORM-Tombstone und zustandsidempotentem Restore-Replay. Replay
  prüft Gates, Hashes und Graph-Drift erneut; freie Receipt-Metadaten werden
  pseudonymisiert. Ohne den
  automatisierten Lösch- und Restore-Tombstone-Test bleibt der Slice nicht
  pilotfähig.
- Der erste Lauf bleibt eine stündliche Planungsschätzung und erfüllt F4 nicht
  vollständig.
- Eine fehlende Lizenzdatei beantwortet die Rechtekette nicht. Bis zu einer
  dauerhaften Owner-/Chain-of-title-Freigabe als Repository-Artefakt finden
  kein Quellcode-Vendoring, produktiver Artefaktbau oder Weitergabe statt;
  Vertrag, Persistenz und eigener Adapter können unabhängig davon entstehen.

## Verworfene Alternativen

### Rechner-Snapshot umetikettieren

Verworfen. HMAC bestätigt den Absender, nicht Eingaben, Physik oder
Marktpreisannahmen. Ein neues Label würde keine neue Evidenz schaffen.

### Vollständige append-only Profilhistorie

Verworfen für M1-07. Sie dupliziert personenbezogene Gebäude-/Verbrauchsdaten,
obwohl nur tatsächlich ausgeführte Berechnungen einen historischen Input für
Reproduzierbarkeit brauchen. Operative Revision, separate
Confirmation-Bindungen und Calculation-Snapshot liefern Concurrency und
Nachvollziehbarkeit mit kleinerer Retention-Fläche.

### Zielprodukte in das Site-Profil aufnehmen

Verworfen. Zwei Projekte am selben Haus können verschiedene Kaufabsichten
haben; Zielpakete gehören zum Project.

### Projektannahmen in das Site-Profil aufnehmen

Verworfen. Zwei Projects an derselben Site können verschiedene Varianten,
Inbetriebnahmen und Produktparameter besitzen. Ein gemeinsames Profil würde
sie gegenseitig überschreiben; versionierte Auflösung gehört in den
projektbezogenen Request/Snapshot.

### Queuezustand und fachliches Resultat in einer Tabelle

Verworfen. Vor dem Providerabruf existiert noch kein finaler Input-Hash, die
Reservation muss aber bereits mit der Confirmation dauerhaft sein. Ein
technischer Job mit einmalig setzbarem Input und eine immutable Erfolgsrevision
bilden diese zwei Wahrheiten ohne nullable/änderbare Fachsnapshots ab.

### Rechenergebnis an der Site speichern

Verworfen. Requirement, Katalogauflösung und spätere Variante sind
projektbezogen. Ein Site-Ergebnis würde Projekte unzulässig koppeln.

### Nur aktuelle Werte speichern

Verworfen. Ohne immutable Input-/Provider-Snapshot wäre ein Ergebnis nach
Provider-, Default- oder Engineänderung nicht reproduzierbar.

### Netzwerkaufruf innerhalb der Fachtransaktion

Verworfen. Providerlatenz würde Sperren halten und Timeouts/Retries mit
fachlichen Writes vermischen.

### Direkter Import aus dem Rechner-Wizard oder Geschwisterpfad

Verworfen. Die UI wird parallel verändert, der Pfad ist kein deploybares
Artefakt und besitzt keinen stabilen Runtime-/Lizenzvertrag.
