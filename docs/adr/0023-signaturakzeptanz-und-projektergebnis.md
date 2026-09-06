# ADR 0023 — Signaturakzeptanz und Projektergebnis

- Status: **ANGENOMMEN / IMPLEMENTED**
- Datum: 2026-09-06
- Betroffene Specs: `docs/spec/M2-04-e-signatur.md`,
  `docs/spec/F2-08b-signaturakzeptanz-won.md`,
  `docs/spec/F7-01-installation-kern.md`
- Migration: `0076_f2_08b_signature_acceptance_won.sql`

## Kontext

M2-04 beendet digitale und analoge Annahmen mit einem signierten Request,
einer append-only Attestierung und `signature.signed`. M1-11a modelliert das
Projektergebnis separat als revisionsgesichertes `open|won|lost|cannot_fulfill`.
Der fehlende Integrationsvertrag ließ einen angenommenen Vertrag als offenen
Deal stehen.

Öffentliche Reonic-Dokumentation belegt als `FACT`:

- digitale und analoge Annahme setzen das Angebot auf `Won`;
- mehrere Pending-Requests können gleichzeitig bestehen; die Annahme eines
  beliebigen Requests gewinnt das gesamte Angebot;
- andere Pending-Links werden bei Bedarf einzeln widerrufen;
- ein Kunden-Widerruf lässt den Deal auf `Won`;
- die Activity-Labels lauten exakt
  `Signature request accepted by customer` und
  `Signature request accepted analogously`.

