# M2-03a · Angebotsprofil und unveraenderlicher Freigabekandidat

Status: `REVIEWED/VERIFIED (lokal) · TECHNISCHES GATE GO`
Stand: 2026-08-30
Zielbereich: F2.7 PARTIAL, F16.2 PARTIAL, Golden Path PDF → Ausstellung

## Ergebnis

Ein Workspace-Admin kann einen neuen, unveraenderlichen Dokumentprofilstand
mit Ausstellerdaten und Rechtstexten anlegen und dessen exakten Hash als
`operator_reviewed` aktivieren. Ein berechtigter interner Bearbeiter speichert
einen ausdruecklichen Empfaenger-/Rechnungsadressstand und laesst anschliessend
eine exakte Angebotsvariantenrevision zu einem kundentauglichen PDF-Kandidaten
rendern. Erst eine getrennte Abschlussfreigabe bindet die vier menschlichen
Bestaetigungen an die tatsaechlich erzeugten und erneut geprueften PDF-Bytes.

Der Kandidat ist weder ausgestellt noch versendet. UI und PDF tragen sichtbar:

> Freigabekandidat · nicht ausgestellt · nicht versendet

M2-03a erzeugt kein `issued`, `sent`, `accepted` oder `signed` und behauptet
weder WORM noch einen Vertragsschluss.

M2-03b darf diese sichtbar als `nicht ausgestellt` markierten Bytes nicht
promoten. Eine spaetere Ausstellung braucht einen getrennten Render aus dem
unveraenderlich freigegebenen Candidate-Input, eine Freigabe der tatsaechlichen
Ausstellungsbytes und erst danach den vollstaendigen Object-Lock-Readback.

## Harte Nicht-Ziele

- kein Object-Lock-Upload, Retention- oder WORM-Claim;
- kein Versand, Resend, Provider-Message-ID oder produktiver SMTP-Aufruf;
- kein oeffentlicher Link, Kundenportal, View Tracking oder Token;
- keine Annahme, Click-/Drawn-/Tablet-/Analogsignatur oder Attestierung;
- kein Won-, Installations-, Rechnungs- oder Zahlungsuebergang;
- keine optionalen Upsell-Checkboxen oder inhaltliche Aenderung beim Kunden;
- keine erfundenen Firmen-, Steuer-, AGB-, Widerrufs- oder Datenschutztexte;
- keine juristische Einordnung als QES/AES oder als bestimmter Vertragstyp;
- keine Uebernahme von Reonic-Texten, -Layout, -Assets oder privaten Daten.

## M203A-01 · Versioniertes Workspace-Dokumentprofil

Ein Admin sendet ausschliesslich fachliche Plain-Text-Formularfelder. Der
Server setzt Profil-ID, Revisionsnummer, Actor und DB-Zeit. Eine zweite,
explizite Aktivierungsaktion bindet `operator_reviewed`, Actor und DB-Zeit an
den exakten Profilhash. Das bedeutet interne Betreiberpruefung, nicht
anwaltliche Beratung oder eine Wirksamkeitsgarantie.

Pro Workspace gibt es in M2-03a genau einen stabilen Profil-Head. Dessen
Inhalte liegen ausschliesslich in append-only Revisionen; eine append-only
Aktivierungs-Attestation wird vom Head als aktueller Stand referenziert.

Das strikt versionierte Profil enthaelt:

- Profilname;
- Aussteller: vollstaendige Firmierung inklusive Rechtsform, Vertretung,
  Strasse/Hausnummer, PLZ, Ort, ISO-Land, E-Mail, Telefon;
- optional als Paar: Registergericht und Registernummer;
- optional: Umsatzsteuer-ID;
- Angebotsbedingungen: Titel und Text;
- Widerrufsinformation: Titel und Text;
- Datenschutzhinweis: Titel und Text;
- feste Schema-/Canonicalization-Version;
- Aktivierung als separate Attestation ueber Revision und Snapshot-SHA.

Es gibt keine Defaultinhalte. Fehlende Pflichtfelder, unbekannte Felder und
doppelte Formfelder werden abgewiesen. Jeder neue Stand ist append-only und
erhaelt die naechste Profilrevision. Kandidaten duerfen nur die aktuell
aktivierte, hashvalide Revision verwenden.

