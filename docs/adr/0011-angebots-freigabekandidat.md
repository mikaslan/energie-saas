# ADR 0011: Kundentauglicher Angebots-Freigabekandidat vor Ausstellung

- Status: entschieden fuer M2-03a
- Implementierungsstand: `REVIEWED/VERIFIED (lokal) · TECHNISCHES GATE GO`
- Datum: 2026-08-30

## Kontext

M2-02 erzeugt reproduzierbare interne PDF-Entwuerfe. Diese Bytes sind fuer eine
spaetere Ausstellung ungeeignet: Das Dokument bezeichnet sich auf jeder Seite
als intern, nicht versendet und nicht verbindlich und enthaelt weder bestaetigte
Rechnungsdaten noch Aussteller- oder Rechtstexte.

Eine direkte Signatur- oder Versandfunktion wuerde deshalb einen fachlich
unvollstaendigen Dokumentstand nach aussen geben. Gleichzeitig fehlen noch die
produktiven Object-Lock-Credentials und der empirische Retention-Readback aus
ADR 0002.

## Entscheidung

1. M2-03a fuehrt einen eigenen `offer-release-candidate-input.v1` und ein
   eigenes Kundendokument-Template ein. Die kommerzielle Quelle bleibt exakt
   dieselbe unveraenderliche Angebotsvariantenrevision; die M2-02-PDF-Bytes
   werden nicht wiederverwendet.
2. Genau ein stabiler Workspace-Dokumentprofil-Head mit append-only Revisionen
   versioniert
   Ausstellerdaten und Rechtstexte. Eine getrennte Aktivierung attestiert die
   ausdrueckliche interne Betreiberpruefung des exakten Profilhashes.
   Es gibt keine produktiven Defaults und keine von der Anwendung erfundenen
   WMEE-Firmen- oder Rechtstexte.
3. Eine append-only Offer-Empfaengerrevision trennt bestaetigte Rechnungsdaten
   ausdruecklich vom Anlagenstandort. Der eigentliche Candidate-Request sendet
   nur IDs und erwartete Revisionen; Profil, Empfaenger, kommerzielle Daten,
   Zeiten und Hashes werden serverseitig erneut gelesen und abgeleitet.
4. Solange die Behandlung intern ausgeblendeter Preiszeilen nicht fachlich
   entschieden ist, blockiert bereits eine solche Zeile die Kandidaterzeugung.
   Die Anwendung darf weder Summen verstecken noch eine Ausgleichsposition
   erfinden.
5. Der bereits isolierte Chromium-/pg-boss-Pfad wird als eigener Jobtyp fuer
   das neue Input- und Template-Rezept genutzt. Erfolgreiche Bytes bleiben bis
   M2-03b groessenbegrenzt und erasure-faehig in Postgres gestaged.
6. Ein Workererfolg erzeugt zunaechst `ready_for_approval`. Eine eigene
   menschliche Abschlussfreigabe bindet Candidate, Artifact-SHA, Input-SHA,
   Varianten-, Profil- und Empfaengerrevision sowie Rezept. Erst danach ist
   der interne Zustand `approved_not_issued`; eine neue Quelle braucht einen
   neuen Candidate und eine neue Freigabe.
7. UI und PDF zeigen in jedem Zustand sichtbar `Freigabekandidat · nicht
   ausgestellt · nicht versendet`. Es gibt keinen Versand, keinen
   oeffentlichen Link, keine Annahme und keine Signatur.
8. M2-03b darf die sichtbar als `nicht ausgestellt` markierten Candidate-Bytes
   niemals umetikettieren oder zu `issued` promoten. Es muss aus dem
   unveraenderlich freigegebenen Candidate-Input und seinen exakten Bindungen
   einen getrennten Ausstellungsrender erzeugen, dessen tatsaechliche Bytes
   erneut menschlich freigegeben werden. Erst Object-Lock-Upload und
   vollstaendiger Retention-/Version-/Hash-Readback duerfen fuer dieses neue
   Artefakt `issued` erzeugen.

## Autorisierung

- Dokumentprofile erstellen: `settings.manage`, damit nur Admins neue
  rechtlich relevante Workspace-Staende anlegen koennen.
- Empfaengerrevisionen und Freigabekandidaten vorbereiten: eigene Aktion
  `offer.release.prepare`,
  mindestens Editor und fuer Nicht-Admins nur mit der Capability
  `prepare_offer_documents`.
- Fertige Bytes menschlich freigeben: getrennte Aktion
  `offer.release.approve`, mindestens Editor und fuer Nicht-Admins nur mit
  `approve_offer_documents`. Eine Vier-Augen-Pflicht bleibt eine offene
  Produktentscheidung; Selbstfreigabe wird in M2-03a nicht als rechtliche
  Ausstellung interpretiert.
- `external_only` bleibt fuer beide Mutationen und fuer interne Artefakte
  fail-closed.
- Kandidatenstatus lesen: interne `project.read`-Grenze. Unfreigegebene Bytes
  duerfen nur Approver sehen; nach der Abschlussfreigabe reicht internes
  `project.read`.

