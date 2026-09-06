# F2.8b — Signaturakzeptanz setzt Projektergebnis auf Won (M204-I1)

Status: **REVIEWED / VERIFIED (lokal)**
Datum: 2026-09-06 · Migration: **0076** · ADR:
`docs/adr/0023-signaturakzeptanz-und-projektergebnis.md`

## 1. Nutzerergebnis

Eine gültige digitale oder analoge Angebotsannahme schließt das zugehörige
Projekt atomar als `Won`. Signatur, Attestierung, Projektergebnis, Domain-Event
und Audit können nicht auseinanderlaufen. Ein späterer Kunden-Widerruf ändert
den Signaturstatus, setzt das Projekt aber nicht automatisch zurück. Ein
Editor/Admin kann das gewonnene Offer-/Installationsprojekt danach mit einem
aktiven Verlustgrund manuell auf `Lost` setzen; Signatur und Attestierung
bleiben als Vertragsakte erhalten.

Dieser Slice erzeugt **keine Installation**, verschiebt keine Projektphase und
ändert keine Kanban-Spalte. Diese Grenze ist eine bewusst konservative
`ESTIMATE`-Entscheidung, bis der widersprüchliche Installationszeitpunkt in der
Live-Referenz eindeutig aufgelöst ist.

## 2. Clean-Room-Evidenz

### 2.1 FACT