Der Client sendet dafuer nur die strict Commands
`offer-release-profile-revise-command.v1` und
`offer-release-profile-activate-command.v1`. IDs, Revision, Actor, DB-Zeit,
Snapshot und Hash sind server- und datenbankautoritativ.

## M203A-02 · Versionierter Empfaenger-/Rechnungsstand

Der Bearbeiter speichert eine Offer-lokale append-only Revision mit
Empfaengername, optionaler Firma, E-Mail und strukturierter Rechnungsadresse.
Eine feste Bestaetigung erklaert nur, dass diese Angaben fuer das Angebot
geprueft wurden. Es gibt keinen Fallback auf den Anlagenstandort. ID, Revision,
Actor, DB-Zeit, Canonicalization und SHA werden serverseitig gesetzt.
Der Clientvertrag ist `offer-recipient-revise-command.v1`; er enthaelt keine
serverautoritativ abgeleiteten Felder.

## M203A-03 · Ausstellungsreife pruefen und Render anfordern

Der Bearbeiter sendet nur:

```text
workspaceId, offerId, variantId, expectedVariantRevision,
sourcePdfDraftId, documentProfileId, documentProfileRevisionId,
expectedDocumentProfileRevision, recipientRevisionId,
expectedRecipientRevision, validThrough
```

Serverseitige Vorbedingungen:

- aktive interne Membership;
- `offer.release.prepare`; `external_only` blockiert;
- Offer, Project, Variante und Revision gehoeren demselben Tenantgraphen;
- `expectedVariantRevision` entspricht nach Lock der aktuellen Revision;
- Quellsnapshot und Hash sind unveraendert gueltig;
- das gewaehlte Dokumentprofil gehoert zum Workspace und ist reviewed;
- ein erfolgreicher, MIME-/Groessen-/SHA-valider M2-02-Entwurf bindet exakt
  dieselbe Variantenrevision;
- die gewaehlte Empfaengerrevision ist die aktuelle, hashvalide Offerrevision;
- `validThrough` liegt 1 bis 60 Kalendertage nach dem aus DB-Zeit in
  `Europe/Berlin` abgeleiteten Dokumentdatum;
- keine einzige Variantenzeile ist `isHidden = true`;
- Preise, Steuern und Summen sind der serverautoritative Revisionsstand.

Die Installationsadresse wird weiterhin getrennt als Anlagenstandort
ausgewiesen und nie still als Rechnungsadresse uebernommen.

## M203A-04 · Versiegelter Renderinput

`offer-release-candidate-input.v1` bindet:

- Angebotsnummer, DB-Vorbereitungszeit, Dokumentdatum und das
  explizite Gueltigkeitsdatum;
- Dokumentstatus `not_issued`;
- vollstaendigen gehashten Dokumentprofilstand;
- bestaetigten Empfaenger- und strukturierten Rechnungsadress-Snapshot;
- Anlagenstandort;
- Variantenname, exakte Revision und alle sichtbaren Kundenpreispositionen;
- Basis-/Optionssummen und vorhandene Steuersaetze;
- feste Input-, Template-, Canonicalization- und Renderer-Rezeptversion.

Nicht enthalten sind EK, Marge, Katalog-IDs, interne Vollhashes,
Telefon/Koordinaten des Kunden, Consent-/Acquisitiondaten, Rohpayloads,
Actor-IDs oder Signaturdaten. Das Input-JSON wird strikt validiert,
kanonisiert und mit SHA-256 versiegelt.

## M203A-05 · Idempotenz, Locks und Renderzustandsmaschine

Lockreihenfolge:

```text
Workspace/aktive Profilrevision → Project → Offer → aktuelle
Empfaengerrevision → Variante → Variantenrevision → Source-Draft
```

Ein Reservation-Key bindet Workspace, exakte Quellrevision, Profilrevision,
Empfaenger-/Rechnungsdaten, Bestaetigungscodes und Renderrezept. Derselbe
Aufruf liefert denselben Kandidaten und repariert bei Bedarf den Dispatch;
ein fachlich anderer Stand erzeugt eine neue Candidate-ID. Parallelaufrufe
erzeugen nie zwei gleiche Kandidaten.