Die UI-Sichtbarkeit ist keine Sicherheitsgrenze. Server Actions, Services,
RLS, zusammengesetzte Tenant-FKs und genaue Rollen-ACLs pruefen erneut.

## Datenschutz und Integritaet

- Kandidaten enthalten notwendige Empfaenger- und Rechnungsadressdaten, aber
  keine Telefonnummer, Koordinaten, Consent-, Acquisition-, EK-, Margen-,
  Token- oder Providerdaten.
- Events und allgemeine Audits bleiben ID-only; Rechtstexte, Adressen,
  Dokumentbytes und volle Hashes duerfen dort nicht erscheinen.
- Ein erfolgreicher Kandidat ist append-only, bleibt jedoch Teil des Offer-
  Erasure-Graphen. Er ist kein WORM-Archiv und kein Aufbewahrungsnachweis.
- Renderer und Download pruefen Input-/Byte-Hash, MIME und Groesse erneut.

## Verworfene Alternativen

### M2-02-Bytes unveraendert promoten

Verworfen: Der sichtbare interne Status und die bewusst fehlenden Rechts- und
Rechnungsdaten koennen durch Metadaten nicht in ein Kundendokument verwandelt
werden. ADR 0010 wird in diesem Punkt durch ADR 0011 praezisiert: Identisch
bleibt die kommerzielle Quellrevision, nicht das interne Vorschauartefakt.

### Firmen- und Rechtstexte hardcoden

Verworfen: Die autoritativen Inhalte fehlen und erfordern fachliche/juristische
Verantwortung. Ein leerer, blockierender Konfigurationszustand ist ehrlich und
spaeter ohne Migration aktualisierbar.

### Bereits in M2-03a in Object Storage schreiben

Verworfen: Kauf, Bucket-Provisionierung, COMPLIANCE-Test und Readback sind
getrennt freigabepflichtig. Ohne diese Evidenz waere `issued` oder WORM falsch.

### Freigabekandidatenbytes spaeter nur umetikettieren

Verworfen: Der Status `nicht ausgestellt · nicht versendet` ist Teil jeder
PDF-Seite und damit der freigegebenen Bytes. M2-03b muss einen getrennten
Ausstellungsrender aus dem unveraenderlich gebundenen Candidate-Input ableiten
und die neuen Bytes vor dem WORM-Upload erneut freigeben.

### PDF synchron im Next.js-Prozess rendern

Verworfen aus denselben Isolations-, Timeout- und Verfuegbarkeitsgruenden wie
in ADR 0010.

## Implementierungsnachweis

Die Entscheidung ist lokal umgesetzt und technisch verifiziert:

- 111/111 Vitest-Dateien mit 1.078 bestandenen und 1 uebersprungenen Test;
- voller Chromium-Lauf mit 17 bestandenen, 1 opt-in uebersprungenen und 0
  fehlgeschlagenen Faellen;
- Typecheck, ESLint, Production-Build und Dependency-Cruiser fuer 237 Module
  und 764 Abhaengigkeiten gruen;
- DB-Rollenvertrag 88/88 und PostgreSQL-18-Proben 5/5 gruen;
- gepinnter `linux/amd64`-Container mit zwei deterministischen Rendern und dem
  Pflichtstatus auf 11/11 A4-PDF-Seiten;
- Security-, Regression-, unabhaengiger Navigation- und finaler lokaler
  Claude-Code-Opus-Max-Lesereview GO, ohne offene P0–P2.

Der Browser-E2E verwendet fuer Claim/Finalize eine synthetische Finalisierung
in der DB und prueft die exakten Downloadbytes. Der echte Renderer ist
separat durch den gepinnten Container belegt. Diese Evidenzen werden nicht als
ein einzelner Real-Worker-E2E ausgegeben.

Nicht Teil dieses Implementierungsstands sind eine menschliche visuelle
Baseline, echte WMEE-Firmen-/Rechtstexte, ein produktiver Deploy,
Object Lock/WORM, Ausstellung, Delivery/Versand, Annahme oder Signatur. Der
ADR-Status bleibt eine eigene WMEE-Entscheidung und ist keine private
Reonic-Produktwahrheit oder 1:1-Paritaetsbehauptung.

## Konsequenzen

- M2-03a schliesst die inhaltliche Luecke zwischen internem PDF-Entwurf und
  einem kundenseitig pruefbaren Freigabestand, behauptet aber weder
  Ausstellung noch Rechtswirkung.
- Mehrere historische Profil- und Kandidatenrevisionen bleiben nachvollziehbar;
  eine neue Profil- oder Variantenrevision mutiert nie einen alten Kandidaten.
- Hidden-Zeilen, fehlende Rechtspruefung, veraltete Revisionen und
  unvollstaendige Rechnungsdaten blockieren fail-closed.
- Vor Pilotbetrieb bleiben juristische Freigabe, Object-Lock-Gate, Retention,
  Versanddomain und Signaturbeweis separat erforderlich.