Quellen: [digitaler Send-/Signierfluss](https://docs.reonic.com/docs/en/offers-finalise-cat-preview-variants-legal-texts-offer-link-validity),
[analoger Upload](https://docs.reonic.com/docs/en/offers-finalise-cat-upload-manual-signature),
[Activity Feed](https://docs.reonic.com/docs/en/offers-finalise-cat-track-openings-of-offer),
[Kunden-Widerruf](https://docs.reonic.com/docs/en/offers-finalise-cat-handle-a-contract-withdrawal),
[Pending-Widerruf und Fork](https://docs.reonic.com/docs/en/offers-finalise-cat-revoke-offer).

Die [OpenAPI v3.11.0](https://api.reonic.de/rest/v3/openapi) führt
`deal.state`, `stage` und `installationCreatedAt` getrennt. Gleichzeitig sind
öffentliche Aussagen zum Zeitpunkt des Installations-Handoffs nicht eindeutig:
ein Text nennt nachgelagerte Installationswerkzeuge, ein anderer beschreibt den
Installationsstart als späteren Schritt. Automatische Installation ist daher
`ESTIMATE`, nicht `FACT`.

## Entscheidung 1 — Attestierung ist atomarer Integrationspunkt

**Gewählt:** Der vorhandene Attestierungs-Insert ist der gemeinsame Commit-Punkt
für `click`, `draw` und `analog`. Sein DB-Trigger aktualisiert innerhalb
derselben Transaktion bei Bedarf das Projektergebnis und schreibt Signatur-,
Outcome- und Audit-Nachweise. Kein asynchroner Event-Consumer führt den
kritischen Zustand nachträglich zusammen.

**Begründung:** Beide Annahmearten enden bereits in genau einer append-only
Attestierung. Eine Outbox-Konsumentin könnte nach Signaturerfolg ausfallen und
einen offenen Deal zurücklassen. Der synchrone Trigger hält Request,
Attestierung, Outcome und Nachweise atomar.

**Verworfen:** `signature.signed` erst committen und `Won` später konsumieren;
oder getrennte Outcome-Aufrufe in beiden TypeScript-Pfaden. Beides erzeugt
Teilstände und zwei Wahrheiten.

## Entscheidung 2 — Bestehende Outcome-Maschine wird erweitert, nicht umgangen

**Gewählt:** Eine gültige Annahme darf nur in Phase `offer|installation` und bei
Outcome `open|won` fortfahren.

- `open@N → won@N+1`, `closed_at = signature_request.signed_at`,
  Verlustfelder leer;
- bereits `won` bleibt unverändert, die weitere Annahme wird dennoch erfasst;
- `lost`, `cannot_fulfill`, Phase `request` und Revisionsüberlauf führen zum
  atomaren Konflikt;
- Kunden-Widerruf verändert das Outcome nicht.
- Danach ist die einzige manuelle Outcome-Kante außerhalb der Request-Phase
  `won → lost` in `offer|installation`; sie verlangt einen aktiven
  Verlustgrund und bewahrt Phase, Board und Signaturakte.

**Begründung:** Reonics Offer-`Won` wird als `INFERENCE` auf das bereits
kanonische Project-Outcome abgebildet. Dessen CAS-, Closed-at- und
Fail-closed-Invarianten müssen auch für Signaturen gelten. Mehrere belegte
Requests/Signaturen erklären den idempotenten `won`-Fall.

**Verworfen:** direkter, unbewachter Project-Update; automatisches Reopen von
Lost/Cannot-Fulfil; zweiter Revisionsbump bei jeder weiteren Signatur.

## Entscheidung 3 — Keine automatische Installation in diesem Slice

**Gewählt:** F2.8b erzeugt keine `installation`, ändert weder `project.phase`
noch `kanban_column_id` und stößt keinen Installations-Handoff an.

**Einordnung:** `ESTIMATE`, nicht Paritäts-FACT. Die Referenz trennt Deal,
Stage und Installationszeitpunkt, beschreibt den exakten Handoff aber
widersprüchlich. Bis belastbare Live-Evidenz vorliegt, ist Nicht-Erzeugen die
reversible, datenverlustfreie Grenze. F7.1-Direkterstellung bleibt unabhängig.

**Verworfen:** Signaturannahme pauschal als `installation.created` behandeln
oder die Phase ohne Installation-Datensatz verschieben. Beides erfindet
Timing/Board-Semantik und kann falsche operative Arbeit auslösen.

## Entscheidung 4 — Geschwister-Requests und Widerruf verändern Outcome nicht

**Gewählt:** Die gewinnende Signatur beendet nur ihren eigenen Request. Andere
Pending-Requests bleiben bestehen und können explizit widerrufen oder ebenfalls
angenommen werden. `revoked_by_customer` bleibt eine Signaturstatusänderung.
Die gewünschte Lost-Entscheidung erfolgt separat über die manuelle
Outcome-Aktion; dafür wird die bestehende Maschine schmal um
`won@offer|installation → lost` erweitert. Der signierte Request und seine
Attestierung werden weder gelöscht noch verändert.

**Begründung:** Beides ist öffentlich belegt (`FACT`). Automatische
Geschwister-Stornierung oder Lost-Rollback würde von der Referenz abweichen.

## Entscheidung 5 — Nachweisakteure und Labels sind geschlossen

**Gewählt:** Neue Annahme schreibt genau ein `signature.signed` mit:

- digital: Actor `customer`, Label
  `Signature request accepted by customer`;
- analog: interne Actor-UUID, Label
  `Signature request accepted analogously`.

Nur `open→won` erzeugt zusätzlich genau ein `project.outcome_won` und ein
`project.outcome.write`-Audit mit `source=signature`. DB-Guards binden alle IDs,
Modus, Actor und Label an den gerade eingefügten Request/Attestierungs-Kontext.
Direkte Events, Audits oder nachgeahmte Session-GUCs werden verworfen.

**Begründung:** Labels und Auslöser sind `FACT`; technische Actor-Werte und die
ID-Bindung sind eigenständige, datensparsame `INFERENCE/DECIDED`-Umsetzung.

## Entscheidung 6 — Eine Lock-Reihenfolge und fail-closed Backfill

**Gewählt:** Digitaler Pfad, analoger Pfad und konkurrierende Mutationen sperren
in der Reihenfolge `Project → SignatureRequest → OfferVariant`. Migration 0076
quiesziert den Altbestand mit dem `NOWAIT`-/Retry-Lockset `Project →
SignatureRequest → SignatureAttestation`. Fehlgeschlagene Versuche geben ihre
Teil-Locks per Subtransaktion frei, sodass ein noch laufender 0075-Pfad seine
inverse Alt-Locksteigerung beenden kann. Danach zieht 0076 vorhandene
signierte/widerrufene Requests chronologisch nach, aber nur mit in Signer,
Content-Hash und Signierzeit exakt gebundener Attestierung sowie zulässigem
Project-Zustand; auch bereits gewonnene Projekte werden vor dem No-op
vollständig geprüft. Die vollständige Inventur wird
ohne TEMP-Recht als transaktionslokale GUC übergeben. Historischer Actor ist
`system`; es wird kein historisches `signature.signed` dupliziert.

Der Runtime-ACL-Cutover ist Teil desselben 0076-Commits: direktes
Attestierungs-Insert wird entzogen und EXECUTE auf beide Annahmekapseln
erteilt. Das nachgelagerte Rollenmanifest attestiert den Gesamtvertrag, ist
aber keine Sicherheits- oder Verfügbarkeitsgrenze. Seine Prefix-Erkennung
akzeptiert nur `0/5` (0075) oder `5/5` F2.8b-Marker (zwei Funktionen, drei
aktive Constraint-Trigger); Zwischenstände brechen fail-closed ab.

**Begründung:** Gemeinsame erste Sperre verhindert Deadlocks und schließt den
CAS-Zeitspalt. Ein stilles Überschreiben von Lost/Cannot-Fulfil im Backfill wäre
nicht auditierbar; die Migration muss stattdessen abbrechen.

Die analoge Anwendungskante liegt deshalb vollständig in einer
SECURITY-DEFINER-Kapsel. Ein deferred Integritäts-Trigger verwirft am Commit
jeden terminalen Request ohne passende Attestierung und geschlossenes Projekt;
isoliertes Entfernen einer Attestierung sowie ein kombinierter Project-Phase-/
Reopen-Versuch scheitern ebenfalls. Historische terminal→offen- und
terminal→Request-Kanten werden ereignisgebunden abgelehnt, sodass auch ein
vollständiger Zyklus nicht durch einen am Ende wieder gültigen Zustand
verschleiert werden kann; `request→offer→Signatur` in derselben Transaktion und
echter Kontakt-Erasure-Cascade bleiben zulässig. Das Rollenmanifest bleibt für
den 0075-Prefix kompatibel und entzieht
`app_runtime` das direkte Attestierungs-Insert erst, wenn die 0076-Kapseln
tatsächlich vorhanden sind.

## Konsequenzen

- Signaturannahme und `Won` sind atomar; kein offen gebliebener Deal nach
  erfolgreicher Attestierung.
- `_m204_guard_signature_attestation` wird SECURITY DEFINER und setzt einen
  eng gebundenen transaktionslokalen Akzeptanzkontext; alle vorherigen Werte
  werden auf Erfolgs- und Fehlerpfad wiederhergestellt.
- Die M1-11a-Outcome-/Evidence-Guards erlauben den Signaturpfad nur mit exakt
  passendem Trigger-Kontext und bleiben für normale Outcome-Aktionen
  unverändert fail-closed.
- Rollenvertrag pinnt Owner, Security-Modus, ACL und Quellhashes der geänderten
  Funktionen; `app_runtime` besitzt kein direktes Insert-Recht auf
  `signature_attestation`.
- Ein echter strikter 0075-Prefix bleibt mit dem alten Insert-Pfad
  betriebsfähig; unmittelbar nach dem 0076-Commit gilt bereits vollständig der
  neue Kapselpfad, noch vor dem Post-Migrations-Manifest.
- Automatische Installation bleibt offener eigener Paritätsslice und muss als
  `ESTIMATE` geführt werden.