```text
missing -- prepare --> queued
queued -- claim --> running
running -- success --> ready_for_approval
running -- retryable failure --> retry_wait -- due --> running
running -- final/integrity failure --> failed_final
```

Es gelten drei Versuche, DB-Zeit, Lease/CAS, begrenzter Backoff und
Nichtdeterminismus als finaler Integritaetsvorfall. Der pg-boss-Payload
enthaelt als `offer-release-candidate-dispatch.v1` nur Schema-Version,
Workspace-ID und Candidate-ID.

## M203A-06 · Abschlussfreigabe ueber echte Bytes

Nur `ready_for_approval` kann freigegeben werden. Die Server Action nimmt
Candidate-ID sowie exakt vier feste Bestaetigungen entgegen:

```text
recipient_billing_reviewed
commercial_content_reviewed
active_profile_reviewed
not_issued_status_understood
```

Bei mindestens einer 0-Prozent-Zeile ist zusaetzlich
`zero_tax_treatment_reviewed` erforderlich; ohne 0-Prozent-Zeile muss es
fehlen. Der Service sperrt Candidate, Quellen und aktives Profil erneut,
rehashiert die PDF-Bytes und speichert eine einmalige append-only Approval-
Attestation. Sie bindet Candidate-, Input-, Artifact-, Varianten-, Profil- und
Empfaengerhash sowie Template-/Renderer-Rezept. Danach ist der abgeleitete
Status `approved_not_issued`. Geaenderte oder ueberholte Quellen blockieren;
ein neuer Candidate braucht eine neue Freigabe.
M2-03a erlaubt vorlaeufig Selbstfreigabe, weil die Attestation keine
Ausstellung oder Rechtswirkung erzeugt. Eine verpflichtende Vier-Augen-Regel
bleibt eine ausdrueckliche Produktentscheidung fuer den Issuance-Slice.

## M203A-07 · PDF-Informationsarchitektur

1. Eigene WMEE-Wortmarke, Angebotsnummer und auf jeder Seite der Status
   `nicht ausgestellt · nicht versendet`.
2. Ausstellerblock mit dem exakt versionierten Firmenstand.
3. Empfaenger und Rechnungsadresse getrennt vom Anlagenstandort.
4. Variantenname, Revision, Vorbereitungs- und Gueltigkeitsdatum.
5. Leistungsumfang mit sichtbaren Positionen, Mengen, Preisen, Rabatt,
   Steuer und arithmetisch geschlossenen Summen.
6. Optionale Leistungen als eigener, nicht in der Basissumme enthaltener Block.
7. Angebotsbedingungen, Widerrufs- und Datenschutzhinweis aus dem reviewed
   Profilstand.
8. Dokumentfuss mit Profilrevision, Variantenrevision und wiederholtem Status.

Das Template ist reine escaped HTML-Erzeugung ohne externe Ressourcen.
Chromium rendert offline, sandboxed und unter dem gepinnten Rezept aus ADR
0010/0011. Das PDF wird mit Tagged-PDF-Option erzeugt, ist A4, mehrseitig
belastbar und hoechstens 8 MiB. Die lokale Strukturpruefung ist kein formaler
PDF/UA-Konformitaetsnachweis.

## M203A-08 · Speicherung, Lesen und Erasure

- Profilrevisionen, Empfaengerrevisionen, Candidate-Input, Bindungen und
  Approval-Attestations sind nach Insert unveraenderlich.
- Artefaktfelder werden nur atomar bei `running → ready` gesetzt und sind
  danach unveraenderlich.
- Postgres-Staging ist erasure-faehig und kaskadiert mit dem Offer.
- Der Erasure-Tombstone fuehrt Candidate-IDs kanonisch sortiert; alte
  Tombstones bleiben replaybar.
- Events/Audit enthalten nur IDs, Revisionen, Status, Action und sichere
  Fehlercodes, niemals Adressen, Rechtstexte, Preise, Bytes oder Vollhashes.
- Interner Download erfordert bei jedem GET Session, Membership, Tenantbesitz
  sowie erneute MIME-/Groessen-/SHA-Pruefung. Vor der Abschlussfreigabe ist er
  nur mit `offer.release.approve` sichtbar; danach reicht internes
  `project.read`.
- Antwort bleibt `private, no-store`, `nosniff`, `no-referrer`, CSP sandbox.

## Berechtigungen