| Beleg | Gesicherte Semantik |
|---|---|
| [Angebot senden, Varianten und Linkgültigkeit](https://docs.reonic.com/docs/en/offers-finalise-cat-preview-variants-legal-texts-offer-link-validity) | Digitale Annahme setzt das gesamte Angebot auf `Won`. Mehrere offene Signaturlinks pro Angebot sind möglich; die Annahme eines beliebigen Links gewinnt das Angebot. Andere noch offene Links werden danach bei Bedarf einzeln widerrufen, nicht automatisch beendet. |
| [Manuelle Signatur hochladen](https://docs.reonic.com/docs/en/offers-finalise-cat-upload-manual-signature) | Analoge Annahme eines Pending-Requests hat dieselbe `Won`-Wirkung wie die digitale Annahme. Weitere Papierannahmen können über getrennte Requests erfasst werden. |
| [Signaturaktivitäten verfolgen](https://docs.reonic.com/docs/en/offers-finalise-cat-track-openings-of-offer) | Exakte Aktivitätslabels: `Signature request accepted by customer` (digital) und `Signature request accepted analogously` (analog); beide kennzeichnen die Annahme und den Wechsel zu `Won`. |
| [Kunden-Widerruf behandeln](https://docs.reonic.com/docs/en/offers-finalise-cat-handle-a-contract-withdrawal) | Ein Kunden-Widerruf eines bereits angenommenen Vertrags lässt den Deal auf `Won`; eine fachliche Umstufung auf Lost erfolgt nur manuell. |
| [Pending-Link widerrufen / signiertes Angebot ändern](https://docs.reonic.com/docs/en/offers-finalise-cat-revoke-offer) | Pending-Links werden einzeln widerrufen. Signierte Varianten bleiben Vertragsartefakte; spätere Varianten und Signaturen können daneben bestehen. |

Die öffentliche [Reonic OpenAPI v3](https://api.reonic.de/rest/v3/openapi)
(Version `3.11.0`, Abruf 2026-09-06, SHA-256
`dff3a9d646da8c7dbad70a16ad1deb6710579f8ad843e5ead7c3904946d8a38d`)
modelliert `deal.state` (`Open|Won|Lost`), `stage`
(`request|offer|installation`) und `installationCreatedAt` als getrennte
Projektmerkmale. Das belegt, dass Deal-Ausgang und Installationsphase nicht
dasselbe Feld sind.

### 2.2 INFERENCE

- Reonics „Angebot wird Won“ wird auf das bestehende, projektweite
  `project.outcome = 'won'` aus M1-11a abgebildet. Es gibt im WMEE-Modell kein
  zweites Offer-Outcome.
- `closed_at` übernimmt den serverseitigen `signature_request.signed_at`.
  Dadurch beschreiben Annahme und Deal-Entscheidung denselben Zeitpunkt.
- Ein bereits gewonnenes Projekt akzeptiert eine weitere gültige Signatur,
  ohne Outcome-Revision und `project.outcome_won` ein zweites Mal zu erzeugen.
  Das folgt aus den belegten mehreren Requests/Signaturen pro Angebot.
- Digitale Annahme wird im Nachweis als Actor `customer`, analoge Annahme mit
  der internen Actor-UUID geführt. Die öffentliche Doku unterscheidet den
  Auslöser, legt aber kein technisches Actor-Schema fest.

### 2.3 ESTIMATE — Installation bewusst nicht automatisch

Die Referenz nennt nach einer Signatur einerseits nachgelagerte
Installationswerkzeuge und Integrationen. Andererseits beschreibt sie den
Installationsstart und die Auswahl der zu bauenden Variante als späteren,
eigenständigen Handoff. Die OpenAPI führt zusätzlich Deal-Ausgang,
Projektphase und `installationCreatedAt` separat. Daraus lässt sich weder der
exakte Zeitpunkt noch ein zwingendes automatisches Erzeugen einer
Installation belastbar ableiten.

Darum gilt für F2.8b:

- kein `installation`-Insert;
- `project.phase` bleibt unverändert (`offer` oder bereits `installation`);
- `project.kanban_column_id` bleibt unverändert;
- spätere Installation-Automation benötigt eigene Live-Evidenz und eigenen
  Slice. Sie darf nicht rückwirkend als FACT dieses Slices behauptet werden.

## 3. Zustands- und Transaktionsvertrag

Gültiger Annahmepfad:

```text
signature_request.pending
  + gültige digitale/analoge Attestierung
  + project.phase ∈ {offer, installation}
  + project.outcome ∈ {open, won}
    → signature_request.signed
    → signature_attestation INSERT
    → project.open@N wird project.won@N+1
    → Signatur- und ggf. Outcome-Nachweis
```

- Bei `open`: `outcome = won`, Revision `N+1`,
  `closed_at = request.signed_at`, Verlustfelder `NULL`.
- Bei bereits `won`: Annahme wird gespeichert; Outcome, Revision und
  `closed_at` bleiben unverändert; kein zweites Outcome-Event/Audit.
- Bei `lost`, `cannot_fulfill`, Phase `request` oder ausgeschöpfter
  Outcome-Revision: `project_outcome_conflict` beziehungsweise
  `project_outcome_revision_exhausted`; die gesamte Annahme bleibt
  unverändert.
- Kunden-Widerruf `signed → revoked_by_customer`: Projekt bleibt `won`.
- Manueller Vertragsrücktritt: `won@offer|installation@N → lost@N+1` mit
  aktivem Verlustgrund; Phase, Board, Signaturrequest und Attestierung bleiben
  unverändert. Andere manuelle Outcome-Kanten außerhalb der Request-Phase
  bleiben gesperrt.
- Geschwister-Requests bleiben unverändert. Insbesondere gibt es kein
  implizites `withdrawn` oder `expired`.
- Replay eines bereits signierten Token-Requests bleibt idempotent und erzeugt
  weder zweite Attestierung noch zweite Events/Audits.

Die kanonische Lock-Reihenfolge lautet:

```text
Project → SignatureRequest → OfferVariant
```

Digitaler Token-Pfad und analoge DB-Kapsel müssen dieselbe erste Sperre
verwenden. Der Attestierungs-Trigger ist der gemeinsame atomare
Integrationspunkt für digitale (`click|draw`) und analoge Annahme. Ein
deferred Constraint-Trigger prüft am Commit zusätzlich, dass terminaler
Request, passende Attestierung und geschlossenes Won-/Lost-Projekt gemeinsam
bestehen. Die Prüfung hängt auch an Project-Updates: Phase, Outcome oder
`closed_at` können nach einer terminalen Signatur nicht durch eine
mehrstufige Transaktion auseinandergezogen werden. Sie bewertet den finalen
Transaktionszustand, bindet aber historische `won|lost → open`- und
`won|lost@offer|installation → request`-Kanten zusätzlich an `OLD/NEW`.
Dadurch bleibt ein legitimes `request → offer → Signatur` in einer Transaktion
zulässig, während auch ein vollständiger Reopen-/Won-Zyklus mit am Ende wieder
scheinbar gültigem Zustand vollständig zurückgerollt wird.

## 4. Event-, Audit- und Activity-Vertrag

Bei jeder neuen Annahme genau einmal:

| Modus | Event | Actor | `payload.activityLabel` | Audit |
|---|---|---|---|---|
| `click` / `draw` | `signature.signed` | `customer` | `Signature request accepted by customer` | `offer.signature.accept_customer` |
| `analog` | `signature.signed` | interne Actor-UUID | `Signature request accepted analogously` | `offer.signature.upload_analog` |

Nur beim wirksamen `open → won` zusätzlich genau einmal:

- Event `project.outcome_won`, Aggregate `project`, Actor wie Annahme;
- Audit `project.outcome.write`, `source = signature`;
- Payload/Details binden `projectId`, `signatureRequestId`,
  `signatureAttestationId`, `signatureMode`, `offerId` und `variantId`.

Direkte oder über gefälschte Session-Kontexte eingeschleuste
`signature.signed`-/Signatur-Outcome-Nachweise werden vom DB-Guard abgelehnt.

## 5. Upgrade- und Backfill-Vertrag

Migration 0076 zieht bestehende `signed`- und `revoked_by_customer`-Requests
mit Attestierung in `signed_at`-/ID-Reihenfolge nach:

- offenes Projekt → `won`, Actor `system`, `closed_at = signed_at`;
- bereits gewonnenes Projekt → No-op;
- kein neues `signature.signed`-Event für historische Annahmen;
- fehlende oder in `signer_name`, `content_sha256` oder `signed_at` nicht exakt
  zum Request passende Attestierung, unzulässige Phase, Lost/Cannot-Fulfil oder
  Revisionsüberlauf → Migration bricht fail-closed ab; das gilt auch für ein
  historisch bereits gewonnenes Projekt;
- keine Installation und kein Phasen-/Boardwechsel.

Die Migration pinnt vor dem Ersetzen die Quellhashes aller berührten
Outcome-/Signatur-Funktionen. Rollenvertrag und Funktions-Fingerprints werden
auf die neue SECURITY-DEFINER-Grenze aktualisiert.

Vor Inventur und Backfill nimmt 0076 mit `NOWAIT` und begrenztem Retry das
globale Lockset `Project → SignatureRequest → SignatureAttestation`. Jeder
fehlgeschlagene Versuch läuft in einer PL/pgSQL-Subtransaktion und gibt bereits
genommene Teil-Locks wieder frei; damit kann ein noch laufender 0075-Analogpfad
seine inverse Alt-Lockfolge beenden, statt mit dem Rollout zu deadlocken. Die
vollständige Terminal-Inventur wird unter diesem Lock einmal als Tabellenowner
gelesen, in einer transaktionslokalen GUC gestaged und danach fail-closed
verbraucht. Sie benötigt weder TEMP-Objekte noch das absichtlich entzogene
TEMP-Recht; `FORCE ROW LEVEL SECURITY` wird auch auf dem Fehlerpfad restauriert.
Im selben Drizzle-Commit entzieht 0076 `app_runtime` das alte direkte
Attestierungs-Insert und erteilt EXECUTE auf Token- und Analog-Kapsel. Ein
Crash vor dem nachgelagerten Gesamtmanifest kann daher weder den alten
Request→Attestation-Pfad offenlassen noch die neue Anwendungskante sperren.

## 6. Rollen- und Sicherheitsvertrag

- Digital: öffentliches Hochentropie-Token; Klartext wird nicht persistiert;
  interner Actor muss am DB-Pfad leer sein.
- Analog: bestehendes Recht `offer.signature.upload_analog`; Editor/Admin und
  echte Actor-UUID erforderlich; die Anwendung schreibt über die atomare
  `sign_signature_analog`-Kapsel und hat kein direktes Attestierungs-Insert.
- Der Rollenvertrag bleibt prefix-kompatibel: auf einem Stand vor 0076 erhält
  `app_runtime` das von M2-04 benötigte direkte Attestierungs-Insert; sobald
  beide F2.8b-Kapseln vorhanden sind, wird es auf `SELECT` zurückgenommen.
- Ein partieller F2.8b-Stand ist kein Legacy-Prefix: zwei neue Funktionen und
  alle drei aktiven Constraint-Trigger müssen gemeinsam vorhanden sein, sonst
  brechen Apply und Verify fail-closed ab.
- Die DB setzt den temporären Akzeptanzkontext nur innerhalb der
  SECURITY-DEFINER-Transaktion und stellt vorherige GUC-Werte auf Erfolgs- und
  Fehlerpfad wieder her.
- Fremdmandant, Viewer, Worker und direkte SQL-Spoofs bleiben fail-closed.
- Lost/Cannot-Fulfil werden niemals still überschrieben.

## 7. Testmatrix

| ID | Prüfung | Ebene |
|---|---|---|
| `F208B-DB-01` | digitale Annahme: Request+Attestierung+`open→won`+beide Nachweise atomar | DB |
| `F208B-DB-02` | analoge Annahme: interner Actor + exaktes Analog-Label + `Won` | Strict DB |
| `F208B-DB-03` | Replay/weiterer Request: kein zweiter Outcome-Bump; Geschwister bleiben pending | DB |
| `F208B-DB-04` | Kunden-Widerruf bleibt `Won`; keine Installation | Strict DB |
| `F208B-DB-05` | Lost/Cannot-Fulfil/Request-Phase/Revisionsmaximum brechen atomar ab | Strict DB |
| `F208B-DB-06` | halbe Direkt-SQL-Signatur oder isolierter Attestierungs-Delete rollt am Commit zurück | Strict DB |
| `F208B-DB-07` | Kunden-Widerruf → manueller `won→lost`; Grund/Revision/Evidenz, Signaturakte bleibt | DB |
| `F208B-DB-08` | mehrere gültige Requests aus getrennten Ausstellungen: erster Won-Bump, weitere Annahme ohne Bump, Geschwister pending | Strict DB |
| `F208B-DB-09` | vollständiger Phase→Request→Reopen→Won→Offer-Zyklus scheitert deferred und rollt vollständig zurück | Strict DB |
| `F208B-DB-10` | legitimes `request→offer→Signatur` committet in derselben Transaktion | Strict DB |
| `F208B-SEC-01` | direkter Event-/Audit-/GUC-Spoof wird mit `23514` abgelehnt | Strict DB |
| `F208B-UPG-01` | 0075→0076: historischer Signatur-Backfill, chronologisch und auch bei bereits Won nur mit exakt gebundener Attestierung | Migration |
| `F208B-UPG-02` | Rollout konkurriert mit alter Request→Project-Locksteigerung ohne Deadlock | Migration |
| `F208B-RBAC-01` | echter strikter 0075-Prefix: Apply+Verify grün; 0076 schneidet INSERT/EXECUTE bereits im Migrationscommit um; partieller Stand fail-closed | Strict DB |
| `F208B-E2E-01` | Annahme zeigt `Won`; Widerruf + manuelles Lost bewahrt Signatur und erzeugt keine Installation | Chromium |

Bestehende Hauptnachweise liegen in
`tests/db/m204-e-signature-service.test.ts` und
`tests/db/m204-e-signature-strict.test.ts`. `VERIFIED` setzt zusätzlich die
vollständige Gate-Kette, Migration-Upgrade-Probe und Chromium-Nachweis voraus.

## 8. Nichtziele

- automatische Installation, Installationsphase oder Installations-Board;
- automatisches Widerrufen anderer Pending-Requests;
- automatisches Lost/Reopen nach Kunden-Widerruf;
- E-Mail-, Integrations- oder Rechnungs-Fan-out;
- Änderung der bestehenden Signatur-/PDF-Rechtsaussagen;
- Nachbau privater Reonic-Implementierungsdetails.