| Faehigkeit | Viewer | Editor | Admin | External |
|---|---:|---:|---:|---:|
| Profilstaende lesen | ja | ja | ja | nein |
| Dokumentprofilrevision erstellen | nein | nein | `settings.manage` | nein |
| Candidate-Status lesen | ja | ja | ja | nein |
| unfreigegebene Candidate-Bytes laden | nein | mit `approve_offer_documents` | ja | nein |
| freigegebene Candidate-Bytes laden | ja | ja | ja | nein |
| Candidate vorbereiten | nein | mit `prepare_offer_documents` | ja | nein |
| fertige Candidate-Bytes freigeben | nein | mit `approve_offer_documents` | ja | nein |
| Candidate claimen/finalisieren | nein | nein | nein | `app_worker` |

`offer.release.prepare` und `offer.release.approve` sind eigene Actions. Ein
Admin umgeht wie im bestehenden Modell positive Einzel-Capabilities, nicht
aber `external_only`, Tenant-, Profil-, Byte- oder Fachinvarianten.

## Datenbank-Invarianten

- jede Tenantrelation besitzt `UNIQUE(workspace_id,id)`, Workspace-FK,
  zusammengesetzte Tenant-FKs, ENABLE/FORCE RLS und genau eine permissive
  `tenant_isolation`-Policy;
- Profil- und Empfaengerrevisionen sind in ihrem Scope eindeutig und
  append-only; die Profilaktivierung bindet den exakten Profilhash;
- Profil- und Candidate-Snapshots stimmen in IDs, Revisionen, Versionen und
  SHA mit ihren relationalen Spalten ueberein;
- Candidate-Quellbindung umfasst Project, Offer, Variante,
  Variantenrevision-ID/-Nummer/-SHA und Dokumentprofil-ID/-Revision/-SHA;
- Publication-State ist ausschliesslich `not_issued`; Approval ist eine
  getrennte append-only Relation und erzeugt keinen Issuance-Status;
- State-/Lease-/Fehler-/Artefaktspalten bilden genau die Zustandsmaschine ab;
- gespeicherter Artifact-SHA entspricht den gespeicherten PDF-Bytes;
- `app_runtime` erhaelt nur notwendige Read-/Insert-Replay-Spalten,
  `app_worker` nur Claim-/Retry-/Finalize-Spalten; keine breite Tabellenmacht;
- erfolgreiche Artefakte, Input und Bindungen koennen weder durch Runtime
  noch Worker nachtraeglich ersetzt werden.

## Geschlossene Testmatrix

| ID | Ebene | Muss beweisen | Aktueller Beleg |
|---|---|---|---|
| M203A-CONTRACT-01 | Contract/Golden | strikte Profil-/Recipient-/Inputschemas, Normalisierung, Canonical Hash, Unknown reject | GREEN im finalen Gesamtlauf |
| M203A-HIDDEN-01 | Contract/Service | jede Hidden-Zeile blockiert ohne Summenmanipulation | GREEN im finalen Gesamtlauf |
| M203A-DB-01 | Migration/RLS | fresh+upgrade, Tenant-FKs, FORCE RLS, eine Policy, Immutability, genaue Rollen-ACL | GREEN; Rollenvertrag 88/88 plus PG18 5/5 |
| M203A-DB-02 | Concurrency | Profilrevision-, Prepare-, Replay-, Lease- und Finalize-Races | GREEN im finalen Gesamtlauf |
| M203A-SVC-01 | Integration | exakte Revision/Profil/Billing/Approvals → Event/Audit; stale/missing/review-denial | GREEN im finalen Gesamtlauf |
| M203A-APPROVAL-01 | Integration | nur hashvalide echte Bytes; Replay/Race/stale/cross-tenant; einmalige Attestation | GREEN; `approved_not_issued` bleibt abgeleitet |
| M203A-PRIVACY-01 | Adversarial | keine PII/Rechtstexte/Preise/Bytes/Vollhashes in DTO/Event/Audit/Log | GREEN im finalen Gesamtlauf |
| M203A-WORKER-01 | Unit/Integration | ID-only Payload, DB reload, offline Render, Retry, deterministischer Hash | GREEN im finalen Gesamtlauf |
| M203A-TEMPLATE-01 | Unit/Golden | escaping, Status je Seite, Profil/Billing/Site/Leistung/Rechtstexte/Summen | GREEN; Pflichtstatus auf 11/11 Container-PDF-Seiten |
| M203A-RBAC-01 | Integration | Viewer/Editor+Capability/Admin/External/Cross-Tenant ohne Oracle | GREEN; Security-Review GO ohne offene P0–P2 |
| M203A-ROUTE-01 | Route | Promise-Params, Reauth, private Header, Hash/Laenge, sicherer Dateiname | GREEN im finalen Gesamtlauf |
| M203A-E2E-01 | Browser | Admin-Profil → Offer-Freigabe → Worker → Reload → exakte PDF-Bytes | GREEN; Claim/Finalize im Browserfall synthetisch in der DB, exakte Bytes geprueft |
| M203A-A11Y-01 | Browser | Label, Fehlerzusammenfassung, Status-live-region, Keyboard, 200/400-% Reflow | GREEN; Navigation- und Opus-Max-Review GO ohne offene P0–P2 |
| M203A-RENDER-01 | Chromium/Container | echtes gepinntes `linux/amd64`-Rendering, Determinismus, A4 und Pflichtstatus auf jeder Seite | GREEN; 2 Render, 11/11 A4-Seiten und Status auf 11/11 Seiten |
| M203A-VISUAL-01 | Human Visual | menschlich freigegebene Portal- und gerasterte PDF-Baseline | `INCONCLUSIVE` |

## Lokaler Implementierungs- und Verifikationsnachweis

- 111/111 Vitest-Dateien: 1.078 Tests bestanden, 1 Test uebersprungen;
- voller Chromium-Lauf: 17 bestanden, 1 opt-in uebersprungen, 0
  fehlgeschlagen;
- Typecheck, ESLint, Production-Build und Dependency-Cruiser gruen; letzterer
  pruefte 237 Module und 764 Abhaengigkeiten;
- DB-Rollenvertrag 88/88 sowie PostgreSQL-18-Nachweis 5/5 gruen;
- gepinnter `linux/amd64`-Container: zwei deterministische Render, 103.871
  Bytes, SHA-256
  `c3ea9de557e66eb2975cc19fc858f6e5b0c3127f058046ec750158b2bc76ac1b`,
  11/11 A4-Seiten und Pflichtstatus auf 11/11 Seiten;
- Security-, Regression- und unabhaengiger Navigation-Review: GO;
- finaler lokaler Claude-Code-Lesereview mit Modellalias `opus` und Effort
  `max`: GO, keine offenen P0–P2 nach der Accessibility-Nacharbeit.

Der Browser-E2E synthetisiert Claim und Finalize in der Datenbank und beweist
den geschuetzten UI-/Action-/Downloadpfad gegen exakt erwartete Bytes. Der
echte Renderer wird dadurch nicht behauptet; sein separater Beleg ist der
gepinnte Containerlauf `M203A-RENDER-01`.

Die technische Abnahme behauptet keine Reonic-1:1-Paritaet, keine
Rechtswirksamkeit und keine menschliche Designfreigabe. Human Visual bleibt
`INCONCLUSIVE`; produktiver Deploy, Object Lock/WORM, Ausstellung, Delivery,
Versand, Annahme und Signatur wurden nicht ausgefuehrt.

## Getrennte Abnahmegates

Technische Implementierung und lokale Verifikation sind nach der bereits
erteilten Gate-1-/Gate-2-Freigabe abgeschlossen und das lokale technische Gate
ist GO. Getrennt bleiben:

- echte WMEE-Firmen-/Rechtstexte: fehlen, muessen fachlich/juristisch geliefert
  und verantwortet werden;
- visuelle menschliche PDF-Baseline: bis Freigabe `INCONCLUSIVE`;
- Object-Lock/Issuance: M2-03b, bis Kauf/Provisionierung/Readback `BLOCKED`;
- M2-03b erzeugt eigene Ausstellungsbytes; die Candidate-Bytes bleiben
  unveraendert historisch `nicht ausgestellt`;
- Versand/Signatur/Won/Installation: spaetere Slices;
- Produktionsdeploy und externe Anbieteraktionen: `NOT RUN` und weiterhin
  ausdruecklich separat freigabepflichtig.
